import { describe, it, expect } from "vitest";

import { EvidenceItem } from "../domains/investigation/EvidenceItem.js";
import { EvidenceSource } from "../domains/investigation/EvidenceSource.js";
import type { IEvidenceRepository } from "../domains/investigation/RepositoryInterfaces.js";
import { CommonEvidenceStore } from "../services/commonEvidenceStore.js";
import {
  normalizeSlackMessage,
  slackParentSourceId,
  slackReplySourceId,
  slackTsToDate,
  type SlackHistoryClient,
  type SlackRawMessage,
} from "../services/slackEvidence.js";
import { SlackEvidenceCollector } from "../services/slackEvidenceCollector.js";

const TEAM = "T1";
const CHANNEL = "C-inc-142";

function msg(ts: string, text: string, extra?: Partial<SlackRawMessage>): SlackRawMessage {
  return { ts, user: "U1", text, ...extra };
}

function historyClient(opts: {
  pages: SlackRawMessage[][];
  threads?: Record<string, SlackRawMessage[]>;
  threadFailures?: string[];
  historyError?: { data?: { error?: string } };
}): SlackHistoryClient & { seenChannels: string[] } {
  const seenChannels: string[] = [];
  return {
    seenChannels,
    conversations: {
      history: async ({ channel, cursor }: { channel: string; cursor?: string }) => {
        if (opts.historyError) throw opts.historyError;
        seenChannels.push(channel);
        const index = cursor ? Number(cursor) : 0;
        const page = opts.pages[index] ?? [];
        return {
          messages: page,
          ...(index + 1 < opts.pages.length ? { response_metadata: { next_cursor: String(index + 1) } } : {}),
        };
      },
      replies: async ({ ts }: { ts: string }) => {
        if (opts.threadFailures?.includes(ts)) throw { data: { error: "channel_not_found" } };
        // Echo the parent first, like the real API.
        const parent = opts.pages.flat().find((m) => m.ts === ts);
        const replies = opts.threads?.[ts] ?? [];
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

function collectorWith(client: SlackHistoryClient): SlackEvidenceCollector {
  const clients = { forTeam: async () => client as never };
  return new SlackEvidenceCollector({ clients });
}

function memoryRepo(): IEvidenceRepository & { docs: EvidenceItem[] } {
  const docs: EvidenceItem[] = [];
  return {
    docs,
    create: async (e) => {
      docs.push(e);
    },
    findById: async () => null,
    findByInvestigationId: async (id) => docs.filter((d) => d.investigationId === id),
  };
}

describe("Slack evidence", () => {
  it("normalizes a parent message verbatim with stable sourceId + provenance", () => {
    const n = normalizeSlackMessage({ teamId: TEAM, channelId: CHANNEL, message: msg("1727000000.000100", "Checkout API latency is increasing.") });
    expect(n.type).toBe("MESSAGE");
    expect(n.sourceId).toBe(slackParentSourceId(TEAM, CHANNEL, "1727000000.000100"));
    expect(n.content).toBe("Checkout API latency is increasing.");
    expect(n.provenance).toMatchObject({ channelId: CHANNEL, messageTs: "1727000000.000100", threadTs: null, userId: "U1" });
    expect(n.occurredAt).toEqual(new Date(1727000000 * 1000));
  });

  it("normalizes a thread reply with thread provenance", () => {
    const n = normalizeSlackMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      message: msg("1727000010.000100", "Looks like authorization.", { thread_ts: "1727000005.000100" }),
    });
    expect(n.type).toBe("THREAD_MESSAGE");
    expect(n.sourceId).toBe(slackReplySourceId(TEAM, CHANNEL, "1727000005.000100", "1727000010.000100"));
    expect(n.provenance.threadTs).toBe("1727000005.000100");
  });

  it("collects the FULL incident channel (acceptance: all seven messages, no filtering)", async () => {
    const client = historyClient({
      pages: [
        [
          msg("7.000100", "Rollback completed."),
          { ...msg("4.000100", "Rolling back deployment 841."), reply_count: 2 },
          { ...msg("2.000100", "We are seeing 500s."), reply_count: 1 },
          msg("1.000100", "Checkout API latency is increasing."),
        ],
      ],
      threads: {
        "4.000100": [
          msg("5.000100", "Rollback is running.", { thread_ts: "4.000100" }),
          msg("6.000100", "Errors are dropping.", { thread_ts: "4.000100" }),
        ],
        "2.000100": [msg("3.000100", "Looks like authorization.", { thread_ts: "2.000100" })],
      },
    });
    const collector = collectorWith(client);
    const { items, status } = await collector.collectChannelHistory({ teamId: TEAM, channelId: CHANNEL, investigationId: "inv-142" });
    expect(status.status).toBe("COMPLETE");
    expect(status.collectedCount).toBe(7);
    expect(items).toHaveLength(7);
    expect(items.filter((i) => i.type === "THREAD_MESSAGE")).toHaveLength(3);
    // Parent echo from replies() must not duplicate.
    expect(new Set(items.map((i) => i.sourceId)).size).toBe(7);
    // Seemingly irrelevant messages are kept (no keyword filtering).
    expect(items.some((i) => i.content === "Rollback completed.")).toBe(true);
    // Permalinks preserved, never invented (derived from API).
    expect(items.every((i) => (i.provenance?.["permalink"] as string)?.startsWith("https://"))).toBe(true);
  });

  it("paginates until history is exhausted and only queries the incident channel", async () => {
    const client = historyClient({ pages: [[msg("2.000100", "b")], [msg("1.000100", "a")]] });
    const collector = collectorWith(client);
    const { items, status } = await collector.collectChannelHistory({
      teamId: TEAM,
      channelId: CHANNEL,
      investigationId: "inv-1",
      includePermalinks: false,
      client,
    });
    expect(status.status).toBe("COMPLETE");
    expect(items).toHaveLength(2);
    expect(client.seenChannels.every((c) => c === CHANNEL)).toBe(true);
  });

  it("resolves permalinks with bounded concurrency", async () => {
    const parents = Array.from({ length: 12 }, (_, i) => msg(`${i + 1}.000100`, `message ${i + 1}`));
    const base = historyClient({ pages: [parents] });
    let active = 0;
    let maxActive = 0;
    const client: SlackHistoryClient = {
      ...base,
      chat: {
        getPermalink: async ({ channel, message_ts }: { channel: string; message_ts: string }) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
          return { permalink: `https://workspace.slack.com/archives/${channel}/p${message_ts.replace(".", "")}` };
        },
      },
    };
    const collector = collectorWith(client);
    const { items, status } = await collector.collectChannelHistory({
      teamId: TEAM,
      channelId: CHANNEL,
      investigationId: "inv-1",
      client,
    });
    expect(status.status).toBe("COMPLETE");
    expect(items).toHaveLength(12);
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(maxActive).toBeGreaterThan(1);
    expect(items.every((i) => typeof i.provenance?.["permalink"] === "string")).toBe(true);
  });

  it("reports permalink failures without losing evidence", async () => {
    const base = historyClient({
      pages: [[msg("4.000100", "d"), msg("3.000100", "c"), msg("2.000100", "b"), msg("1.000100", "a")]],
    });
    const client: SlackHistoryClient = {
      ...base,
      chat: {
        getPermalink: async ({ channel, message_ts }: { channel: string; message_ts: string }) => {
          if (message_ts === "2.000100" || message_ts === "3.000100") throw { data: { error: "ratelimited" } };
          return { permalink: `https://workspace.slack.com/archives/${channel}/p${message_ts.replace(".", "")}` };
        },
      },
    };
    const collector = collectorWith(client);
    const { items, status } = await collector.collectChannelHistory({
      teamId: TEAM,
      channelId: CHANNEL,
      investigationId: "inv-1",
      client,
    });
    expect(status.status).toBe("COMPLETE");
    expect(items).toHaveLength(4);
    expect(status.errors).toHaveLength(1);
    expect(status.errors[0]).toMatch(/2 permalink lookup\(s\) failed/);
    const withoutLinks = items.filter((i) => i.provenance?.["permalink"] == null);
    expect(withoutLinks).toHaveLength(2);
  });

  it("reports PARTIAL with failed threads identified, keeping good evidence", async () => {
    const client = historyClient({
      pages: [[{ ...msg("2.000100", "parent ok"), reply_count: 1 }, { ...msg("1.000100", "doomed"), reply_count: 1 }]],
      threads: { "2.000100": [msg("3.000100", "reply ok", { thread_ts: "2.000100" })] },
      threadFailures: ["1.000100"],
    });
    const collector = collectorWith(client);
    const { items, status } = await collector.collectChannelHistory({
      teamId: TEAM,
      channelId: CHANNEL,
      investigationId: "inv-1",
      includePermalinks: false,
      client,
    });
    expect(status.status).toBe("PARTIAL");
    expect(status.failedThreads).toEqual(["1.000100"]);
    expect(status.errors).toHaveLength(1);
    expect(items.length).toBeGreaterThanOrEqual(3);
  });

  it("maps history failures to stable codes (never empty-success)", async () => {
    const cases: Array<[{ data?: { error?: string } }, string]> = [
      [{ data: { error: "invalid_auth" } }, "authorization"],
      [{ data: { error: "not_in_channel" } }, "permission"],
      [{ data: { error: "channel_not_found" } }, "not found"],
      [{ data: { error: "ratelimited" } }, "rate limited"],
      [{ data: { error: "internal_error" } }, "internal_error"],
    ];
    for (const [err, fragment] of cases) {
      const collector = collectorWith(historyClient({ pages: [], historyError: err }));
      const { items, status } = await collector.collectChannelHistory({
        teamId: TEAM,
        channelId: CHANNEL,
        investigationId: "inv-1",
        includePermalinks: false,
      });
      expect(status.status).toBe("FAILED");
      expect(items).toHaveLength(0);
      expect(status.errors[0]).toContain(fragment);
    }
  });

  it("ingests live messages + replies, skips bots, dedupes retries", async () => {
    const repo = memoryRepo();
    const store = new CommonEvidenceStore(repo);
    const collector = collectorWith(historyClient({ pages: [] }));
    const parent = await collector.ingestLiveMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      message: msg("10.000100", "We are seeing 500s."),
      investigationId: "inv-1",
      incidentId: "inc-1",
    });
    const reply = await collector.ingestLiveMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      message: msg("11.000100", "On it.", { thread_ts: "10.000100" }),
      investigationId: "inv-1",
    });
    const bot = await collector.ingestLiveMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      message: { ...msg("12.000100", "bot noise"), bot_id: "B1" },
      investigationId: "inv-1",
    });
    expect(parent?.type).toBe("MESSAGE");
    expect(reply?.type).toBe("THREAD_MESSAGE");
    expect(bot).toBeNull();
    const first = await store.saveAll("inv-1", [parent as EvidenceItem, reply as EvidenceItem]);
    expect(first).toEqual({ stored: 2, skipped: 0 });
    // Retry of the same delivery is idempotent.
    const retry = await store.saveAll("inv-1", [parent as EvidenceItem]);
    expect(retry).toEqual({ stored: 0, skipped: 1 });
  });

  it("preserves attachment metadata without downloading files", async () => {
    const collector = collectorWith(historyClient({ pages: [] }));
    const item = await collector.ingestLiveMessage({
      teamId: TEAM,
      channelId: CHANNEL,
      message: {
        ...msg("20.000100", "logs attached"),
        files: [{ id: "F1", name: "out.log", mimetype: "text/plain", size: 42, url_private: "https://files.slack.com/F1" }],
      },
      investigationId: "inv-1",
    });
    expect(item?.metadata["hasAttachments"]).toBe(true);
    expect(item?.metadata["attachments"]).toEqual([
      { id: "F1", name: "out.log", mimetype: "text/plain", size: 42, url: "https://files.slack.com/F1" },
    ]);
  });

  it("still collects malformed-timestamp messages with null occurredAt", () => {
    expect(slackTsToDate("garbage")).toBeNull();
    const n = normalizeSlackMessage({ teamId: TEAM, channelId: CHANNEL, message: { ts: "garbage", text: "x" } });
    expect(n.occurredAt).toBeNull();
    expect(n.content).toBe("x");
  });

  it("loads existing references once, even when empty or unreadable", async () => {
    let reads = 0;
    const repo = memoryRepo();
    const counting: IEvidenceRepository = {
      ...repo,
      findByInvestigationId: async (id) => {
        reads += 1;
        return repo.findByInvestigationId(id);
      },
    };
    const store = new CommonEvidenceStore(counting);
    expect(await store.saveAll("inv-empty", [])).toEqual({ stored: 0, skipped: 0 });
    expect(await store.saveAll("inv-empty", [])).toEqual({ stored: 0, skipped: 0 });
    expect(reads).toBe(1);

    let failingReads = 0;
    const failing: IEvidenceRepository = {
      ...repo,
      findByInvestigationId: async () => {
        failingReads += 1;
        throw new Error("db down");
      },
    };
    const failingStore = new CommonEvidenceStore(failing);
    const item = EvidenceItem.createCanonical({
      investigationId: "inv-fail",
      source: EvidenceSource.Slack,
      type: "MESSAGE",
      sourceId: slackParentSourceId(TEAM, CHANNEL, "1.000100"),
      content: "x",
    });
    expect(await failingStore.saveAll("inv-fail", [item])).toEqual({ stored: 1, skipped: 0 });
    expect(await failingStore.saveAll("inv-fail", [item])).toEqual({ stored: 0, skipped: 1 });
    expect(failingReads).toBe(1);
  });

  it("counts duplicate-key writes as skipped but propagates other errors", async () => {
    const repo = memoryRepo();
    const store = new CommonEvidenceStore(repo);
    const mk = (ts: string) =>
      EvidenceItem.createCanonical({
        investigationId: "inv-dup",
        source: EvidenceSource.Slack,
        type: "MESSAGE",
        sourceId: slackParentSourceId(TEAM, CHANNEL, ts),
        content: ts,
      });
    expect(await store.saveAll("inv-dup", [mk("1.000100")])).toEqual({ stored: 1, skipped: 0 });
    // Cross-process race: same sourceId written behind our back.
    const raced = mk("2.000100");
    const realCreate = repo.create.bind(repo);
    repo.create = async (e) => {
      if (e.reference === raced.reference) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      return realCreate(e);
    };
    expect(await store.saveAll("inv-dup", [raced])).toEqual({ stored: 0, skipped: 1 });
    repo.create = async () => {
      throw new Error("boom");
    };
    await expect(store.saveAll("inv-dup", [mk("3.000100")])).rejects.toThrow("boom");
  });

  it("gives identical evidence distinct ids per investigation but one content hash", () => {
    const base = {
      source: EvidenceSource.GitHub,
      type: "github.commit",
      sourceId: "company/payments-service@abc123",
      content: "Commit abc123: fix auth",
    } as const;
    const a = EvidenceItem.createCanonical({ ...base, investigationId: "inv-1" });
    const b = EvidenceItem.createCanonical({ ...base, investigationId: "inv-2" });
    expect(a.id).not.toBe(b.id);
    expect(a.hash).toBe(b.hash);
    expect(a.reference).toBe(b.reference);
  });

  it("common store keeps GitHub-shaped items compatible (provenance intact)", async () => {
    const repo = memoryRepo();
    const store = new CommonEvidenceStore(repo);
    const item = EvidenceItem.createCanonical({
      investigationId: "inv-1",
      source: EvidenceSource.GitHub,
      type: "github.commit",
      sourceId: "company/payments-service@abc123",
      content: "Commit abc123: fix auth",
      provenance: { owner: "company", repository: "company/payments-service", commitSha: "abc123" },
    });
    const result = await store.saveAll("inv-1", [item]);
    expect(result.stored).toBe(1);
    expect(repo.docs[0]?.provenance).toMatchObject({ commitSha: "abc123" });
    expect(repo.docs[0]?.reference).toBe("company/payments-service@abc123");
  });
});
