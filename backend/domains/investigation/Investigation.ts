/**
 * Investigation Aggregate Root
 *
 * This is the central entity of the entire RunbookAI platform.
 * Every integration, every workflow, every piece of data flows through
 * the Investigation aggregate. Nothing bypasses it.
 *
 * The aggregate enforces:
 * - Invariant protection (valid state transitions)
 * - Lifecycle management (Draft → Archived)
 * - Event collection (domain events for decoupled communication)
 * - Identity (UUID-based, immutable once created)
 *
 * Design Principles:
 * - Pure domain model — no infrastructure dependencies
 * - Encapsulated state — mutations only through well-defined methods
 * - Self-validating — rejects invalid operations
 * - Event-sourced — collects domain events for the service layer to publish
 */

import { randomUUID } from "node:crypto";

import type {
  InvestigationId,
  OrganizationId,
  EvidenceId,
  FindingId,
  RunbookId,
  ReportId,
  TimelineEventId,
  UserId,
  ServiceName,
  Tag,
} from "./types.js";
import {
  InvestigationStatus,
  canTransition,
  InvalidTransitionError,
} from "./InvestigationStatus.js";
import type { Trigger } from "./Trigger.js";
import type { InvestigationDomainEvent } from "./InvestigationEvents.js";

// --- Props Interface (for construction/reconstitution) ---

export interface InvestigationProps {
  readonly id: InvestigationId;
  readonly organizationId?: OrganizationId | undefined;
  readonly title: string;
  readonly description: string;
  readonly severity: string;
  readonly status: InvestigationStatus;
  readonly trigger: Trigger;
  readonly createdBy: UserId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly startedAt?: Date | undefined;
  readonly completedAt?: Date | undefined;
  readonly affectedServices: ServiceName[];
  readonly tags: Tag[];
  readonly evidenceIds: EvidenceId[];
  readonly findingIds: FindingId[];
  readonly runbookId?: RunbookId | undefined;
  readonly reportId?: ReportId | undefined;
  readonly timelineEventIds: TimelineEventId[];
  readonly metadata: Record<string, unknown>;
}

// --- Factory Parameters (for create()) ---

export interface CreateInvestigationParams {
  readonly title: string;
  readonly description: string;
  readonly severity: string;
  readonly trigger: Trigger;
  readonly createdBy: UserId;
  readonly organizationId?: OrganizationId;
  readonly affectedServices?: ServiceName[];
  readonly tags?: Tag[];
  readonly metadata?: Record<string, unknown>;
}

// --- Aggregate Root ---

export class Investigation {
  private _events: InvestigationDomainEvent[] = [];

  // --- Immutable identity and creation data ---
  readonly id: InvestigationId;
  readonly organizationId: OrganizationId | undefined;
  readonly trigger: Trigger;
  readonly createdBy: UserId;
  readonly createdAt: Date;

  // --- Mutable state ---
  private _title: string;
  private _description: string;
  private _severity: string;
  private _status: InvestigationStatus;
  private _updatedAt: Date;
  private _startedAt: Date | undefined;
  private _completedAt: Date | undefined;
  private _affectedServices: ServiceName[];
  private _tags: Tag[];
  private _evidenceIds: EvidenceId[];
  private _findingIds: FindingId[];
  private _runbookId: RunbookId | undefined;
  private _reportId: ReportId | undefined;
  private _timelineEventIds: TimelineEventId[];
  private _metadata: Record<string, unknown>;

  private constructor(props: InvestigationProps) {
    this.id = props.id;
    this.organizationId = props.organizationId;
    this._title = props.title;
    this._description = props.description;
    this._severity = props.severity;
    this._status = props.status;
    this.trigger = props.trigger;
    this.createdBy = props.createdBy;
    this.createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
    this._startedAt = props.startedAt;
    this._completedAt = props.completedAt;
    this._affectedServices = [...props.affectedServices];
    this._tags = [...props.tags];
    this._evidenceIds = [...props.evidenceIds];
    this._findingIds = [...props.findingIds];
    this._runbookId = props.runbookId;
    this._reportId = props.reportId;
    this._timelineEventIds = [...props.timelineEventIds];
    this._metadata = { ...props.metadata };
  }

  // ===========================
  //  Factory Methods
  // ===========================

  /**
   * Creates a new Investigation in Draft status.
   * Emits an InvestigationCreated event.
   */
  static create(params: CreateInvestigationParams): Investigation {
    const now = new Date();
    const investigation = new Investigation({
      id: randomUUID(),
      organizationId: params.organizationId,
      title: params.title,
      description: params.description,
      severity: params.severity,
      status: InvestigationStatus.Draft,
      trigger: params.trigger,
      createdBy: params.createdBy,
      createdAt: now,
      updatedAt: now,
      affectedServices: params.affectedServices ?? [],
      tags: params.tags ?? [],
      evidenceIds: [],
      findingIds: [],
      timelineEventIds: [],
      metadata: params.metadata ?? {},
    });

    investigation.emitEvent("InvestigationCreated", {
      title: params.title,
      severity: params.severity,
      trigger: params.trigger,
    });

    return investigation;
  }

  /**
   * Reconstitutes an Investigation from persisted data.
   * No events are emitted — this is for loading from storage.
   */
  static reconstitute(props: InvestigationProps): Investigation {
    return new Investigation(props);
  }

  // ===========================
  //  Getters (read-only access)
  // ===========================

  get title(): string {
    return this._title;
  }

  get description(): string {
    return this._description;
  }

  get severity(): string {
    return this._severity;
  }

  get status(): InvestigationStatus {
    return this._status;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  get startedAt(): Date | undefined {
    return this._startedAt;
  }

  get completedAt(): Date | undefined {
    return this._completedAt;
  }

  get affectedServices(): readonly ServiceName[] {
    return this._affectedServices;
  }

  get tags(): readonly Tag[] {
    return this._tags;
  }

  get evidenceIds(): readonly EvidenceId[] {
    return this._evidenceIds;
  }

  get findingIds(): readonly FindingId[] {
    return this._findingIds;
  }

  get runbookId(): RunbookId | undefined {
    return this._runbookId;
  }

  get reportId(): ReportId | undefined {
    return this._reportId;
  }

  get timelineEventIds(): readonly TimelineEventId[] {
    return this._timelineEventIds;
  }

  get metadata(): Readonly<Record<string, unknown>> {
    return this._metadata;
  }

  // ===========================
  //  Lifecycle Transitions
  // ===========================

  /**
   * Convenience alias for beginEvidenceCollection().
   * Marks the investigation as started and transitions to CollectingEvidence.
   */
  start(): void {
    this.beginEvidenceCollection();
  }

  /**
   * Draft → CollectingEvidence
   * Begins the evidence collection phase. Records the start timestamp.
   */
  beginEvidenceCollection(startedBy?: string): void {
    this.transitionTo(InvestigationStatus.CollectingEvidence);
    if (!this._startedAt) {
      this._startedAt = new Date();
    }
    this.emitEvent("InvestigationStarted", {
      startedBy: startedBy ?? "system",
    });
  }

  /**
   * CollectingEvidence → Analyzing
   * Moves from evidence collection to analysis phase.
   */
  beginAnalysis(): void {
    this.transitionTo(InvestigationStatus.Analyzing);
  }

  /**
   * Analyzing → GeneratingFindings
   * Analysis is complete; findings generation begins.
   */
  generateFindings(): void {
    this.transitionTo(InvestigationStatus.GeneratingFindings);
  }

  /**
   * GeneratingFindings → GeneratingRunbook
   * Findings are ready; runbook generation begins.
   */
  generateRunbook(): void {
    this.transitionTo(InvestigationStatus.GeneratingRunbook);
  }

  /**
   * GeneratingRunbook → WaitingApproval
   * Runbook is generated; awaiting human approval.
   */
  approve(): void {
    this.transitionTo(InvestigationStatus.WaitingApproval);
  }

  /**
   * WaitingApproval → Completed
   * Investigation is approved and complete.
   */
  complete(): void {
    this.transitionTo(InvestigationStatus.Completed);
    if (!this._completedAt) {
      this._completedAt = new Date();
    }
    this.emitEvent("InvestigationCompleted", {});
  }

  /**
   * Completed → Archived
   * Investigation is archived for long-term storage.
   */
  archive(): void {
    this.transitionTo(InvestigationStatus.Archived);
    this.emitEvent("InvestigationArchived", {});
  }

  // ===========================
  //  Evidence Management
  // ===========================

  /**
   * Attaches an evidence reference to this investigation.
   * Emits an EvidenceAdded event. Duplicate IDs are ignored.
   */
  attachEvidence(evidenceId: EvidenceId): void {
    if (!this._evidenceIds.includes(evidenceId)) {
      this._evidenceIds.push(evidenceId);
      this.emitEvent("EvidenceAdded", {
        evidenceId,
      });
    }
  }

  // ===========================
  //  Finding Management
  // ===========================

  /**
   * Links a finding to this investigation.
   * Emits a FindingAdded event. Duplicate IDs are ignored.
   */
  addFinding(findingId: FindingId): void {
    if (!this._findingIds.includes(findingId)) {
      this._findingIds.push(findingId);
      this.emitEvent("FindingAdded", {
        findingId,
      });
    }
  }

  // ===========================
  //  Runbook Management
  // ===========================

  /**
   * Links a runbook reference to this investigation.
   * Emits a RunbookAttached event.
   */
  attachRunbook(runbookId: RunbookId): void {
    this._runbookId = runbookId;
    this.emitEvent("RunbookAttached", {
      runbookId,
    });
  }

  // ===========================
  //  Report Management
  // ===========================

  /**
   * Links a generated report to this investigation.
   * Emits a ReportGenerated event.
   */
  attachReport(reportId: ReportId): void {
    this._reportId = reportId;
    this.emitEvent("ReportGenerated", {
      reportId,
    });
  }

  // ===========================
  //  Timeline Management
  // ===========================

  /**
   * Adds a timeline event ID to this investigation's timeline.
   * Called by the InvestigationService after the TimelineService creates entries.
   */
  addTimelineEvent(timelineEventId: TimelineEventId): void {
    if (!this._timelineEventIds.includes(timelineEventId)) {
      this._timelineEventIds.push(timelineEventId);
    }
  }

  // ===========================
  //  Metadata Management
  // ===========================

  /**
   * Updates a metadata key on the investigation.
   * Used for integration-specific data (e.g., Slack channel, GitHub PR number).
   */
  updateMetadata(key: string, value: unknown): void {
    this._metadata[key] = value;
    this._updatedAt = new Date();
  }

  /**
   * Updates the investigation's core details.
   * Only non-empty values are applied.
   */
  updateDetails(params: { title?: string; description?: string; severity?: string }): void {
    if (params.title !== undefined) {
      this._title = params.title;
    }
    if (params.description !== undefined) {
      this._description = params.description;
    }
    if (params.severity !== undefined) {
      this._severity = params.severity;
    }
    this._updatedAt = new Date();
  }

  // ===========================
  //  Event Management
  // ===========================

  /**
   * Pulls all uncommitted domain events and clears the internal buffer.
   * Called by the InvestigationService to publish events after persistence.
   */
  pullEvents(): InvestigationDomainEvent[] {
    const events = [...this._events];
    this._events = [];
    return events;
  }

  // ===========================
  //  Private Helpers
  // ===========================

  /**
   * Performs a state transition if valid. Throws InvalidTransitionError otherwise.
   * Emits a StatusChanged event on success.
   */
  private transitionTo(nextStatus: InvestigationStatus): void {
    if (!canTransition(this._status, nextStatus)) {
      throw new InvalidTransitionError(this._status, nextStatus);
    }

    const previousStatus = this._status;
    this._status = nextStatus;
    this._updatedAt = new Date();

    this.emitEvent("StatusChanged", {
      from: previousStatus,
      to: nextStatus,
    });
  }

  /**
   * Internal helper to emit domain events with consistent structure.
   */
  private emitEvent(
    eventType: InvestigationDomainEvent["eventType"],
    payload: Record<string, unknown>,
  ): void {
    this._events.push({
      eventId: randomUUID(),
      eventType,
      occurredAt: new Date(),
      investigationId: this.id,
      payload,
    } as InvestigationDomainEvent);
  }
}
