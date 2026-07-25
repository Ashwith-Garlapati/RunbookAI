import { describe, it, expect, vi, beforeEach } from "vitest";
import { TimelineHandler } from "../handlers/TimelineHandler.js";
import { LoggingHandler } from "../handlers/LoggingHandler.js";
import { AuditEventHandler } from "../handlers/AuditEventHandler.js";
import { TimelineService } from "../domains/investigation/TimelineService.js";
import type { IDomainEvent } from "../domains/investigation/interfaces.js";

function createTestEvent(
  eventType: string,
  investigationId: string = "inv-1",
  payload?: Record<string, unknown>,
): IDomainEvent {
  return {
    eventId: "evt-1",
    eventType,
    occurredAt: new Date(),
    investigationId: investigationId as any,
    payload: payload ?? {},
  };
}

describe("TimelineHandler", () => {
  let handler: TimelineHandler;
  let timelineService: TimelineService;

  beforeEach(() => {
    timelineService = new TimelineService();
    handler = new TimelineHandler(timelineService);
  });

  it("records timeline event for InvestigationCreated", async () => {
    const event = createTestEvent("InvestigationCreated", "inv-1", {
      title: "Test",
      severity: "high",
    });

    await handler.handle(event);

    const timeline = timelineService.getTimeline("inv-1" as any);
    expect(timeline).toHaveLength(1);
    const firstEvent = timeline[0];
    expect(firstEvent).toBeDefined();
    expect(firstEvent!.type).toBe("investigation_created");
  });

  it("records timeline event for StatusChanged", async () => {
    const event = createTestEvent("StatusChanged", "inv-1", {
      from: "draft",
      to: "collecting_evidence",
    });

    await handler.handle(event);

    const timeline = timelineService.getTimeline("inv-1" as any);
    expect(timeline).toHaveLength(1);
    const firstEvent = timeline[0];
    expect(firstEvent).toBeDefined();
    expect(firstEvent!.type).toBe("status_changed");
  });

  it("records timeline event for EvidenceAdded", async () => {
    const event = createTestEvent("EvidenceAdded", "inv-1", {
      evidenceId: "ev-1",
    });

    await handler.handle(event);

    const timeline = timelineService.getTimeline("inv-1" as any);
    expect(timeline).toHaveLength(1);
    const firstEvent = timeline[0];
    expect(firstEvent).toBeDefined();
    expect(firstEvent!.type).toBe("evidence_added");
  });

  it("records timeline event for FindingAdded", async () => {
    const event = createTestEvent("FindingAdded", "inv-1", {
      findingId: "find-1",
      title: "Test Finding",
    });

    await handler.handle(event);

    const timeline = timelineService.getTimeline("inv-1" as any);
    expect(timeline).toHaveLength(1);
    const firstEvent = timeline[0];
    expect(firstEvent).toBeDefined();
    expect(firstEvent!.type).toBe("finding_added");
  });

  it("records timeline event for RunbookAttached", async () => {
    const event = createTestEvent("RunbookAttached", "inv-1", {
      runbookId: "rb-1",
    });

    await handler.handle(event);

    const timeline = timelineService.getTimeline("inv-1" as any);
    expect(timeline).toHaveLength(1);
    const firstEvent = timeline[0];
    expect(firstEvent).toBeDefined();
    expect(firstEvent!.type).toBe("runbook_generated");
  });

  it("records timeline event for ReportGenerated", async () => {
    const event = createTestEvent("ReportGenerated", "inv-1", {
      reportId: "rpt-1",
    });

    await handler.handle(event);

    const timeline = timelineService.getTimeline("inv-1" as any);
    expect(timeline).toHaveLength(1);
    const firstEvent = timeline[0];
    expect(firstEvent).toBeDefined();
    expect(firstEvent!.type).toBe("report_generated");
  });

  it("records timeline event for InvestigationCompleted", async () => {
    const event = createTestEvent("InvestigationCompleted", "inv-1");

    await handler.handle(event);

    const timeline = timelineService.getTimeline("inv-1" as any);
    expect(timeline).toHaveLength(1);
    const firstEvent = timeline[0];
    expect(firstEvent).toBeDefined();
    expect(firstEvent!.type).toBe("completed");
  });

  it("records timeline event for InvestigationArchived", async () => {
    const event = createTestEvent("InvestigationArchived", "inv-1");

    await handler.handle(event);

    const timeline = timelineService.getTimeline("inv-1" as any);
    expect(timeline).toHaveLength(1);
    const firstEvent = timeline[0];
    expect(firstEvent).toBeDefined();
    expect(firstEvent!.type).toBe("archived");
  });

  it("ignores unknown event types", async () => {
    const event = createTestEvent("UnknownEvent", "inv-1");

    await handler.handle(event);

    const timeline = timelineService.getTimeline("inv-1" as any);
    expect(timeline).toHaveLength(0);
  });

  it("tracks timeline event IDs", async () => {
    const event = createTestEvent("InvestigationCreated", "inv-1");

    await handler.handle(event);

    const ids = handler.getTimelineEventIds("inv-1" as any);
    expect(ids).toHaveLength(1);
  });

  it("clears timeline event IDs", async () => {
    const event = createTestEvent("InvestigationCreated", "inv-1");
    await handler.handle(event);

    handler.clearTimelineEventIds("inv-1" as any);
    const ids = handler.getTimelineEventIds("inv-1" as any);
    expect(ids).toHaveLength(0);
  });
});

describe("LoggingHandler", () => {
  let handler: LoggingHandler;

  beforeEach(() => {
    handler = new LoggingHandler();
  });

  it("logs event to console", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const event = createTestEvent("InvestigationCreated", "inv-1", {
      title: "Test",
    });

    await handler.handle(event);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[DomainEvent] InvestigationCreated"),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("investigation=inv-1"),
    );

    consoleSpy.mockRestore();
  });
});

describe("AuditEventHandler", () => {
  let handler: AuditEventHandler;

  beforeEach(() => {
    handler = new AuditEventHandler();
  });

  it("logs audit event to console", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const event = createTestEvent("InvestigationCreated", "inv-1");

    await handler.handle(event);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Audit] InvestigationCreated"),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("investigation=inv-1"),
    );

    consoleSpy.mockRestore();
  });
});
