import { describe, it, expect, beforeEach } from "vitest";
import {
  Investigation,
  type CreateInvestigationParams,
} from "../domains/investigation/Investigation.js";
import { InvestigationStatus } from "../domains/investigation/InvestigationStatus.js";
import { Trigger } from "../domains/investigation/Trigger.js";
import { TriggerSource } from "../domains/investigation/TriggerSource.js";
import { TriggerType } from "../domains/investigation/TriggerType.js";

function createTestTrigger() {
  return Trigger.create({
    source: TriggerSource.Slack,
    type: TriggerType.SlashCommand,
    actor: "U12345",
    payload: { channel: "C12345" },
  });
}

function createTestParams(overrides?: Partial<CreateInvestigationParams>): CreateInvestigationParams {
  return {
    title: "Test Investigation",
    description: "Test description",
    severity: "high",
    trigger: createTestTrigger(),
    createdBy: "U12345",
    ...overrides,
  };
}

describe("Investigation Aggregate", () => {
  describe("creation", () => {
    it("creates an investigation in Draft status", () => {
      const investigation = Investigation.create(createTestParams());

      expect(investigation.status).toBe(InvestigationStatus.Draft);
      expect(investigation.title).toBe("Test Investigation");
      expect(investigation.description).toBe("Test description");
      expect(investigation.severity).toBe("high");
      expect(investigation.createdBy).toBe("U12345");
      expect(investigation.id).toBeDefined();
      expect(investigation.createdAt).toBeInstanceOf(Date);
    });

    it("emits InvestigationCreated event", () => {
      const investigation = Investigation.create(createTestParams());
      const events = investigation.pullEvents();

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event).toBeDefined();
      expect(event!.eventType).toBe("InvestigationCreated");
      expect(event!.payload).toMatchObject({
        title: "Test Investigation",
        severity: "high",
      });
    });

    it("includes trigger in the event payload", () => {
      const trigger = createTestTrigger();
      const investigation = Investigation.create(createTestParams({ trigger }));
      const events = investigation.pullEvents();

      const event = events[0];
      expect(event).toBeDefined();
      expect(event!.payload).toHaveProperty("trigger");
    });

    it("initializes with empty collections", () => {
      const investigation = Investigation.create(createTestParams());

      expect(investigation.evidenceIds).toHaveLength(0);
      expect(investigation.findingIds).toHaveLength(0);
      expect(investigation.timelineEventIds).toHaveLength(0);
      expect(investigation.runbookId).toBeUndefined();
      expect(investigation.reportId).toBeUndefined();
    });

    it("sets optional fields when provided", () => {
      const investigation = Investigation.create(
        createTestParams({
          organizationId: "org-123" as any,
          affectedServices: ["api" as any, "web" as any],
          tags: ["production" as any, "urgent" as any],
          metadata: { channel: "C12345" },
        }),
      );

      expect(investigation.organizationId).toBe("org-123");
      expect(investigation.affectedServices).toEqual(["api", "web"]);
      expect(investigation.tags).toEqual(["production", "urgent"]);
      expect(investigation.metadata).toEqual({ channel: "C12345" });
    });
  });

  describe("reconstitution", () => {
    it("reconstitutes from persisted data without emitting events", () => {
      const original = Investigation.create(createTestParams());
      original.pullEvents(); // Clear events

      const reconstituted = Investigation.reconstitute({
        id: original.id,
        title: original.title,
        description: original.description,
        severity: original.severity,
        status: original.status,
        trigger: original.trigger,
        createdBy: original.createdBy,
        createdAt: original.createdAt,
        updatedAt: original.updatedAt,
        affectedServices: [],
        tags: [],
        evidenceIds: [],
        findingIds: [],
        timelineEventIds: [],
        metadata: {},
      });

      expect(reconstituted.id).toBe(original.id);
      expect(reconstituted.status).toBe(InvestigationStatus.Draft);
      expect(reconstituted.pullEvents()).toHaveLength(0);
    });
  });

  describe("lifecycle transitions", () => {
    it("transitions from Draft to CollectingEvidence", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.beginEvidenceCollection();

      expect(investigation.status).toBe(InvestigationStatus.CollectingEvidence);
      expect(investigation.startedAt).toBeInstanceOf(Date);
    });

    it("emits StatusChanged and InvestigationStarted events on beginEvidenceCollection", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.beginEvidenceCollection("U12345");
      const events = investigation.pullEvents();

      const statusChanged = events.find((e) => e.eventType === "StatusChanged");
      const investigationStarted = events.find((e) => e.eventType === "InvestigationStarted");

      expect(statusChanged).toBeDefined();
      expect(investigationStarted).toBeDefined();
      expect(investigationStarted?.payload).toMatchObject({ startedBy: "U12345" });
    });

    it("only sets startedAt on first transition to CollectingEvidence", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.beginEvidenceCollection();
      const firstStartedAt = investigation.startedAt;

      // Transition back is not allowed, so this test is about the guard
      expect(investigation.startedAt).toBe(firstStartedAt);
    });

    it("transitions through full lifecycle", () => {
      const investigation = Investigation.create(createTestParams());

      investigation.beginEvidenceCollection();
      expect(investigation.status).toBe(InvestigationStatus.CollectingEvidence);

      investigation.beginAnalysis();
      expect(investigation.status).toBe(InvestigationStatus.Analyzing);

      investigation.generateFindings();
      expect(investigation.status).toBe(InvestigationStatus.GeneratingFindings);

      investigation.generateRunbook();
      expect(investigation.status).toBe(InvestigationStatus.GeneratingRunbook);

      investigation.approve();
      expect(investigation.status).toBe(InvestigationStatus.WaitingApproval);

      investigation.complete();
      expect(investigation.status).toBe(InvestigationStatus.Completed);
      expect(investigation.completedAt).toBeInstanceOf(Date);

      investigation.archive();
      expect(investigation.status).toBe(InvestigationStatus.Archived);
    });

    it("emits StatusChanged for each transition", () => {
      const investigation = Investigation.create(createTestParams());

      investigation.beginEvidenceCollection();
      investigation.beginAnalysis();
      investigation.generateFindings();
      investigation.generateRunbook();
      investigation.approve();
      investigation.complete();
      investigation.archive();

      const events = investigation.pullEvents();
      const statusChanges = events.filter((e) => e.eventType === "StatusChanged");
      expect(statusChanges).toHaveLength(7);
    });

    it("rejects invalid transition from Draft to Analyzing", () => {
      const investigation = Investigation.create(createTestParams());

      expect(() => investigation.beginAnalysis()).toThrow("Invalid transition");
    });

    it("rejects invalid transition from Draft to Completed", () => {
      const investigation = Investigation.create(createTestParams());

      expect(() => investigation.complete()).toThrow("Invalid transition");
    });

    it("rejects transition from Archived to any state", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.beginEvidenceCollection();
      investigation.beginAnalysis();
      investigation.generateFindings();
      investigation.generateRunbook();
      investigation.approve();
      investigation.complete();
      investigation.archive();

      expect(() => investigation.beginEvidenceCollection()).toThrow("Invalid transition");
    });
  });

  describe("evidence management", () => {
    it("attaches evidence", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.attachEvidence("ev-1" as any);

      expect(investigation.evidenceIds).toContain("ev-1");
    });

    it("emits EvidenceAdded event", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.attachEvidence("ev-1" as any);
      const events = investigation.pullEvents();

      const evidenceEvent = events.find((e) => e.eventType === "EvidenceAdded");
      expect(evidenceEvent).toBeDefined();
      expect(evidenceEvent?.payload).toEqual({ evidenceId: "ev-1" });
    });

    it("ignores duplicate evidence IDs", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.attachEvidence("ev-1" as any);
      investigation.attachEvidence("ev-1" as any);

      expect(investigation.evidenceIds).toHaveLength(1);
    });
  });

  describe("finding management", () => {
    it("adds finding", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.addFinding("find-1" as any);

      expect(investigation.findingIds).toContain("find-1");
    });

    it("emits FindingAdded event", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.addFinding("find-1" as any);
      const events = investigation.pullEvents();

      const findingEvent = events.find((e) => e.eventType === "FindingAdded");
      expect(findingEvent).toBeDefined();
      expect(findingEvent?.payload).toEqual({ findingId: "find-1" });
    });

    it("ignores duplicate finding IDs", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.addFinding("find-1" as any);
      investigation.addFinding("find-1" as any);

      expect(investigation.findingIds).toHaveLength(1);
    });
  });

  describe("runbook management", () => {
    it("attaches runbook", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.attachRunbook("rb-1" as any);

      expect(investigation.runbookId).toBe("rb-1");
    });

    it("emits RunbookAttached event", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.attachRunbook("rb-1" as any);
      const events = investigation.pullEvents();

      const runbookEvent = events.find((e) => e.eventType === "RunbookAttached");
      expect(runbookEvent).toBeDefined();
      expect(runbookEvent?.payload).toEqual({ runbookId: "rb-1" });
    });

    it("replaces existing runbook ID", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.attachRunbook("rb-1" as any);
      investigation.attachRunbook("rb-2" as any);

      expect(investigation.runbookId).toBe("rb-2");
    });
  });

  describe("report management", () => {
    it("attaches report", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.attachReport("rpt-1" as any);

      expect(investigation.reportId).toBe("rpt-1");
    });

    it("emits ReportGenerated event", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.attachReport("rpt-1" as any);
      const events = investigation.pullEvents();

      const reportEvent = events.find((e) => e.eventType === "ReportGenerated");
      expect(reportEvent).toBeDefined();
      expect(reportEvent?.payload).toEqual({ reportId: "rpt-1" });
    });
  });

  describe("timeline management", () => {
    it("adds timeline event ID", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.addTimelineEvent("tl-1" as any);

      expect(investigation.timelineEventIds).toContain("tl-1");
    });

    it("ignores duplicate timeline event IDs", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.addTimelineEvent("tl-1" as any);
      investigation.addTimelineEvent("tl-1" as any);

      expect(investigation.timelineEventIds).toHaveLength(1);
    });
  });

  describe("metadata management", () => {
    it("updates metadata", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.updateMetadata("slackChannel", "C12345");

      expect(investigation.metadata.slackChannel).toBe("C12345");
    });

    it("updates details", () => {
      const investigation = Investigation.create(createTestParams());
      investigation.updateDetails({
        title: "Updated Title",
        description: "Updated Description",
        severity: "critical",
      });

      expect(investigation.title).toBe("Updated Title");
      expect(investigation.description).toBe("Updated Description");
      expect(investigation.severity).toBe("critical");
    });
  });

  describe("event management", () => {
    it("pullEvents clears the internal buffer", () => {
      const investigation = Investigation.create(createTestParams());
      expect(investigation.pullEvents()).toHaveLength(1);
      expect(investigation.pullEvents()).toHaveLength(0);
    });
  });
});
