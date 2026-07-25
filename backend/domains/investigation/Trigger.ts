/**
 * Investigation Domain - Trigger Value Object
 *
 * Represents the origin of an investigation. Every investigation begins with
 * a Trigger that captures which external system initiated it, what type of
 * event occurred, who triggered it, and the raw payload from the source.
 *
 * Triggers are immutable once created. They are the contract between
 * external integrations (Slack, GitHub, SigNoz, etc.) and the Investigation domain.
 */

import { randomUUID } from "node:crypto";

import type { TriggerId } from "./types.js";
import type { TriggerSource } from "./TriggerSource.js";
import type { TriggerType } from "./TriggerType.js";

export interface TriggerProps {
  readonly id: TriggerId;
  readonly source: TriggerSource;
  readonly type: TriggerType;
  readonly actor: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: Date;
  readonly metadata: Record<string, unknown>;
}

export class Trigger {
  readonly id: TriggerId;
  readonly source: TriggerSource;
  readonly type: TriggerType;
  readonly actor: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: Date;
  readonly metadata: Record<string, unknown>;

  private constructor(props: TriggerProps) {
    this.id = props.id;
    this.source = props.source;
    this.type = props.type;
    this.actor = props.actor;
    this.payload = props.payload;
    this.timestamp = props.timestamp;
    this.metadata = props.metadata;
  }

  /**
   * Creates a new Trigger from integration parameters.
   * Assigns a UUID and timestamps automatically.
   */
  static create(params: {
    source: TriggerSource;
    type: TriggerType;
    actor: string;
    payload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Trigger {
    return new Trigger({
      id: randomUUID(),
      source: params.source,
      type: params.type,
      actor: params.actor,
      payload: params.payload ?? {},
      timestamp: new Date(),
      metadata: params.metadata ?? {},
    });
  }

  /**
   * Reconstitutes a Trigger from persisted data.
   */
  static reconstitute(props: TriggerProps): Trigger {
    return new Trigger(props);
  }
}
