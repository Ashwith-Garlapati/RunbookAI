/**
 * Investigation Domain - Timeline Service
 *
 * Manages the chronological record of events for each investigation.
 * Listens to domain events from the Investigation aggregate and records
 * corresponding timeline entries.
 *
 * Uses an in-memory Map as a write-through cache. If a repository is
 * provided, events are also persisted to MongoDB.
 */

import type { InvestigationId } from "./types.js";
import type { IDomainEvent } from "./interfaces.js";
import type { TimelineEventType } from "./TimelineEventType.js";
import { TimelineEvent } from "./TimelineEvent.js";

export interface ITimelineRepository {
  create(event: TimelineEvent): Promise<void>;
  findByInvestigationId(investigationId: InvestigationId): Promise<TimelineEvent[]>;
}

export class TimelineService {
  private readonly _events: Map<InvestigationId, TimelineEvent[]> = new Map();
  private readonly _repository: ITimelineRepository | undefined;

  constructor(repository?: ITimelineRepository) {
    this._repository = repository;
  }

  /**
   * Records a new timeline entry for an investigation.
   * Returns the created TimelineEvent for reference attachment.
   */
  record(params: {
    investigationId: InvestigationId;
    type: TimelineEventType;
    description: string;
    metadata?: Record<string, unknown>;
  }): TimelineEvent {
    const event = TimelineEvent.create(params);
    const events = this._events.get(params.investigationId) ?? [];
    events.push(event);
    this._events.set(params.investigationId, events);

    if (this._repository) {
      this._repository.create(event).catch((err) => {
        console.error("[TimelineService] Failed to persist timeline event:", err);
      });
    }

    return event;
  }

  /**
   * Records a timeline entry derived from a domain event.
   * Convenience method for the InvestigationService to bridge domain events
   * to the timeline. Accepts an optional payload for metadata.
   */
  recordFromDomainEvent(
    domainEvent: IDomainEvent & { readonly payload?: Record<string, unknown> },
    type: TimelineEventType,
    description: string,
  ): TimelineEvent {
    const eventPayload = domainEvent.payload;
    return this.record({
      investigationId: domainEvent.investigationId,
      type,
      description,
      ...(eventPayload !== undefined ? { metadata: eventPayload } : {}),
    });
  }

  /**
   * Returns the full chronological timeline for an investigation.
   */
  getTimeline(investigationId: InvestigationId): readonly TimelineEvent[] {
    return this._events.get(investigationId) ?? [];
  }

  /**
   * Returns just the IDs of timeline events for an investigation.
   * Used to sync with the Investigation aggregate's timelineEventIds.
   */
  getTimelineIds(investigationId: InvestigationId): string[] {
    return this.getTimeline(investigationId).map((e) => e.id);
  }

  /**
   * Checks whether a timeline exists for the given investigation.
   */
  hasTimeline(investigationId: InvestigationId): boolean {
    return this._events.has(investigationId);
  }
}
