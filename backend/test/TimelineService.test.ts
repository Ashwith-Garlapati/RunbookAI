import { describe, it, expect, beforeEach, vi } from "vitest";
import { TimelineService } from "../domains/investigation/TimelineService.js";
import { TimelineEventType } from "../domains/investigation/TimelineEventType.js";

describe("TimelineService", () => {
  let service: TimelineService;

  beforeEach(() => {
    service = new TimelineService();
  });

  describe("record", () => {
    it("records a timeline event", () => {
      const event = service.record({
        investigationId: "inv-1" as any,
        type: TimelineEventType.InvestigationCreated,
        description: "Investigation created",
      });

      expect(event.id).toBeDefined();
      expect(event.investigationId).toBe("inv-1");
      expect(event.type).toBe(TimelineEventType.InvestigationCreated);
      expect(event.description).toBe("Investigation created");
      expect(event.timestamp).toBeInstanceOf(Date);
    });

    it("includes metadata when provided", () => {
      const event = service.record({
        investigationId: "inv-1" as any,
        type: TimelineEventType.StatusChanged,
        description: "Status changed",
        metadata: { from: "draft", to: "collecting_evidence" },
      });

      expect(event.metadata).toEqual({ from: "draft", to: "collecting_evidence" });
    });

    it("stores events in chronological order", () => {
      service.record({
        investigationId: "inv-1" as any,
        type: TimelineEventType.InvestigationCreated,
        description: "First event",
      });
      service.record({
        investigationId: "inv-1" as any,
        type: TimelineEventType.StatusChanged,
        description: "Second event",
      });

      const timeline = service.getTimeline("inv-1" as any);
      expect(timeline).toHaveLength(2);
      const firstEvent = timeline[0];
      const secondEvent = timeline[1];
      expect(firstEvent).toBeDefined();
      expect(secondEvent).toBeDefined();
      expect(firstEvent!.description).toBe("First event");
      expect(secondEvent!.description).toBe("Second event");
    });

    it("isolates timelines by investigation ID", () => {
      service.record({
        investigationId: "inv-1" as any,
        type: TimelineEventType.InvestigationCreated,
        description: "Event for inv-1",
      });
      service.record({
        investigationId: "inv-2" as any,
        type: TimelineEventType.InvestigationCreated,
        description: "Event for inv-2",
      });

      expect(service.getTimeline("inv-1" as any)).toHaveLength(1);
      expect(service.getTimeline("inv-2" as any)).toHaveLength(1);
    });
  });

  describe("recordFromDomainEvent", () => {
    it("creates timeline event from domain event", () => {
      const domainEvent = {
        eventId: "evt-1",
        eventType: "StatusChanged",
        occurredAt: new Date(),
        investigationId: "inv-1" as any,
        payload: { from: "draft", to: "collecting_evidence" },
      };

      const event = service.recordFromDomainEvent(
        domainEvent,
        TimelineEventType.StatusChanged,
        "Status changed to collecting_evidence",
      );

      expect(event.investigationId).toBe("inv-1");
      expect(event.type).toBe(TimelineEventType.StatusChanged);
      expect(event.metadata).toEqual({
        from: "draft",
        to: "collecting_evidence",
      });
    });
  });

  describe("getTimeline", () => {
    it("returns empty array for unknown investigation", () => {
      const timeline = service.getTimeline("unknown" as any);
      expect(timeline).toEqual([]);
    });
  });

  describe("getTimelineIds", () => {
    it("returns IDs of timeline events", () => {
      const event1 = service.record({
        investigationId: "inv-1" as any,
        type: TimelineEventType.InvestigationCreated,
        description: "First",
      });
      const event2 = service.record({
        investigationId: "inv-1" as any,
        type: TimelineEventType.StatusChanged,
        description: "Second",
      });

      const ids = service.getTimelineIds("inv-1" as any);
      expect(ids).toEqual([event1.id, event2.id]);
    });
  });

  describe("hasTimeline", () => {
    it("returns false for unknown investigation", () => {
      expect(service.hasTimeline("unknown" as any)).toBe(false);
    });

    it("returns true after recording an event", () => {
      service.record({
        investigationId: "inv-1" as any,
        type: TimelineEventType.InvestigationCreated,
        description: "Event",
      });

      expect(service.hasTimeline("inv-1" as any)).toBe(true);
    });
  });
});
