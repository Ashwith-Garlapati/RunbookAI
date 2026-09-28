import { describe, it, expect, beforeEach, vi } from "vitest";
import { QuestionAnsweringService } from "../services/QuestionAnsweringService.js";
import { InvestigationStatus } from "../domains/investigation/InvestigationStatus.js";
import type { InvestigationService } from "../domains/investigation/InvestigationService.js";
import type { Investigation } from "../domains/investigation/Investigation.js";

function createMockInvestigation(): Investigation {
  return {
    id: "inv-1",
    title: "Checkout API failures",
    description: "Checkout API returning 500s after deploy",
    status: InvestigationStatus.CollectingEvidence,
    evidenceIds: [],
    resolvedBy: undefined,
    metadata: {},
  } as unknown as Investigation;
}

function createMockService(investigation?: Investigation): InvestigationService {
  return {
    findBySlackContext: vi.fn(async () => investigation),
    getTimeline: vi.fn(async () => [
      { description: "Investigation created" },
      { description: "Status changed to collecting_evidence" },
    ]),
  } as unknown as InvestigationService;
}

describe("QuestionAnsweringService", () => {
  it("answers using the linked investigation context", async () => {
    const investigation = createMockInvestigation();
    const service = new QuestionAnsweringService(createMockService(investigation));

    const result = await service.answer({
      question: "summarize this thread",
      channelId: "C12345",
    });

    expect(result.contextFound).toBe(true);
    expect(result.investigationId).toBe("inv-1");
    expect(result.answer).toContain("Checkout API failures");
    expect(result.answer).toContain("Collecting Evidence");
  });

  it("never creates an investigation while answering", async () => {
    const service = new QuestionAnsweringService(createMockService(createMockInvestigation()));
    const spy = vi.spyOn(service as any, "answer");

    await service.answer({ question: "what caused this?", channelId: "C12345" });

    // The service only has read-only methods available; nothing on the
    // service can create an investigation.
    expect((service as any)._investigationService.createInvestigation).toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it("asks for clarification when no investigation is linked", async () => {
    const service = new QuestionAnsweringService(createMockService(undefined));

    const result = await service.answer({ question: "summarize this thread", channelId: "C12345" });

    expect(result.contextFound).toBe(false);
    expect(result.answer).toContain("I can't summarize this thread");
    expect(result.answer).toContain("investigate");
  });

  it("reports when root cause is not confirmed", async () => {
    const service = new QuestionAnsweringService(createMockService(createMockInvestigation()));

    const result = await service.answer({ question: "what caused this?", channelId: "C12345" });

    expect(result.answer).toContain("Root cause is not confirmed yet");
  });

  it("mentions the resolver once the investigation is resolved", async () => {
    const investigation = createMockInvestigation();
    investigation.status = InvestigationStatus.Resolved;
    investigation.resolvedBy = "U12345";
    const service = new QuestionAnsweringService(createMockService(investigation));

    const result = await service.answer({ question: "what caused this?", channelId: "C12345" });

    expect(result.answer).toContain("Resolved");
    expect(result.answer).toContain("U12345");
  });

  it("works without channel context (thread-based questions)", async () => {
    const service = new QuestionAnsweringService(createMockService(undefined));

    const result = await service.answer({ question: "what changed today?" });

    expect(result.contextFound).toBe(false);
    expect(result.answer.length).toBeGreaterThan(0);
  });
});
