/**
 * Investigation Domain - Barrel Exports
 *
 * Single import point for the entire Investigation bounded context.
 * Consumers should import from this module:
 *
 *   import { Investigation, InvestigationService, TriggerSource } from "./domains/investigation/index.js";
 */

// --- Core Types & Interfaces ---
export type {
  InvestigationId,
  OrganizationId,
  EvidenceId,
  FindingId,
  RunbookId,
  ReportId,
  TimelineEventId,
  TriggerId,
  UserId,
  ServiceName,
  Tag,
} from "./types.js";

export type {
  IDomainEvent,
  IEventBus,
  IEventHandler,
} from "./interfaces.js";

// --- Enums ---
export { TriggerSource } from "./TriggerSource.js";
export { TriggerType } from "./TriggerType.js";
export { TimelineEventType } from "./TimelineEventType.js";
export { EvidenceSource } from "./EvidenceSource.js";
export {
  InvestigationStatus,
  canTransition,
  isActive,
  validateTransition,
  InvalidTransitionError,
} from "./InvestigationStatus.js";

// --- Value Objects & Entities ---
export { Trigger } from "./Trigger.js";
export type { TriggerProps } from "./Trigger.js";

export { TimelineEvent } from "./TimelineEvent.js";
export type { TimelineEventProps } from "./TimelineEvent.js";

export { Finding, FindingStatus } from "./Finding.js";
export type { FindingProps } from "./Finding.js";

export { RunbookReference, RunbookStatus } from "./RunbookReference.js";
export type { RunbookReferenceProps } from "./RunbookReference.js";

export { InvestigationReport } from "./InvestigationReport.js";
export type { InvestigationReportProps } from "./InvestigationReport.js";

// --- Evidence (Placeholder Interfaces) ---
export type { Evidence, EvidenceMetadata } from "./Evidence.js";
export type { EvidenceReference } from "./EvidenceReference.js";
export { EvidenceItem } from "./EvidenceItem.js";

// --- Domain Events ---
export type {
  InvestigationDomainEvent,
  InvestigationCreatedEvent,
  InvestigationStartedEvent,
  StatusChangedEvent,
  EvidenceAddedEvent,
  FindingAddedEvent,
  RunbookAttachedEvent,
  ReportGeneratedEvent,
  InvestigationCompletedEvent,
  InvestigationArchivedEvent,
} from "./InvestigationEvents.js";

// --- Aggregate Root ---
export { Investigation } from "./Investigation.js";
export type { InvestigationProps, CreateInvestigationParams } from "./Investigation.js";

// --- Repository Interfaces ---
export type { IInvestigationRepository } from "./InvestigationRepository.js";
export type {
  IEvidenceRepository,
  IFindingRepository,
  IReportRepository,
  IRunbookReferenceRepository,
} from "./RepositoryInterfaces.js";

// --- Services ---
export { InvestigationService } from "./InvestigationService.js";
export { TimelineService } from "./TimelineService.js";
