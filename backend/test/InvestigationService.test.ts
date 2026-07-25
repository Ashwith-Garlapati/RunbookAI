import { describe, it, expect, beforeEach, vi } from "vitest";
import { InvestigationService } from "../domains/investigation/InvestigationService.js";
import { InvestigationStatus } from "../domains/investigation/InvestigationStatus.js";
import { Trigger } from "../domains/investigation/Trigger.js";
import { TriggerSource } from "../domains/investigation/TriggerSource.js";
import { TriggerType } from "../domains/investigation/TriggerType.js";
import { TimelineService } from "../domains/investigation/TimelineService.js";
import { InProcessEventBus } from "../infrastructure/InProcessEventBus.js";
import { Finding } from "../domains/investigation/Finding.js";
import { InvestigationReport } from "../domains/investigation/InvestigationReport.js";
import { RunbookReference } from "../domains/investigation/RunbookReference.js";
import type { Investigation } from "../domains/investigation/Investigation.js";
import type { IInvestigationRepository } from "../domains/investigation/InvestigationRepository.js";
import type {
  IFindingRepository,
  IReportRepository,
  IRunbookReferenceRepository,
} from "../domains/investigation/RepositoryInterfaces.js";

function createTestTrigger() {
  return Trigger.create({
    source: TriggerSource.Slack,
    type: TriggerType.SlashCommand,
    actor: "U12345",
    payload: { channel: "C12345" },
  });
}

function createMockRepository(): IInvestigationRepository {
  const store = new Map<string, Investigation>();
  return {
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
    delete: vi.fn(async () => {}),
  };
}

function createMockFindingRepository(): IFindingRepository {
  return {
    create: vi.fn(async () => {}),
    findById: vi.fn(async () => null),
    findByInvestigationId: vi.fn(async () => []),
  };
}

function createMockReportRepository(): IReportRepository {
  return {
    create: vi.fn(async () => {}),
    findById: vi.fn(async () => null),
    findByInvestigationId: vi.fn(async () => null),
  };
}

function createMockRunbookReferenceRepository(): IRunbookReferenceRepository {
  return {
    create: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    findById: vi.fn(async () => null),
    findByInvestigationId: vi.fn(async () => null),
  };
}

describe("InvestigationService", () => {
  let service: InvestigationService;
  let repository: IInvestigationRepository;
  let eventBus: InProcessEventBus;
  let timelineService: TimelineService;
  let findingRepository: IFindingRepository;
  let reportRepository: IReportRepository;
  let runbookReferenceRepository: IRunbookReferenceRepository;

  beforeEach(() => {
    repository = createMockRepository();
    eventBus = new InProcessEventBus();
    timelineService = new TimelineService();
    findingRepository = createMockFindingRepository();
    reportRepository = createMockReportRepository();
    runbookReferenceRepository = createMockRunbookReferenceRepository();

    service = new InvestigationService(
      repository,
      eventBus,
      timelineService,
      findingRepository,
      reportRepository,
      runbookReferenceRepository,
    );
  });

  describe("createInvestigation", () => {
    it("creates an investigation", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      expect(investigation.title).toBe("Test Investigation");
      expect(investigation.status).toBe(InvestigationStatus.Draft);
      expect(repository.create).toHaveBeenCalled();
    });

    it("records a timeline event", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      const timeline = timelineService.getTimeline(investigation.id);
      expect(timeline).toHaveLength(1);
      const firstEvent = timeline[0];
      expect(firstEvent).toBeDefined();
      expect(firstEvent!.type).toBe("investigation_created");
    });

    it("publishes domain events", async () => {
      const events: any[] = [];
      eventBus.subscribe("InvestigationCreated", {
        handle: vi.fn(async (event) => {
          events.push(event);
        }),
      });

      await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("InvestigationCreated");
    });
  });

  describe("startInvestigation", () => {
    it("transitions to CollectingEvidence", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      const started = await service.startInvestigation(investigation.id, "U12345");

      expect(started.status).toBe(InvestigationStatus.CollectingEvidence);
      expect(started.startedAt).toBeInstanceOf(Date);
    });

    it("publishes InvestigationStarted event", async () => {
      const events: any[] = [];
      eventBus.subscribe("InvestigationStarted", {
        handle: vi.fn(async (event) => {
          events.push(event);
        }),
      });

      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      await service.startInvestigation(investigation.id, "U12345");

      expect(events).toHaveLength(1);
      expect(events[0].payload.startedBy).toBe("U12345");
    });

    it("throws if investigation not found", async () => {
      await expect(
        service.startInvestigation("nonexistent" as any),
      ).rejects.toThrow("Investigation not found");
    });
  });

  describe("changeStatus", () => {
    it("transitions through lifecycle", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      await service.changeStatus(investigation.id, InvestigationStatus.CollectingEvidence);
      await service.changeStatus(investigation.id, InvestigationStatus.Analyzing);
      await service.changeStatus(investigation.id, InvestigationStatus.GeneratingFindings);
      await service.changeStatus(investigation.id, InvestigationStatus.GeneratingRunbook);
      await service.changeStatus(investigation.id, InvestigationStatus.WaitingApproval);
      await service.changeStatus(investigation.id, InvestigationStatus.Completed);
      await service.changeStatus(investigation.id, InvestigationStatus.Archived);

      const updated = await service.getInvestigation(investigation.id);
      expect(updated.status).toBe(InvestigationStatus.Archived);
    });

    it("rejects invalid transitions", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      await expect(
        service.changeStatus(investigation.id, InvestigationStatus.Completed),
      ).rejects.toThrow("Invalid transition");
    });
  });

  describe("attachEvidence", () => {
    it("attaches evidence to investigation", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      const updated = await service.attachEvidence(investigation.id, "ev-1" as any);

      expect(updated.evidenceIds).toContain("ev-1");
    });

    it("records EvidenceAdded timeline event", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      await service.attachEvidence(investigation.id, "ev-1" as any);

      const timeline = timelineService.getTimeline(investigation.id);
      const evidenceEvent = timeline.find((e) => e.type === "evidence_added");
      expect(evidenceEvent).toBeDefined();
    });
  });

  describe("addFinding", () => {
    it("creates and attaches a finding", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      const { investigation: updated, finding } = await service.addFinding(investigation.id, {
        title: "Test Finding",
        summary: "Finding summary",
        confidence: 0.85,
        reasoning: "Because reasons",
        recommendation: "Fix this",
      });

      expect(updated.findingIds).toContain(finding.id);
      expect(finding.title).toBe("Test Finding");
      expect(finding.confidence).toBe(0.85);
    });

    it("persists finding to repository", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      await service.addFinding(investigation.id, {
        title: "Test Finding",
        summary: "Finding summary",
        confidence: 0.85,
        reasoning: "Because reasons",
        recommendation: "Fix this",
      });

      expect(findingRepository.create).toHaveBeenCalled();
    });
  });

  describe("attachRunbook", () => {
    it("creates and attaches a runbook reference", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      const { investigation: updated, runbook } = await service.attachRunbook(
        investigation.id,
        { githubUrl: "https://github.com/example/runbook" },
      );

      expect(updated.runbookId).toBe(runbook.id);
      expect(runbook.githubUrl).toBe("https://github.com/example/runbook");
    });

    it("persists runbook reference to repository", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      await service.attachRunbook(investigation.id);

      expect(runbookReferenceRepository.create).toHaveBeenCalled();
    });
  });

  describe("generateReport", () => {
    it("generates and attaches a report", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      const { investigation: updated, report } = await service.generateReport(
        investigation.id,
        {
          summary: "Investigation summary",
          recommendations: ["Fix the thing", "Monitor the other thing"],
        },
      );

      expect(updated.reportId).toBe(report.id);
      expect(report.summary).toBe("Investigation summary");
      expect(report.recommendations).toEqual([
        "Fix the thing",
        "Monitor the other thing",
      ]);
    });

    it("includes timeline in report", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      const { report } = await service.generateReport(investigation.id, {
        summary: "Summary",
        recommendations: [],
      });

      expect(report.timeline).toBeInstanceOf(Array);
      expect(report.timeline.length).toBeGreaterThan(0);
    });
  });

  describe("complete", () => {
    it("transitions to Completed status", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      await service.changeStatus(investigation.id, InvestigationStatus.CollectingEvidence);
      await service.changeStatus(investigation.id, InvestigationStatus.Analyzing);
      await service.changeStatus(investigation.id, InvestigationStatus.GeneratingFindings);
      await service.changeStatus(investigation.id, InvestigationStatus.GeneratingRunbook);
      await service.changeStatus(investigation.id, InvestigationStatus.WaitingApproval);

      const completed = await service.complete(investigation.id);

      expect(completed.status).toBe(InvestigationStatus.Completed);
      expect(completed.completedAt).toBeInstanceOf(Date);
    });

    it("publishes InvestigationCompleted event", async () => {
      const events: any[] = [];
      eventBus.subscribe("InvestigationCompleted", {
        handle: vi.fn(async (event) => {
          events.push(event);
        }),
      });

      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      await service.changeStatus(investigation.id, InvestigationStatus.CollectingEvidence);
      await service.changeStatus(investigation.id, InvestigationStatus.Analyzing);
      await service.changeStatus(investigation.id, InvestigationStatus.GeneratingFindings);
      await service.changeStatus(investigation.id, InvestigationStatus.GeneratingRunbook);
      await service.changeStatus(investigation.id, InvestigationStatus.WaitingApproval);

      await service.complete(investigation.id);

      expect(events).toHaveLength(1);
    });
  });

  describe("archive", () => {
    it("transitions to Archived status", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      await service.changeStatus(investigation.id, InvestigationStatus.CollectingEvidence);
      await service.changeStatus(investigation.id, InvestigationStatus.Analyzing);
      await service.changeStatus(investigation.id, InvestigationStatus.GeneratingFindings);
      await service.changeStatus(investigation.id, InvestigationStatus.GeneratingRunbook);
      await service.changeStatus(investigation.id, InvestigationStatus.WaitingApproval);
      await service.complete(investigation.id);

      const archived = await service.archive(investigation.id);

      expect(archived.status).toBe(InvestigationStatus.Archived);
    });

    it("publishes InvestigationArchived event", async () => {
      const events: any[] = [];
      eventBus.subscribe("InvestigationArchived", {
        handle: vi.fn(async (event) => {
          events.push(event);
        }),
      });

      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      await service.changeStatus(investigation.id, InvestigationStatus.CollectingEvidence);
      await service.changeStatus(investigation.id, InvestigationStatus.Analyzing);
      await service.changeStatus(investigation.id, InvestigationStatus.GeneratingFindings);
      await service.changeStatus(investigation.id, InvestigationStatus.GeneratingRunbook);
      await service.changeStatus(investigation.id, InvestigationStatus.WaitingApproval);
      await service.complete(investigation.id);

      await service.archive(investigation.id);

      expect(events).toHaveLength(1);
    });
  });

  describe("query methods", () => {
    it("getInvestigation returns investigation by ID", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      const fetched = await service.getInvestigation(investigation.id);
      expect(fetched.id).toBe(investigation.id);
    });

    it("getInvestigation throws if not found", async () => {
      await expect(
        service.getInvestigation("nonexistent" as any),
      ).rejects.toThrow("Investigation not found");
    });

    it("getTimeline returns timeline events", async () => {
      const investigation = await service.createInvestigation({
        title: "Test Investigation",
        description: "Test description",
        severity: "high",
        trigger: createTestTrigger(),
        createdBy: "U12345",
      });

      const timeline = await service.getTimeline(investigation.id);
      expect(timeline).toHaveLength(1);
    });
  });
});
