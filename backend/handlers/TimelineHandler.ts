/**
 * Investigation Domain - Timeline Handler
 *
 * Listens to domain events and creates corresponding timeline entries.
 * This handler ensures all domain events are recorded in the investigation timeline
 * without requiring manual timeline creation in the InvestigationService.
 *
 * Design:
 * - Subscribes to all domain events via wildcard
 * - Maps domain event types to timeline event types
 * - Creates timeline entries with appropriate descriptions
 * - Stores timeline event IDs for later association with investigations
 */

import type { IDomainEvent, IEventHandler } from "../domains/investigation/interfaces.js";
import type { InvestigationId, TimelineEventId } from "../domains/investigation/types.js";
import { TimelineService } from "../domains/investigation/TimelineService.js";
import { TimelineEventType } from "../domains/investigation/TimelineEventType.js";

const EVENT_TO_TIMELINE_TYPE: Record<string, TimelineEventType> = {
  InvestigationCreated: TimelineEventType.InvestigationCreated,
  InvestigationStarted: TimelineEventType.StatusChanged,
  StatusChanged: TimelineEventType.StatusChanged,
  EvidenceAdded: TimelineEventType.EvidenceAdded,
  FindingAdded: TimelineEventType.FindingAdded,
  RunbookAttached: TimelineEventType.RunbookGenerated,
  ReportGenerated: TimelineEventType.ReportGenerated,
  InvestigationCompleted: TimelineEventType.Completed,
  InvestigationArchived: TimelineEventType.Archived,
};

export class TimelineHandler implements IEventHandler {
  private readonly _timelineService: TimelineService;
  private readonly _timelineEventIds: Map<InvestigationId, TimelineEventId[]> = new Map();

  constructor(timelineService: TimelineService) {
    this._timelineService = timelineService;
  }

  async handle(event: IDomainEvent): Promise<void> {
    const timelineType = EVENT_TO_TIMELINE_TYPE[event.eventType];
    if (!timelineType) {
      return;
    }

    const description = this.buildDescription(event);
    const metadata = this.extractMetadata(event);

    const timelineEvent = this._timelineService.record({
      investigationId: event.investigationId,
      type: timelineType,
      description,
      ...(metadata !== undefined ? { metadata } : {}),
    });

    console.log(
      `[Timeline] Created | investigation=${event.investigationId} | type=${timelineType}`,
    );

    const ids = this._timelineEventIds.get(event.investigationId) ?? [];
    ids.push(timelineEvent.id);
    this._timelineEventIds.set(event.investigationId, ids);
  }

  getTimelineEventIds(investigationId: InvestigationId): TimelineEventId[] {
    return this._timelineEventIds.get(investigationId) ?? [];
  }

  clearTimelineEventIds(investigationId: InvestigationId): void {
    this._timelineEventIds.delete(investigationId);
  }

  private buildDescription(event: IDomainEvent): string {
    const payload = event.payload as Record<string, unknown> | undefined;
    switch (event.eventType) {
      case "InvestigationCreated":
        return `Investigation created`;
      case "InvestigationStarted":
        return `Investigation started by ${payload?.startedBy ?? "system"}`;
      case "StatusChanged":
        return `Status changed to ${payload?.to ?? "unknown"}`;
      case "EvidenceAdded":
        return `Evidence ${payload?.evidenceId ?? ""} added`;
      case "FindingAdded":
        return `Finding "${payload?.title ?? ""}" added`;
      case "RunbookAttached":
        return `Runbook ${payload?.runbookId ?? ""} attached`;
      case "ReportGenerated":
        return `Report ${payload?.reportId ?? ""} generated`;
      case "InvestigationCompleted":
        return "Investigation completed";
      case "InvestigationArchived":
        return "Investigation archived";
      default:
        return `Event: ${event.eventType}`;
    }
  }

  private extractMetadata(event: IDomainEvent): Record<string, unknown> | undefined {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload && Object.keys(payload).length > 0) {
      return payload;
    }
    return undefined;
  }
}
