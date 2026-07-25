/**
 * Investigation Domain - Domain Events
 *
 * Defines all domain events that the Investigation aggregate can emit.
 * These are INTERNAL domain events — not API or HTTP events.
 *
 * Domain events drive:
 * - Timeline recording (via TimelineService)
 * - External notifications (via IEventBus consumers)
 * - Audit logging
 * - Cross-domain integration
 *
 * The union type InvestigationDomainEvent ensures exhaustive handling.
 */

import type { IDomainEvent } from "./interfaces.js";
import type {
  InvestigationId,
  EvidenceId,
  FindingId,
  RunbookId,
  ReportId,
} from "./types.js";
import type { InvestigationStatus } from "./InvestigationStatus.js";
import type { Trigger } from "./Trigger.js";

// --- Event Payloads ---

export interface InvestigationCreatedPayload {
  readonly title: string;
  readonly severity: string;
  readonly trigger: Trigger;
}

export interface InvestigationStartedPayload {
  readonly startedBy: string;
}

export interface StatusChangedPayload {
  readonly from: InvestigationStatus;
  readonly to: InvestigationStatus;
}

export interface EvidenceAddedPayload {
  readonly evidenceId: EvidenceId;
}

export interface FindingAddedPayload {
  readonly findingId: FindingId;
}

export interface RunbookAttachedPayload {
  readonly runbookId: RunbookId;
}

export interface ReportGeneratedPayload {
  readonly reportId: ReportId;
}

// --- Event Interfaces ---

export interface InvestigationCreatedEvent extends IDomainEvent {
  readonly eventType: "InvestigationCreated";
  readonly payload: InvestigationCreatedPayload;
}

export interface InvestigationStartedEvent extends IDomainEvent {
  readonly eventType: "InvestigationStarted";
  readonly payload: InvestigationStartedPayload;
}

export interface StatusChangedEvent extends IDomainEvent {
  readonly eventType: "StatusChanged";
  readonly payload: StatusChangedPayload;
}

export interface EvidenceAddedEvent extends IDomainEvent {
  readonly eventType: "EvidenceAdded";
  readonly payload: EvidenceAddedPayload;
}

export interface FindingAddedEvent extends IDomainEvent {
  readonly eventType: "FindingAdded";
  readonly payload: FindingAddedPayload;
}

export interface RunbookAttachedEvent extends IDomainEvent {
  readonly eventType: "RunbookAttached";
  readonly payload: RunbookAttachedPayload;
}

export interface ReportGeneratedEvent extends IDomainEvent {
  readonly eventType: "ReportGenerated";
  readonly payload: ReportGeneratedPayload;
}

export interface InvestigationCompletedEvent extends IDomainEvent {
  readonly eventType: "InvestigationCompleted";
  readonly payload: Record<string, never>;
}

export interface InvestigationArchivedEvent extends IDomainEvent {
  readonly eventType: "InvestigationArchived";
  readonly payload: Record<string, never>;
}

// --- Discriminated Union ---

export type InvestigationDomainEvent =
  | InvestigationCreatedEvent
  | InvestigationStartedEvent
  | StatusChangedEvent
  | EvidenceAddedEvent
  | FindingAddedEvent
  | RunbookAttachedEvent
  | ReportGeneratedEvent
  | InvestigationCompletedEvent
  | InvestigationArchivedEvent;
