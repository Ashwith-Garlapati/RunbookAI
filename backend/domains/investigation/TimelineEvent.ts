/**
 * Investigation Domain - Timeline Event Value Object
 *
 * Represents a single entry in an investigation's chronological timeline.
 * Timeline events are immutable and record every significant occurrence:
 * creation, status changes, evidence additions, findings, and completions.
 *
 * The TimelineService creates these automatically when domain events are emitted.
 */

import { randomUUID } from "node:crypto";

import type { TimelineEventId, InvestigationId } from "./types.js";
import type { TimelineEventType } from "./TimelineEventType.js";

export interface TimelineEventProps {
  readonly id: TimelineEventId;
  readonly investigationId: InvestigationId;
  readonly type: TimelineEventType;
  readonly timestamp: Date;
  readonly description: string;
  readonly metadata: Record<string, unknown>;
}

export class TimelineEvent {
  readonly id: TimelineEventId;
  readonly investigationId: InvestigationId;
  readonly type: TimelineEventType;
  readonly timestamp: Date;
  readonly description: string;
  readonly metadata: Record<string, unknown>;

  private constructor(props: TimelineEventProps) {
    this.id = props.id;
    this.investigationId = props.investigationId;
    this.type = props.type;
    this.timestamp = props.timestamp;
    this.description = props.description;
    this.metadata = props.metadata;
  }

  /**
   * Creates a new TimelineEvent for an investigation.
   * Assigns a UUID and timestamps automatically.
   */
  static create(params: {
    investigationId: InvestigationId;
    type: TimelineEventType;
    description: string;
    metadata?: Record<string, unknown>;
  }): TimelineEvent {
    return new TimelineEvent({
      id: randomUUID(),
      investigationId: params.investigationId,
      type: params.type,
      timestamp: new Date(),
      description: params.description,
      metadata: params.metadata ?? {},
    });
  }

  /**
   * Reconstitutes a TimelineEvent from persisted data.
   */
  static reconstitute(props: TimelineEventProps): TimelineEvent {
    return new TimelineEvent(props);
  }
}
