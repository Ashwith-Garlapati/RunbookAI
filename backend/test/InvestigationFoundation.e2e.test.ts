/**
 * Investigation foundation end-to-end (mocked externals, no live credentials).
 *
 * Exercises the wired pipeline on one realistic incident — "Checkout API
 * returning 500s" — through every implemented layer:
 *   Incident → Investigation Session → Slack + GitHub collection →
 *   Common Evidence Store → NLP enrichment → Investigation Context.
 * RAG / engine / Jev do not exist yet and are not touched here.
 */

import { describe, it, expect } from "vitest";

import { IncidentBus } from "../domains/incident/IncidentBus.js";
import { IncidentCoordinator } from "../domains/incident/IncidentCoordinator.js";
import type { IIncidentRepository } from "../domains/incident/IncidentRepository.js";
import { MembershipLevel } from "../domains/incident/IncidentRoles.js";
import { IncidentSeverity } from "../domains/incident/IncidentSeverity.js";
import type { Incident } from "../domains/incident/Incident.js";
import { InvestigationService } from "../domains/investigation/InvestigationService.js";
import type { IInvestigationRepository } from "../domains/investigation/InvestigationRepository.js";
import type { Investigation } from "../domains/investigation/Investigation.js";
import { TimelineService } from "../domains/investigation/TimelineService.js";
import { Trigger } from "../domains/investigation/Trigger.js";
import { TriggerSource } from "../domains/investigation/TriggerSource.js";
import { TriggerType } from "../domains/investigation/TriggerType.js";
import { EvidenceSource } from "../domains/investigation/EvidenceSource.js";
import type { EvidenceItem } from "../domains/investigation/EvidenceItem.js";
import type { IEvidenceRepository } from "../domains/investigation/RepositoryInterfaces.js";
import { SlackEvidenceCollector } from "../services/slackEvidenceCollector.js";
import type { SlackHistoryClient, SlackRawMessage } from "../services/slackEvidence.js";
import { CommonEvidenceStore } from "../services/commonEvidenceStore.js";
import { GitHubConnector, type GitHubApi } from "../services/githubConnector.js";
import { collectGitHubEvidence } from "../services/githubInvestigationFlow.js";
import { GitHubEvidenceStore } from "../services/githubEvidenceStore.js";
import { EvidenceEnrichmentService } from "../services/evidenceEnrichment.js";
import { InvestigationContextBuilder } from "../services/investigationContext.js";

const TEAM = "T1";
const CHANNEL = "C-inc-142";
const REPO = "company/payments-service";

// ---------------------------------------------------------------------------
// Fakes (in-memory; no Mongo, no Slack, no GitHub credentials)
// ---------------------------------------------------------------------------

function incidentRepo(): IIncidentRepository & { incidents: Map<string, Incident> } {
  const incidents = new Map<string, Incident>();
  return {
    incidents,
    create: async (i) => {
      incidents.set(i.id, i);
      return i;
    },
    update: async (i) => {
      incidents.set(i.id, i);
      return i;
    },
    findById: async (id) => incidents.get(id) ?? null,
    findByTeamAndChannel: async (teamId, channelId) => {
      for (const i of incidents.values()) {
        if (i.teamId === teamId && i.channelId === channelId) return i;
      }
      return null;
    },
    findByIdempotencyKey: async () => null,
    findOpenByTeam: async () => [],
    listByTeam: async () => [],
  };
}

const idempotency = { claim: async () => true, release: async () => {} };
const membership = { resolveLevel: async () => MembershipLevel.Commander };
const eventBus = {
  publish: async () => {},
  subscribe: () => {},
  unsubscribe: () => {},
};

function investigationRepo(): IInvestigationRepository & { items: Map<string, Investigation> } {
  const items = new Map<string, Investigation>();
  const all = () => [...items.values()];
  return {
    items,
    create: async (i) => {
      items.set(i.id, i);
      return i;
    },
    update: async (i) => {
      items.set(i.id, i);
      return i;
    },
    findById: async (id) => items.get(id) ?? null,
    findByStatus: async () => [],
    findActive: async () => all(),
    findBySlackChannel: async () => [],
    findReusableBySlackThread: async () => [],
    findReusableBySlackChannel: async () => [],
    findByReusableSlackUser: async () => [],
    findCompleted: async () => [],
    delete: async (id) => {
      items.delete(id);
    },
  };
}

function evidenceRepo(): IEvidenceRepository & { docs: EvidenceItem[] } {
  const docs: EvidenceItem[] = [];
  return {
    docs,
    create: async (e) => {
      docs.push(e);
    },
    update: async (e) => {
      const index = docs.findIndex((d) => d.id === e.id);
      if (index >= 0) docs[index] = e;
      else docs.push(e);
      return true;
    },
    findById: async (id) => docs.find((d) => d.id === id) ?? null,
    findByInvestigationId: async (id) => docs.filter((d) => d.investigationId === id),
  };
}

function msg(ts: string, text: string, extra?: Partial<SlackRawMessage>): SlackRawMessage {
  return { ts, user: "U1", text, ...extra };
}

/** Dedicated incident channel history across two pages, with two threads. */
const PAGE_ONE: SlackRawMessage[] = [
  msg("5.000100", "Rollback completed."),
  { ...msg("4.000100", "Rolling back deploy 841."), reply_count: 1 },
  msg("3.000100", "Deploy 841 may be related."),
];
const PAGE_TWO: SlackRawMessage[] = [
  { ...msg("2.000100", "We are seeing HTTP 500s."), reply_count: 1 },
  msg("1.000100", "Checkout API latency is increasing."),
];
const THREADS: Record<string, SlackRawMessage[]> = {
  "4.000100": [msg("4.000200", "Error rate is dropping.", { thread_ts: "4.000100" })],
  "2.000100": [msg("2.000200", "Auth service appears to be timing out.", { thread_ts: "2.000100" })],
};

function slackClient(threadFailures: string[] = []): SlackHistoryClient & { seenChannels: string[] } {
  const seenChannels: string[] = [];
  const pages = [PAGE_ONE, PAGE_TWO];
  return {
    seenChannels,
    conversations: {
      history: async ({ channel, cursor }: { channel: string; cursor?: string }) => {
        seenChannels.push(channel);
        const index = cursor ? Number(cursor) : 0;
        const page = pages[index] ?? [];
        return {
          messages: page,
          ...(index + 1 < pages.length ? { response_metadata: { next_cursor: String(index + 1) } } : {}),
        };
      },
      replies: async ({ ts }: { ts: string }) => {
        if (threadFailures.includes(ts)) throw { data: { error: "channel_not_found" } };
        const parent = pages.flat().find((m) => m.ts === ts);
        const replies = THREADS[ts] ?? [];
        return { messages: [...(parent ? [parent] : []), ...replies] };
      },
    },
    chat: {
      getPermalink: async ({ channel, message_ts }: { channel: string; message_ts: string }) => ({
        permalink: `https://workspace.slack.com/archives/${channel}/p${message_ts.replace(".", "")}`,
      }),
    },
  };
}

function commitPayload(sha: string, message = "fix: checkout auth"): Record<string, unknown> {
  return {
    sha,
    html_url: `https://github.com/${REPO}/commit/${sha}`,
    commit: {
      message,
      author: { name: "dev", email: "dev@x.test", date: "2026-09-30T14:21:00Z" },
      committer: { name: "dev", email: "dev@x.test", date: "2026-09-30T14:21:00Z" },
    },
    author: { login: "dev" },
    parents: [{ sha: "parent1" }],
  };
}

function prPayload(n: number): Record<string, unknown> {
  return {
    number: n,
    title: "Fix checkout auth timeout",
    body: "fixes HTTP 500s on /checkout",
    user: { login: "dev" },
    state: "closed",
    draft: false,
    head: { ref: "fix/checkout-auth" },
    base: { ref: "main" },
    created_at: "2026-09-30T14:00:00Z",
    updated_at: "2026-09-30T14:22:00Z",
    closed_at: "2026-09-30T14:22:00Z",
    merged_at: "2026-09-30T14:21:00Z",
    merge_commit_sha: "abc1234",
    html_url: `https://github.com/${REPO}/pull/${n}`,
  };
}

function githubApi(): GitHubApi {
  return {
    repos: {
      get: async () => ({
        data: {
          id: 7,
          default_branch: "main",
          description: "payments service",
          language: "TypeScript",
          html_url: `https://github.com/${REPO}`,
          private: true,
          archived: false,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-09-30T14:00:00Z",
        },
      }),
      getContent: async ({ path }: { path: string }) => ({
        data: {
          type: "file",
          encoding: "base64",
          size: 48,
          sha: "filesha",
          html_url: `https://github.com/${REPO}/blob/main/${path}`,
          content: Buffer.from("export async function validateToken() { return true; }").toString("base64"),
        },
      }),
      listCommits: async () => ({ data: [commitPayload("abc1234")] }),
      getCommit: async () => ({ data: { ...commitPayload("abc1234"), files: [] } }),
      compareCommits: async () => ({ data: { files: [] } }),
    },
    git: {
      getTree: async () => ({
        data: {
          sha: "treesha",
          truncated: false,
          tree: [
            { path: "src", type: "tree", sha: "t1" },
            { path: "src/auth/validateToken.ts", type: "blob", sha: "b1", size: 100 },
            { path: "src/checkout/handler.ts", type: "blob", sha: "b2", size: 200 },
          ],
        },
      }),
    },
    pulls: {
      list: async () => ({ data: [prPayload(482)] }),
      get: async () => ({ data: prPayload(482) }),
      listCommits: async () => ({ data: [commitPayload("abc1234")] }),
      listFiles: async () => ({
        data: [
          {
            filename: "src/auth/validateToken.ts",
            status: "modified",
            additions: 10,
            deletions: 2,
            changes: 12,
            sha: "f1",
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ],
      }),
      listReviews: async () => ({
        data: [{ user: { login: "rev" }, state: "APPROVED", submitted_at: "2026-09-30T14:20:00Z", html_url: "http://x" }],
      }),
      listReviewComments: async () => ({ data: [] }),
    },
    issues: {
      listComments: async () => ({
        data: [{ user: { login: "dev" }, body: "lgtm", created_at: "2026-09-30T14:19:00Z", html_url: "http://y" }],
      }),
    },
    checks: {
      listForRef: async () => ({
        data: { check_runs: [{ name: "ci", status: "completed", conclusion: "success", html_url: "http://z" }] },
      }),
    },
  };
}

const GH_CONTEXT = {
  repository: REPO,
  incidentStart: "2026-09-30T14:00:00Z",
  incidentEnd: "2026-09-30T15:00:00Z",
  service: "payments-service",
  endpoint: "/checkout",
  errorTerms: ["500", "timeout"],
  mentionedFiles: [] as string[],
  mentionedFunctions: [] as string[],
};

/** Fresh, isolated world per test. */
async function buildWorld() {
  const incidents = incidentRepo();
  const coordinator = new IncidentCoordinator(incidents, new IncidentBus(), idempotency, membership);
  const incident = await coordinator.declare({
    teamId: TEAM,
    title: "Checkout API returning 500s",
    description: "Checkout API latency is increasing",
    affectedService: "payments-service",
    severity: IncidentSeverity.Major,
    reporterId: "U1",
    correlationId: "e2e-1",
  });
  await coordinator.attachChannel({ teamId: TEAM, actor: "U1", correlationId: "e2e-1" }, incident.id, CHANNEL, "inc-checkout-142", null);

  const investigations = investigationRepo();
  const service = new InvestigationService(investigations, eventBus, new TimelineService());
  const trigger = Trigger.create({
    source: TriggerSource.Slack,
    type: TriggerType.Mention,
    actor: "U1",
    payload: { channel: CHANNEL },
  });
  const investigation = await service.createInvestigation({
    title: "Checkout API returning 500s",
    description: "Checkout API latency is increasing",
    severity: "major",
    trigger,
    createdBy: "U1",
  });

  const evidence = evidenceRepo();
  const slackCollector = new SlackEvidenceCollector({ clients: { forTeam: async () => slackClient() as never } });
  const slackStore = new CommonEvidenceStore(evidence);
  const connector = new GitHubConnector(githubApi());
  const githubStore = new GitHubEvidenceStore(evidence);
  const enricher = new EvidenceEnrichmentService();
  const contexts = new InvestigationContextBuilder(coordinator, evidence);
  return { coordinator, incident, service, investigation, evidence, slackCollector, slackStore, connector, githubStore, enricher, contexts };
}

// ---------------------------------------------------------------------------

describe("investigation foundation end-to-end", () => {
  it("opens an investigation session on the incident", async () => {
    const { service, investigation, incident } = await buildWorld();
    expect(investigation.id).toBeTruthy();
    expect(incident.channelId).toBe(CHANNEL);
    await service.attachEvidence(investigation.id, "ev-seed" as never);
    await service.attachEvidence(investigation.id, "ev-seed-2" as never);
    expect(investigation.evidenceIds).toHaveLength(2);
  });

  it("collects the complete dedicated channel: history, pagination, all thread replies", async () => {
    const { slackCollector, investigation } = await buildWorld();
    const client = slackClient();
    const { items, status } = await slackCollector.collectChannelHistory({
      teamId: TEAM,
      channelId: CHANNEL,
      investigationId: investigation.id,
      incidentId: "inc-1",
      client,
    });
    expect(status.status).toBe("COMPLETE");
    expect(status.collectedCount).toBe(7);
    expect(items).toHaveLength(7);
    // Only the incident channel was queried (both history pages).
    expect(client.seenChannels).toEqual([CHANNEL, CHANNEL]);
    // Thread replies carry thread provenance; parents do not.
    const replies = items.filter((i) => i.type === "THREAD_MESSAGE");
    expect(replies).toHaveLength(2);
    expect(replies.every((r) => (r.provenance?.["threadTs"] as string | null) !== null)).toBe(true);
    // Every item has a permalink and full provenance.
    for (const item of items) {
      expect(item.provenance?.["channelId"]).toBe(CHANNEL);
      expect(item.provenance?.["permalink"] as string | null).toMatch(/^https:\/\//);
    }
    const texts = items.map((i) => i.content);
    for (const expected of [
      "Checkout API latency is increasing.",
      "We are seeing HTTP 500s.",
      "Auth service appears to be timing out.",
      "Deploy 841 may be related.",
      "Rolling back deploy 841.",
      "Error rate is dropping.",
      "Rollback completed.",
    ]) {
      expect(texts).toContain(expected);
    }
  });

  it("ingests live messages and replies, and skips duplicate deliveries", async () => {
    const { slackCollector, slackStore, investigation } = await buildWorld();
    const client = slackClient();
    const parent = await slackCollector.ingestLiveMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      message: { ts: "9.000100", user: "U2", text: "Restarting the checkout pods." },
      investigationId: investigation.id,
      client,
    });
    const reply = await slackCollector.ingestLiveMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      message: { ts: "9.000200", user: "U1", text: "Pods are back.", thread_ts: "9.000100" },
      investigationId: investigation.id,
      client,
    });
    expect(parent?.type).toBe("MESSAGE");
    expect(reply?.type).toBe("THREAD_MESSAGE");
    const first = await slackStore.saveAll(investigation.id, [parent as EvidenceItem, reply as EvidenceItem]);
    expect(first).toEqual({ stored: 2, skipped: 0 });
    const retry = await slackStore.saveAll(investigation.id, [parent as EvidenceItem, reply as EvidenceItem]);
    expect(retry).toEqual({ stored: 0, skipped: 2 });
  });

  it("reports partial collection when a thread fails", async () => {
    const { slackCollector, investigation } = await buildWorld();
    const client = slackClient(["4.000100"]);
    const { items, status } = await slackCollector.collectChannelHistory({
      teamId: TEAM,
      channelId: CHANNEL,
      investigationId: investigation.id,
      client,
    });
    expect(status.status).toBe("PARTIAL");
    expect(status.failedThreads).toEqual(["4.000100"]);
    expect(status.errors.length).toBeGreaterThan(0);
    // Good evidence is preserved despite the failed thread.
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.content === "Rollback completed.")).toBe(true);
  });

  it("retrieves GitHub evidence across every surface with provenance", async () => {
    const { connector } = await buildWorld();
    const { records, candidates } = await collectGitHubEvidence(connector, GH_CONTEXT, {
      branch: "main",
      maxRelevantFiles: 2,
      includeValidation: true,
    });
    const types = records.map((r) => r.type);
    for (const expected of [
      "github.repo_metadata",
      "github.commit",
      "github.pull_request",
      "github.pr_commit",
      "github.pr_file",
      "github.file",
      "github.check",
      "github.review",
      "github.comment",
    ]) {
      expect(types).toContain(expected);
    }
    // Diffs resolve through the connector on the same mock.
    const diff = await connector.getPullRequestDiff({ owner: "company", repo: "payments-service" }, 482);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.patch).toContain("-old");
    // File contents resolve for ranked candidates.
    expect(candidates.length).toBeGreaterThan(0);
    // Every record carries provenance back to the GitHub object.
    for (const record of records) {
      expect(record.provenance.repository).toBe(REPO);
      expect(record.source).toBe("GITHUB");
      expect(record.sourceId).toBeTruthy();
    }
    const pr = records.find((r) => r.type === "github.pull_request");
    expect(pr?.provenance.prNumber).toBe(482);
    const commit = records.find((r) => r.type === "github.commit");
    expect(commit?.provenance.commitSha).toBe("abc1234");
    const file = records.find((r) => r.type === "github.pr_file");
    expect(file?.provenance.filePath).toBe("src/auth/validateToken.ts");
  });

  it("runs the full pipeline: store, enrich, context — then reruns without duplication", async () => {
    const w = await buildWorld();
    const invId = w.investigation.id;

    // Slack history → store.
    const client = slackClient();
    const collected = await w.slackCollector.collectChannelHistory({
      teamId: TEAM,
      channelId: CHANNEL,
      investigationId: invId,
      incidentId: w.incident.id,
      client,
    });
    const slackSaved = await w.slackStore.saveAll(invId, collected.items);
    expect(slackSaved).toEqual({ stored: 7, skipped: 0 });

    // Live traffic → store.
    const live = await w.slackCollector.ingestLiveMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      message: { ts: "9.000100", user: "U2", text: "Restarting the checkout pods." },
      investigationId: invId,
      client,
    });
    const liveReply = await w.slackCollector.ingestLiveMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      message: { ts: "9.000200", user: "U1", text: "Pods are back.", thread_ts: "9.000100" },
      investigationId: invId,
      client,
    });
    await w.slackStore.saveAll(invId, [live as EvidenceItem, liveReply as EvidenceItem]);

    // GitHub → store.
    const { records } = await collectGitHubEvidence(w.connector, GH_CONTEXT, {
      branch: "main",
      maxRelevantFiles: 2,
      includeValidation: true,
    });
    const githubSaved = await w.githubStore.saveAll(invId, records);
    // Commit abc1234 arrives twice (recent-commits + PR-commits) with one
    // stable sourceId, so the store correctly keeps a single copy.
    expect(githubSaved.stored + githubSaved.skipped).toBe(records.length);
    expect(githubSaved.skipped).toBe(1);
    const githubCount = githubSaved.stored;

    // Session linkage.
    for (const item of await w.evidence.findByInvestigationId(invId)) {
      await w.service.attachEvidence(invId, item.id as never);
    }

    // NLP enrichment across the investigation.
    const enriched = await w.enricher.enrichInvestigation(w.evidence, invId);
    expect(enriched.failed).toBe(0);
    expect(enriched.enriched).toBe(9 + githubCount);

    const stored = await w.evidence.findByInvestigationId(invId);
    const withNlp = stored.filter((d) => d.enrichment);
    expect(withNlp).toHaveLength(9 + githubCount);
    // Enrichment signals on the realistic incident text.
    const signals = withNlp.flatMap((d) => [
      ...(d.enrichment?.services ?? []),
      ...(d.enrichment?.errors.map((e) => e.value) ?? []),
      ...(d.enrichment?.events.map((e) => e.type) ?? []),
    ]);
    expect(signals).toEqual(
      expect.arrayContaining(["HTTP 500", "timeout", "DEPLOYMENT", "ROLLBACK"]),
    );
    // Provenance survived enrichment untouched.
    const slackOne = stored.find((d) => d.source === EvidenceSource.Slack && d.type === "MESSAGE");
    expect(slackOne?.provenance?.["channelId"]).toBe(CHANNEL);
    // NEVER a causal claim anywhere in enrichment output.
    const blob = JSON.stringify(stored.map((d) => d.enrichment));
    expect(blob).not.toMatch(/\bcaused?\b|\bcauses\b|\bcausing\b|\bcausal\b/i);
    for (const d of stored) {
      for (const rel of d.enrichment?.relationships ?? []) {
        expect(["PRECEDES", "ASSOCIATED_WITH_REDUCTION_IN", "MODIFIES", "AUTHORED_BY", "MENTIONS"]).toContain(
          (rel as { relation: string }).relation,
        );
      }
    }

    // Investigation context over everything.
    const context = await w.contexts.buildForIncident({ teamId: TEAM, incidentId: w.incident.id, investigationId: invId });
    expect(context.incidentId).toBe(w.incident.id);
    expect(context.investigationId).toBe(invId);
    expect(context.availableSources).toEqual(expect.arrayContaining(["slack", "github"]));
    expect(context.evidenceSummary).toEqual({ slackCount: 9, githubCount, totalCount: 9 + githubCount });
    expect(context.slackEvidence).toHaveLength(9);
    expect(context.githubEvidence).toHaveLength(githubCount);
    // Complete Slack evidence preserved (parents before their replies).
    const order = context.slackEvidence.map((e) => e.sourceId);
    expect(order.indexOf(`slack:${TEAM}:${CHANNEL}:4.000100`)).toBeLessThan(
      order.indexOf(`slack:${TEAM}:${CHANNEL}:4.000100:4.000200`),
    );
    const times = context.slackEvidence.map((e) => e.occurredAt ?? "");
    expect([...times].sort()).toEqual(times);
    expect(context.repositories).toContain(REPO);
    expect(context.participants).toEqual(expect.arrayContaining(["U1", "U2"]));

    // Rerun everything: zero new documents, enrichment still present.
    const before = (await w.evidence.findByInvestigationId(invId)).length;
    const recollected = await w.slackCollector.collectChannelHistory({
      teamId: TEAM,
      channelId: CHANNEL,
      investigationId: invId,
      incidentId: w.incident.id,
      client: slackClient(),
    });
    const resaved = await w.slackStore.saveAll(invId, recollected.items);
    expect(resaved).toEqual({ stored: 0, skipped: 7 });
    const { records: records2 } = await collectGitHubEvidence(w.connector, GH_CONTEXT, {
      branch: "main",
      maxRelevantFiles: 2,
      includeValidation: true,
    });
    // Fresh store instances (no shared dedupe memory) still skip everything.
    const freshGithub = await new GitHubEvidenceStore(w.evidence).saveAll(invId, records2);
    expect(freshGithub).toEqual({ stored: 0, skipped: records2.length });
    const freshCommon = await new CommonEvidenceStore(w.evidence).saveAll(invId, recollected.items);
    expect(freshCommon).toEqual({ stored: 0, skipped: 7 });
    const after = await w.evidence.findByInvestigationId(invId);
    expect(after).toHaveLength(before);
    expect(after.every((d) => d.enrichment)).toBe(true);
  });
});
