import { describe, it, expect, beforeEach, vi } from "vitest";
import { Investigation } from "../domains/investigation/Investigation.js";
import {
  InvestigationStatus,
  canTransition,
  InvalidTransitionError,
} from "../domains/investigation/InvestigationStatus.js";
import { InvestigationService } from "../domains/investigation/InvestigationService.js";
import { TimelineService } from "../domains/investigation/TimelineService.js";
import { InProcessEventBus } from "../infrastructure/InProcessEventBus.js";
import { Trigger } from "../domains/investigation/Trigger.js";
import { TriggerSource } from "../domains/investigation/TriggerSource.js";
import { TriggerType } from "../domains/investigation/TriggerType.js";
import { TimelineEventType } from "../domains/investigation/TimelineEventType.js";
import type { IInvestigationRepository } from "../domains/investigation/InvestigationRepository.js";

function createTestTrigger(metadata: Record<string, unknown> = {}) {
  return Trigger.create({
    source: TriggerSource.Slack,
    type: TriggerType.SlashCommand,
    actor: "U12345",
    payload: { channel: "C12345" },
    metadata,
  });
}

function createTestParams(metadata: Record<string, unknown> = {}) {
  return {
    title: "Checkout API failures",
    description: "Checkout API returning 500s",
    severity: "high",
    trigger: createTestTrigger(metadata),
    createdBy: "U12345",
    metadata: { triggerSource: "slack", ...metadata },
  };
}

describe("Investigation resolution lifecycle", () => {
  it("allows resolving from any active state", () => {
    expect(canTransition(InvestigationStatus.Draft, InvestigationStatus.Resolved)).toBe(true);
    expect(
      canTransition(InvestigationStatus.CollectingEvidence, InvestigationStatus.Resolved),
    ).toBe(true);
    expect(canTransition(InvestigationStatus.Analyzing, InvestigationStatus.Resolved)).toBe(true);
    expect(
      canTransition(InvestigationStatus.GeneratingFindings, InvestigationStatus.Resolved),
    ).toBe(true);
  });

  it("only allows runbook generation AFTER resolution", () => {
    expect(canTransition(InvestigationStatus.Resolved, InvestigationStatus.GeneratingRunbook)).toBe(
      true,
    );
    // Runbook generation is never reachable from creation - a fresh
    // investigation cannot jump to runbook generation.
    expect(
      canTransition(InvestigationStatus.Draft, InvestigationStatus.GeneratingRunbook),
    ).toBe(false);
  });

  it("resolve() transitions to Resolved and records resolvedBy/resolvedAt", () => {
    const investigation = Investigation.create(createTestParams());

    investigation.resolve("U12345");

    expect(investigation.status).toBe(InvestigationStatus.Resolved);
    expect(investigation.resolvedBy).toBe("U12345");
    expect(investigation.resolvedAt).toBeInstanceOf(Date);
  });

  it("resolve() emits an InvestigationResolved event", () => {
    const investigation = Investigation.create(createTestParams());
    investigation.resolve("U12345");

    const events = investigation.pullEvents();
    const resolvedEvent = events.find((e) => e.eventType === "InvestigationResolved");
    expect(resolvedEvent).toBeDefined();
    expect(resolvedEvent?.payload).toMatchObject({ resolvedBy: "U12345" });
  });

  it("rejects resolving an archived investigation", () => {
    const investigation = Investigation.create(createTestParams());
    investigation.resolve("U12345");
    investigation.generateRunbook();
    investigation.approve();
    investigation.complete();
    investigation.archive();

    expect(() => investigation.resolve("U12345")).toThrow(InvalidTransitionError);
  });

  it("keeps the resolved investigation available for runbook generation (not archived)", () => {
    const investigation = Investigation.create(createTestParams());
    investigation.resolve("U12345");

    // Not archived, and runbook generation is the legal next step.
    expect(investigation.status).toBe(InvestigationStatus.Resolved);
    expect(() => investigation.generateRunbook()).not.toThrow();
    expect(investigation.status).toBe(InvestigationStatus.GeneratingRunbook);
  });
});

describe("InvestigationService resolution flow", () => {
  let service: InvestigationService;
  let repository: IInvestigationRepository;
  let eventBus: InProcessEventBus;
  let timelineService: TimelineService;
  const store = new Map<string, Investigation>();

  beforeEach(() => {
    store.clear();
    repository = {
      create: vi.fn(async (inv) => {
        store.set(inv.id, inv);
        return inv;
      }),
      update: vi.fn(async (inv) => {
        store.set(inv.id, inv);
        return inv;
      }),
      findById: vi.fn(async (id) => store.get(id) ?? null),
      findByStatus: vi.fn(async () => []),
      findActive: vi.fn(async () => []),
      findCompleted: vi.fn(async () => []),
      findBySlackChannel: vi.fn(async () => []),
      delete: vi.fn(async () => {}),
    };
    eventBus = new InProcessEventBus();
    timelineService = new TimelineService();
    service = new InvestigationService(repository, eventBus, timelineService);
  });

  it("creating an investigation leaves it in Draft - no runbook is generated at creation", async () => {
    const investigation = await service.createInvestigation(createTestParams());

    expect(investigation.status).toBe(InvestigationStatus.Draft);
    expect(investigation.runbookId).toBeUndefined();
    expect(investigation.findingIds).toHaveLength(0);
  });

  it("resolveInvestigation transitions to Resolved and records who resolved it", async () => {
    const created = await service.createInvestigation(createTestParams());

    const resolved = await service.resolveInvestigation(created.id, "U12345");

    expect(resolved.status).toBe(InvestigationStatus.Resolved);
    expect(resolved.resolvedBy).toBe("U12345");
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    expect(repository.update).toHaveBeenCalled();
  });

  it("resolveInvestigation adds a timeline entry", async () => {
    const created = await service.createInvestigation(createTestParams());

    await service.resolveInvestigation(created.id, "U12345");

    const timeline = timelineService.getTimeline(created.id);
    const resolvedEntry = timeline.find((e) => e.type === TimelineEventType.Resolved);
    expect(resolvedEntry).toBeDefined();
    expect(resolvedEntry?.description).toContain("U12345");
  });

  it("resolveInvestigation publishes an InvestigationResolved domain event", async () => {
    const created = await service.createInvestigation(createTestParams());
    const published: string[] = [];
    eventBus.subscribe("*", {
      handle: async (event) => {
        published.push(event.eventType);
      },
    });

    await service.resolveInvestigation(created.id, "U12345");

    expect(published).toContain("InvestigationResolved");
  });

  it("resolveInvestigation does NOT generate a runbook", async () => {
    const created = await service.createInvestigation(createTestParams());

    const resolved = await service.resolveInvestigation(created.id, "U12345");

    expect(resolved.status).toBe(InvestigationStatus.Resolved);
    expect(resolved.runbookId).toBeUndefined();
    expect(resolved.findingIds).toHaveLength(0);
    expect(canTransition(InvestigationStatus.Resolved, InvestigationStatus.GeneratingRunbook)).toBe(
      true,
    );
  });

  it("findBySlackContext returns the investigation linked to the channel", async () => {
    const created = await service.createInvestigation(
      createTestParams({ slackChannelId: "C12345" }),
    );
    (repository.findBySlackChannel as any).mockResolvedValue([created]);

    const found = await service.findBySlackContext("C12345");

    expect(found?.id).toBe(created.id);
  });

  it("findBySlackContext prefers the investigation in the same thread", async () => {
    const channelInv = await service.createInvestigation(
      createTestParams({ slackChannelId: "C12345", threadTs: "111.111" }),
    );
    const threadInv = await service.createInvestigation(
      createTestParams({ slackChannelId: "C12345", threadTs: "222.222" }),
    );
    (repository.findBySlackChannel as any).mockResolvedValue([channelInv, threadInv]);

    const found = await service.findBySlackContext("C12345", "222.222");

    expect(found?.id).toBe(threadInv.id);
  });

  it("findBySlackContext returns undefined when nothing is linked", async () => {
    (repository.findBySlackChannel as any).mockResolvedValue([]);

    const found = await service.findBySlackContext("C12345");

    expect(found).toBeUndefined();
  });

  it("updateInvestigationMetadata persists integration references", async () => {
    const created = await service.createInvestigation(createTestParams());

    await service.updateInvestigationMetadata(created.id, "slackCardTs", "123.456");

    const persisted = store.get(created.id);
    expect(persisted?.metadata.slackCardTs).toBe("123.456");
  });
});
