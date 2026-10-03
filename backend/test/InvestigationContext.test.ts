import { describe, it, expect } from "vitest";

import { Incident } from "../domains/incident/Incident.js";
import { EvidenceItem } from "../domains/investigation/EvidenceItem.js";
import { EvidenceSource } from "../domains/investigation/EvidenceSource.js";
import type { IEvidenceRepository } from "../domains/investigation/RepositoryInterfaces.js";
import { InvestigationContextBuilder, orderEvidence } from "../services/investigationContext.js";
import { normalizeSlackMessage } from "../services/slackEvidence.js";

function buildIncident() {
  const incident = Incident.declare({
    teamId: "T1",
    title: "Checkout API returning 500s on /checkout",
    description: "payments-service timeout errors",
    affectedService: "payments-service",
    reporterId: "U-reporter",
  });
  incident.attachChannel("U-reporter", "C-inc-142", "inc-checkout-142", null);
  incident.postUpdate("U-responder", { text: "Seeing 500s from authorization service" });
  return incident;
}

function slackItem(ts: string, text: string, threadTs?: string): EvidenceItem {
  const normalized = normalizeSlackMessage({
    teamId: "T1",
    channelId: "C-inc-142",
    message: { ts, user: "U1", text, ...(threadTs ? { thread_ts: threadTs } : {}) },
  });
  return EvidenceItem.createCanonical({
    investigationId: "inv-142",
    source: EvidenceSource.Slack,
    type: normalized.type,
    sourceId: normalized.sourceId,
    teamId: "T1",
    incidentId: "inc-142",
    content: normalized.content,
    searchableText: normalized.content,
    ...(normalized.occurredAt ? { occurredAt: normalized.occurredAt } : {}),
    provenance: { ...normalized.provenance },
  });
}

function githubItem(sourceId: string, content: string): EvidenceItem {
  return EvidenceItem.createCanonical({
    investigationId: "inv-142",
    source: EvidenceSource.GitHub,
    type: "github.commit",
    sourceId,
    content,
    provenance: { owner: "company", repository: "company/payments-service", commitSha: "abc123" },
  });
}

function repoWith(items: EvidenceItem[]): IEvidenceRepository {
  return {
    create: async () => {},
    findById: async () => null,
    findByInvestigationId: async () => items,
  };
}

function fakeCoordinator(incident: Incident) {
  return { get: async () => incident, findByChannel: async () => incident } as never;
}

describe("InvestigationContext", () => {
  it("builds incident + complete Slack evidence (acceptance shape)", () => {
    const incident = buildIncident();
    const builder = new InvestigationContextBuilder(fakeCoordinator(incident), repoWith([]));
    const items = [
      slackItem("7.000100", "Rollback completed."),
      slackItem("1.000100", "Checkout API latency is increasing."),
      slackItem("4.000100", "Rolling back deployment 841."),
      slackItem("5.000100", "Rollback is running.", "4.000100"),
      slackItem("6.000100", "Errors are dropping.", "4.000100"),
      slackItem("2.000100", "We are seeing 500s."),
      slackItem("3.000100", "Looks like authorization.", "2.000100"),
    ];
    const ctx = builder.build({ teamId: "T1", incidentId: incident.id, investigationId: "inv-142", incident, items });
    expect(ctx.slackEvidence).toHaveLength(7);
    expect(ctx.evidenceSummary).toMatchObject({ slackCount: 7, githubCount: 0, totalCount: 7 });
    expect(ctx.availableSources).toEqual(["slack"]);
    expect(ctx.incident.title).toContain("Checkout");
    expect(ctx.timeline.length).toBeGreaterThan(0);
    // Parent precedes its replies.
    const order = ctx.slackEvidence.map((e) => e.sourceId);
    expect(order.indexOf("slack:T1:C-inc-142:4.000100")).toBeLessThan(order.indexOf("slack:T1:C-inc-142:4.000100:5.000100"));
    expect(ctx.investigationWindow.start).toBe(incident.createdAt.toISOString());
  });

  it("combines Slack + GitHub evidence with repositories and participants", () => {
    const incident = buildIncident();
    const builder = new InvestigationContextBuilder(fakeCoordinator(incident), repoWith([]));
    const ctx = builder.build({
      teamId: "T1",
      incidentId: incident.id,
      investigationId: "inv-142",
      incident,
      items: [slackItem("1.000100", "500s on /checkout"), githubItem("company/payments-service@abc123", "fix auth")],
    });
    expect(ctx.availableSources).toEqual(["github", "slack"]);
    expect(ctx.evidenceSummary).toMatchObject({ slackCount: 1, githubCount: 1, totalCount: 2 });
    expect(ctx.repositories).toEqual(["company/payments-service"]);
    expect(ctx.participants).toContain("U-reporter");
    expect(ctx.participants).toContain("U1");
    expect(ctx.affectedServices).toEqual(["payments-service"]);
    expect(ctx.endpoints).toContain("/checkout");
    expect(ctx.errors).toContain("500");
  });

  it("handles GitHub-only, Slack-only, and empty evidence without fabrication", () => {
    const incident = Incident.declare({ teamId: "T1", title: "Blip", reporterId: "U1" });
    const builder = new InvestigationContextBuilder(fakeCoordinator(incident), repoWith([]));
    const gh = builder.build({
      teamId: "T1",
      incidentId: incident.id,
      investigationId: "inv-1",
      incident,
      items: [githubItem("r@sha", "x")],
    });
    expect(gh.availableSources).toEqual(["github"]);
    expect(gh.slackEvidence).toHaveLength(0);
    const empty = builder.build({ teamId: "T1", incidentId: incident.id, investigationId: "inv-1", incident, items: [] });
    expect(empty.evidenceSummary.totalCount).toBe(0);
    expect(empty.availableSources).toEqual([]);
    expect(empty.endpoints).toEqual([]);
    expect(empty.errors).toEqual([]);
    expect(empty.repositories).toEqual([]);
    expect(empty.symptoms).toEqual(["Blip"]);
  });

  it("orders deterministically regardless of input order", () => {
    const a = slackItem("2.000100", "b");
    const b = slackItem("1.000100", "a");
    const c = githubItem("r@sha", "x");
    expect(orderEvidence([c, a, b]).map((i) => i.sourceId)).toEqual(orderEvidence([a, b, c]).map((i) => i.sourceId));
    // Same-second tie broken deterministically (parent before reply).
    const parent = slackItem("5.000100", "p");
    const reply = slackItem("5.000100", "r", "5.000100");
    void reply;
    const tied = orderEvidence([slackItem("5.000100", "r2", "5.000100"), parent]);
    expect(tied[0]?.type).toBe("MESSAGE");
  });

  it("buildForIncident loads incident + stored evidence", async () => {
    const incident = buildIncident();
    const stored = [slackItem("1.000100", "We are seeing 500s.")];
    const builder = new InvestigationContextBuilder(fakeCoordinator(incident), repoWith(stored));
    const ctx = await builder.buildForIncident({ teamId: "T1", incidentId: incident.id, investigationId: "inv-142" });
    expect(ctx.incidentId).toBe(incident.id);
    expect(ctx.teamId).toBe("T1");
    expect(ctx.slackEvidence).toHaveLength(1);
    expect(ctx.version).toBe("1");
  });
});
