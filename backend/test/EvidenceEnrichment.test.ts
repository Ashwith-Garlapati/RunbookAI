import { describe, it, expect } from "vitest";

import { EvidenceItem } from "../domains/investigation/EvidenceItem.js";
import { EvidenceSource } from "../domains/investigation/EvidenceSource.js";
import type { IEvidenceRepository } from "../domains/investigation/RepositoryInterfaces.js";
import { enrichEvidence, EvidenceEnrichmentService } from "../services/evidenceEnrichment.js";

function slackItem(content: string): EvidenceItem {
  return EvidenceItem.createCanonical({
    investigationId: "inv-1",
    source: EvidenceSource.Slack,
    type: "MESSAGE",
    sourceId: `slack:T1:C1:${content.length}.000100`,
    teamId: "T1",
    content,
  });
}

function githubItem(content: string, provenance: Record<string, unknown>, type = "github.pull_request"): EvidenceItem {
  return EvidenceItem.createCanonical({
    investigationId: "inv-1",
    source: EvidenceSource.GitHub,
    type,
    sourceId: `company/payments-service#482:${content.length}`,
    content,
    provenance,
  });
}

function memoryRepo(docs: EvidenceItem[] = []): IEvidenceRepository {
  return {
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

describe("evidence enrichment", () => {
  it("extracts service, endpoint, and HTTP status from incident text", () => {
    const enrichment = enrichEvidence(slackItem("payments-service is returning 500 on /checkout"));
    expect(enrichment.services).toContain("payments-service");
    expect(enrichment.endpoints).toContain("/checkout");
    expect(enrichment.errors).toContainEqual(expect.objectContaining({ value: "HTTP 500", kind: "HTTP_STATUS" }));
    expect(enrichment.entities).toContainEqual(
      expect.objectContaining({ value: "payments-service", type: "SERVICE", source: "text" }),
    );
  });

  it("extracts error codes with technology", () => {
    const enrichment = enrichEvidence(slackItem("ECONNREFUSED while connecting to postgres"));
    expect(enrichment.errors).toContainEqual(expect.objectContaining({ value: "ECONNREFUSED", kind: "CONNECTION" }));
    const db = enrichEvidence(slackItem("deadlock detected on postgres"));
    expect(db.errors).toContainEqual(expect.objectContaining({ kind: "DATABASE", technology: "postgres" }));
  });

  it("extracts endpoints and HTTP methods separately", () => {
    const enrichment = enrichEvidence(slackItem("POST /api/payments failed, retry with GET /v1/users/{id}"));
    expect(enrichment.endpoints).toEqual(expect.arrayContaining(["/api/payments", "/v1/users/{id}"]));
    expect(enrichment.httpMethods).toEqual(expect.arrayContaining(["POST", "GET"]));
  });

  it("extracts functions, classes, and file paths", () => {
    const enrichment = enrichEvidence(slackItem("validateToken() throws in PaymentService, see src/auth/validateToken.ts"));
    expect(enrichment.functions).toContain("validateToken");
    expect(enrichment.classes).toContain("PaymentService");
    expect(enrichment.files).toContain("src/auth/validateToken.ts");
  });

  it("extracts PR numbers, commit SHAs, repositories, and incident IDs", () => {
    const enrichment = enrichEvidence(slackItem("PR #482 commit abc1234 in company/payments-service for INC-142"));
    expect(enrichment.pullRequests).toContain(482);
    expect(enrichment.commits).toContain("abc1234");
    expect(enrichment.repositories).toContain("company/payments-service");
    expect(enrichment.entities).toContainEqual(expect.objectContaining({ value: "INC-142", type: "INCIDENT" }));
  });

  it("does not classify plain decimal numbers as commit SHAs", () => {
    const enrichment = enrichEvidence(slackItem("deployment 841 completed at 20260930, see ticket 1234567890, commit abc1234"));
    expect(enrichment.commits).toContain("abc1234");
    expect(enrichment.commits).not.toContain("20260930");
    expect(enrichment.commits).not.toContain("1234567890");
    expect(enrichment.entities.find((e) => e.type === "COMMIT" && e.value === "1234567890")).toBeUndefined();
  });

  it("extracts deployment events with targets", () => {
    const enrichment = enrichEvidence(slackItem("Rollback deployment 841 completed"));
    expect(enrichment.events).toContainEqual(expect.objectContaining({ type: "ROLLBACK", target: "deployment 841" }));
    expect(enrichment.deployments).toContainEqual({ reference: "841", label: "deployment 841" });
  });

  it("emits temporal/associative relationships, never causal ones", () => {
    const enrichment = enrichEvidence(slackItem("Checkout API started returning 500s after deployment 841. Rollback reduced errors."));
    const relations = enrichment.relationships.map((r) => r.relation);
    expect(relations).toContain("PRECEDES");
    expect(relations).toContain("ASSOCIATED_WITH_REDUCTION_IN");
    expect(JSON.stringify(enrichment)).not.toMatch(/caus/i);
    for (const r of enrichment.relationships) {
      expect(["PRECEDES", "ASSOCIATED_WITH_REDUCTION_IN", "MODIFIES", "AUTHORED_BY"]).toContain(r.relation);
    }
  });

  it("normalizes keywords without touching raw content", () => {
    const item = slackItem("The Checkout API is DOWN with 500s!!!");
    const enrichment = enrichEvidence(item);
    expect(enrichment.keywords).toContain("checkout");
    expect(enrichment.keywords).toContain("500s");
    expect(enrichment.keywords).not.toContain("the");
    expect(enrichment.keywords).not.toContain("is");
    expect(item.content).toBe("The Checkout API is DOWN with 500s!!!");
  });

  it("classifies deterministically per source", () => {
    expect(enrichEvidence(slackItem("Is the checkout fixed?")).classification.semantic).toContain("QUESTION");
    expect(enrichEvidence(slackItem("Rolling back deployment 841")).classification.semantic).toContain("ROLLBACK");
    expect(enrichEvidence(slackItem("Seeing 500s everywhere")).classification.semantic).toContain("ERROR");
    const gh = enrichEvidence(githubItem("x", {}, "github.pull_request"));
    expect(gh.classification.semantic).toContain("PULL_REQUEST");
    const commit = enrichEvidence(githubItem("x", {}, "github.commit"));
    expect(commit.classification.semantic).toContain("COMMIT");
  });

  it("tracks spans and provenance origin", () => {
    const enrichment = enrichEvidence(slackItem("payments-service is down"));
    const entity = enrichment.entities.find((e) => e.value === "payments-service");
    expect(entity?.source).toBe("text");
    expect(entity?.span).toEqual({ start: 0, end: 16 });
    const gh = enrichEvidence(
      githubItem("touched files", { owner: "company", repository: "company/payments-service", prNumber: 482, filePath: "src/a.ts" }),
    );
    expect(gh.entities).toContainEqual(expect.objectContaining({ value: "company/payments-service", source: "provenance" }));
    expect(gh.entities).toContainEqual(expect.objectContaining({ value: "src/a.ts", source: "provenance" }));
    expect(gh.relationships).toContainEqual({ from: "PR #482", relation: "MODIFIES", to: "src/a.ts" });
  });

  it("reuses structured GitHub metadata instead of rediscovering it", () => {
    const gh = enrichEvidence(
      githubItem("fix", {
        owner: "company",
        repository: "company/payments-service",
        commitSha: "abc1234def",
        prNumber: 482,
      }, "github.commit"),
    );
    expect(gh.repositories).toContain("company/payments-service");
    expect(gh.commits).toContain("abc1234def");
    expect(gh.pullRequests).toContain(482);
  });

  it("annotates context matches without fabricating entities", () => {
    const without = enrichEvidence(slackItem("latency is up"));
    expect(without.entities.find((e) => e.contextMatched)).toBeUndefined();
    const withCtx = enrichEvidence(slackItem("payments-service latency is up"), { services: ["payments-service"] });
    expect(withCtx.entities).toContainEqual(
      expect.objectContaining({ value: "payments-service", contextMatched: true }),
    );
    // Context-only values must not appear as entities.
    expect(withCtx.entities.find((e) => e.value === "other-service")).toBeUndefined();
  });

  it("enrichment is idempotent and preserves raw evidence", () => {
    const service = new EvidenceEnrichmentService();
    const once = service.enrichOne(slackItem("payments-service 500 on /checkout deployment 12"));
    const twice = service.enrichOne(once);
    const { processedAt: _p1, ...onceRest } = once.enrichment ?? {};
    const { processedAt: _p2, ...twiceRest } = twice.enrichment ?? {};
    void _p1;
    void _p2;
    expect(twiceRest).toEqual(onceRest);
    expect(twice.id).toBe(once.id);
    expect(twice.content).toBe(once.content);
    expect(twice.provenance).toEqual(once.provenance);
  });

  it("handles malformed and empty evidence without throwing", () => {
    const empty = enrichEvidence(slackItem(""));
    expect(empty.entities).toEqual([]);
    expect(empty.keywords).toEqual([]);
    const weird = enrichEvidence(slackItem("!!! ??? ... and/or w/"));
    expect(weird.repositories).toEqual([]);
    expect(weird.classification.semantic).toContain("QUESTION");
  });

  it("enriches a whole investigation through the existing store", async () => {
    const docs = [slackItem("payments-service 500"), githubItem("fix auth", { repository: "company/payments-service" })];
    const repo = memoryRepo(docs);
    const service = new EvidenceEnrichmentService();
    const result = await service.enrichInvestigation(repo, "inv-1");
    expect(result).toEqual({ enriched: 2, failed: 0 });
    const stored = await repo.findByInvestigationId("inv-1");
    expect(stored.every((d) => d.enrichment?.version === "1")).toBe(true);
    expect(stored[0]?.id).toBe(docs[0]?.id);
    // Rerun is a no-op semantically: same IDs, same enrichment.
    const again = await service.enrichInvestigation(repo, "inv-1");
    expect(again).toEqual({ enriched: 2, failed: 0 });
    expect((await repo.findByInvestigationId("inv-1")).map((d) => d.id)).toEqual(stored.map((d) => d.id));
  });

  it("counts missing documents as failed instead of enriched", async () => {
    const docs = [slackItem("payments-service 500")];
    const repo = memoryRepo(docs);
    const missing: IEvidenceRepository = {
      ...repo,
      findByInvestigationId: async () => docs,
      update: async () => false,
    };
    const service = new EvidenceEnrichmentService();
    await expect(service.enrichInvestigation(missing, "inv-1")).resolves.toEqual({ enriched: 0, failed: 1 });
  });

  it("enrichMany collects per-item results without failing the batch", () => {
    const service = new EvidenceEnrichmentService();
    const { items, failed } = service.enrichMany([slackItem("a 500"), slackItem("b timeout")]);
    expect(items).toHaveLength(2);
    expect(failed).toHaveLength(0);
  });

  it("acceptance: checkout 500s with deployment and auth timeout", () => {
    const enrichment = enrichEvidence(slackItem("Checkout API started returning 500s after deployment 841. Auth service is timing out."));
    // "Checkout API" normalizes to checkout-api; "Auth service" to auth-service.
    expect(enrichment.services).toEqual(expect.arrayContaining(["checkout-api", "auth-service"]));
    expect(enrichment.errors.map((e) => e.value)).toEqual(expect.arrayContaining(["HTTP 500", "timeout"]));
    expect(enrichment.events.map((e) => e.type)).toContain("DEPLOYMENT");
    expect(enrichment.deployments.map((d) => d.reference)).toContain("841");
    expect(enrichment.relationships).toContainEqual(
      expect.objectContaining({ relation: "PRECEDES", to: "HTTP 500" }),
    );
    expect(enrichment).not.toHaveProperty("rootCause");
  });

  it("acceptance: GitHub PR evidence keeps structured identity", () => {
    const enrichment = enrichEvidence(
      githubItem("validateToken() changed in review", {
        owner: "company",
        repository: "company/payments-service",
        prNumber: 482,
        commitSha: "abc1234",
        filePath: "src/auth/validateToken.ts",
      }),
    );
    expect(enrichment.repositories).toContain("company/payments-service");
    expect(enrichment.pullRequests).toContain(482);
    expect(enrichment.commits).toContain("abc1234");
    expect(enrichment.files).toContain("src/auth/validateToken.ts");
    expect(enrichment.functions).toContain("validateToken");
  });

  it("does not fabricate services from determiners or plain prose", () => {
    expect(enrichEvidence(slackItem("the service is down")).services).toEqual([]);
    expect(enrichEvidence(slackItem("an API is failing")).services).toEqual([]);
    // Genuine references still extract.
    expect(enrichEvidence(slackItem("Auth service is timing out")).services).toContain("auth-service");
    expect(enrichEvidence(slackItem("Checkout API is slow")).services).toContain("checkout-api");
  });

  it("does not treat common hyphenated phrases as services", () => {
    const enrichment = enrichEvidence(slackItem("well-known issue, needs follow-up"));
    expect(enrichment.services).toEqual([]);
    expect(enrichEvidence(slackItem("payments-service is down")).services).toContain("payments-service");
  });

  it("detects mitigation events instead of misclassifying them as recovery", () => {
    for (const text of ["mitigation in progress", "mitigating the issue", "workaround applied"]) {
      const types = enrichEvidence(slackItem(text)).events.map((e) => e.type);
      expect(types).toContain("MITIGATION");
      expect(types).not.toContain("RECOVERY");
    }
    // Genuine recovery still detected.
    expect(enrichEvidence(slackItem("Error rate is dropping")).events.map((e) => e.type)).toContain("RECOVERY");
  });

  it("requires a service-state predicate for bare 'down'", () => {
    expect(enrichEvidence(slackItem("scroll down to see")).events.map((e) => e.type)).not.toContain("FAILURE");
    expect(enrichEvidence(slackItem("payments-service is down")).events.map((e) => e.type)).toContain("FAILURE");
    expect(enrichEvidence(slackItem("The Checkout API is DOWN with 500s")).events.map((e) => e.type)).toContain("FAILURE");
  });

  it("does not invent classes from Titlecase prose or services from endpoint words", () => {
    const prose = enrichEvidence(slackItem("We had a Meeting about it"));
    expect(prose.classes).toEqual([]);
    const endpoint = enrichEvidence(slackItem("See /checkout for details on Checkout flow"));
    expect(endpoint.endpoints).toContain("/checkout");
    expect(endpoint.services).toEqual([]);
    // Genuine CamelCase classes still extract.
    expect(enrichEvidence(slackItem("validateToken() throws in PaymentService")).classes).toContain("PaymentService");
  });

  it("dedupes repeated deployment mentions without duplicating entities", () => {
    const enrichment = enrichEvidence(slackItem("deployment 841 started, deployment 841 finished"));
    expect(enrichment.deployments).toEqual([{ reference: "841", label: "deployment 841" }]);
    expect(enrichment.entities.filter((e) => e.type === "DEPLOYMENT")).toHaveLength(1);
  });

  it("handles unsupported source types without throwing", () => {
    const item = EvidenceItem.createCanonical({
      investigationId: "inv-1",
      source: "DATADOG" as never,
      type: "metric",
      sourceId: "dd:1",
      content: "latency spike on /checkout with 500s",
    });
    const enrichment = enrichEvidence(item);
    expect(enrichment.endpoints).toContain("/checkout");
    expect(enrichment.classification.semantic).toContain("OBSERVATION");
  });

  it("preserves identity, timestamps, and provenance through enrichment", () => {
    const service = new EvidenceEnrichmentService();
    const item = EvidenceItem.createCanonical({
      investigationId: "inv-1",
      source: EvidenceSource.Slack,
      type: "THREAD_MESSAGE",
      sourceId: "slack:T1:C1:1.1:1.2",
      teamId: "T1",
      incidentId: "inc-1",
      content: "payments-service 500",
      occurredAt: new Date("2026-09-30T14:00:00Z"),
      provenance: { channelId: "C1", userId: "U1" },
    });
    const enriched = service.enrichOne(item);
    expect(enriched.id).toBe(item.id);
    expect(enriched.sourceId).toBe(item.sourceId);
    expect(enriched.source).toBe(item.source);
    expect(enriched.occurredAt?.toISOString()).toBe("2026-09-30T14:00:00.000Z");
    expect(enriched.provenance).toEqual(item.provenance);
    expect(enriched.content).toBe(item.content);
    expect(enriched.enrichment?.version).toBe("1");
  });

  it("survives a persistence reload round-trip with enrichment intact", () => {
    const service = new EvidenceEnrichmentService();
    const enriched = service.enrichOne(slackItem("payments-service 500 on /checkout deployment 12"));
    // Simulate DB reload: serialize to plain JSON and reconstitute.
    const reloaded = EvidenceItem.reconstitute(JSON.parse(JSON.stringify(enriched)));
    expect(reloaded.id).toBe(enriched.id);
    expect(reloaded.enrichment?.services).toEqual(enriched.enrichment?.services);
    expect(reloaded.enrichment?.errors).toEqual(enriched.enrichment?.errors);
    expect(reloaded.enrichment?.deployments).toEqual(enriched.enrichment?.deployments);
    expect(reloaded.content).toBe(enriched.content);
    // Re-enrichment after reload is semantically identical (ignoring processedAt).
    const again = service.enrichOne(reloaded);
    const { processedAt: _a, ...first } = enriched.enrichment ?? {};
    const { processedAt: _b, ...second } = again.enrichment ?? {};
    void _a;
    void _b;
    expect(second).toEqual(first);
    expect(again.id).toBe(enriched.id);
  });

  it("never concludes deployment 841 caused the incident", () => {
    const enrichment = enrichEvidence(slackItem("Checkout API started returning 500s after deployment 841. Auth service is timing out."));
    expect(JSON.stringify(enrichment)).not.toMatch(/\bcaus/i);
    for (const r of enrichment.relationships) {
      expect(["PRECEDES", "ASSOCIATED_WITH_REDUCTION_IN", "MODIFIES", "AUTHORED_BY", "MENTIONS"]).toContain(r.relation);
    }
    // Temporal precedence is recorded; causality is not.
    expect(enrichment.relationships).toContainEqual(
      expect.objectContaining({ relation: "PRECEDES", to: "HTTP 500" }),
    );
  });
});
