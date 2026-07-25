/**
 * Investigation Domain - Investigation Service
 *
 * The orchestration layer for all investigation operations.
 * This service is the ONLY entry point for modifying Investigation state.
 * Controllers, integrations, and external connectors MUST go through this service.
 *
 * Responsibilities:
 * - Create investigations from triggers
 * - Orchestrate lifecycle transitions
 * - Coordinate with TimelineService for event recording
 * - Persist changes via IInvestigationRepository
 * - Publish domain events via IEventBus
 *
 * Design Rules:
 * - Controllers NEVER modify Investigation directly
 * - Slack NEVER calls AI directly
 * - GitHub NEVER generates runbooks directly
 * - Every integration creates a Trigger → calls this service
 */

import type {
  InvestigationId,
  OrganizationId,
  EvidenceId,
  FindingId,
  RunbookId,
  ReportId,
  UserId,
  ServiceName,
  Tag,
} from "./types.js";
import type { IEventBus } from "./interfaces.js";
import type { IInvestigationRepository } from "./InvestigationRepository.js";
import type {
  IFindingRepository,
  IReportRepository,
  IRunbookReferenceRepository,
} from "./RepositoryInterfaces.js";
import { Investigation } from "./Investigation.js";
import { InvestigationStatus } from "./InvestigationStatus.js";
import { TimelineService } from "./TimelineService.js";
import { TimelineEventType } from "./TimelineEventType.js";
import { Finding } from "./Finding.js";
import { InvestigationReport } from "./InvestigationReport.js";
import { RunbookReference } from "./RunbookReference.js";
import type { Trigger } from "./Trigger.js";

export class InvestigationService {
  constructor(
    private readonly _repository: IInvestigationRepository,
    private readonly _eventBus: IEventBus,
    private readonly _timelineService: TimelineService,
    private readonly _findingRepository?: IFindingRepository,
    private readonly _reportRepository?: IReportRepository,
    private readonly _runbookReferenceRepository?: IRunbookReferenceRepository,
  ) {}

  // ===========================
  //  Investigation Lifecycle
  // ===========================

  /**
   * Creates a new Investigation from a Trigger.
   * This is the primary entry point for all integrations.
   *
   * Flow:
   * 1. Integration creates a Trigger
   * 2. Integration calls createInvestigation(trigger)
   * 3. Investigation is persisted in Draft status
   * 4. Domain events are published
   * 5. Investigation ID is returned
   */
  async createInvestigation(params: {
    title: string;
    description: string;
    severity: string;
    trigger: Trigger;
    createdBy: UserId;
    organizationId?: OrganizationId;
    affectedServices?: ServiceName[];
    tags?: Tag[];
    metadata?: Record<string, unknown>;
  }): Promise<Investigation> {
    const investigation = Investigation.create(params);

    const timelineEvent = this._timelineService.record({
      investigationId: investigation.id,
      type: TimelineEventType.InvestigationCreated,
      description: `Investigation "${params.title}" created with severity ${params.severity}`,
      metadata: { triggerSource: params.trigger.source },
    });
    investigation.addTimelineEvent(timelineEvent.id);

    await this._repository.create(investigation);
    await this.publishEvents(investigation);

    return investigation;
  }

  /**
   * Starts an investigation by transitioning from Draft to CollectingEvidence.
   */
  async startInvestigation(
    investigationId: InvestigationId,
    startedBy?: UserId,
  ): Promise<Investigation> {
    const investigation = await this.loadInvestigation(investigationId);
    investigation.beginEvidenceCollection(startedBy);

    this.recordStatusTimeline(investigation);
    await this._repository.update(investigation);
    await this.publishEvents(investigation);

    return investigation;
  }

  /**
   * Transitions an investigation to a target status.
   * Validates that the transition is legal before applying it.
   */
  async changeStatus(
    investigationId: InvestigationId,
    targetStatus: InvestigationStatus,
    startedBy?: UserId,
  ): Promise<Investigation> {
    const investigation = await this.loadInvestigation(investigationId);

    switch (targetStatus) {
      case InvestigationStatus.CollectingEvidence:
        investigation.beginEvidenceCollection(startedBy);
        break;
      case InvestigationStatus.Analyzing:
        investigation.beginAnalysis();
        break;
      case InvestigationStatus.GeneratingFindings:
        investigation.generateFindings();
        break;
      case InvestigationStatus.GeneratingRunbook:
        investigation.generateRunbook();
        break;
      case InvestigationStatus.WaitingApproval:
        investigation.approve();
        break;
      case InvestigationStatus.Completed:
        investigation.complete();
        break;
      case InvestigationStatus.Archived:
        investigation.archive();
        break;
      default:
        throw new Error(`Cannot transition to status "${targetStatus}" via changeStatus`);
    }

    this.recordStatusTimeline(investigation);
    await this._repository.update(investigation);
    await this.publishEvents(investigation);

    return investigation;
  }

  // ===========================
  //  Evidence Management
  // ===========================

  /**
   * Attaches an evidence reference to an investigation.
   * The evidence itself is stored by the evidence collector system.
   * The investigation only holds the reference ID.
   */
  async attachEvidence(
    investigationId: InvestigationId,
    evidenceId: EvidenceId,
  ): Promise<Investigation> {
    const investigation = await this.loadInvestigation(investigationId);
    investigation.attachEvidence(evidenceId);

    const timelineEvent = this._timelineService.record({
      investigationId: investigation.id,
      type: TimelineEventType.EvidenceAdded,
      description: `Evidence ${evidenceId} attached`,
      metadata: { evidenceId },
    });
    investigation.addTimelineEvent(timelineEvent.id);

    await this._repository.update(investigation);
    await this.publishEvents(investigation);

    return investigation;
  }

  // ===========================
  //  Timeline Management
  // ===========================

  /**
   * Records a custom timeline event for an investigation.
   * Used for external integrations to add their own timeline entries.
   */
  async addTimelineEvent(
    investigationId: InvestigationId,
    params: {
      type: TimelineEventType;
      description: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Investigation> {
    const investigation = await this.loadInvestigation(investigationId);

    const timelineEvent = this._timelineService.record({
      investigationId: investigation.id,
      type: params.type,
      description: params.description,
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    });
    investigation.addTimelineEvent(timelineEvent.id);

    await this._repository.update(investigation);

    return investigation;
  }

  // ===========================
  //  Finding Management
  // ===========================

  /**
   * Creates a Finding and attaches it to the investigation.
   * Returns both the investigation and the created finding.
   */
  async addFinding(
    investigationId: InvestigationId,
    findingParams: {
      title: string;
      summary: string;
      confidence: number;
      reasoning: string;
      recommendation: string;
      relatedEvidence?: EvidenceId[];
    },
  ): Promise<{ investigation: Investigation; finding: Finding }> {
    const investigation = await this.loadInvestigation(investigationId);
    const finding = Finding.create(findingParams);

    investigation.addFinding(finding.id);

    if (this._findingRepository) {
      await this._findingRepository.create(finding, investigationId);
    }

    const timelineEvent = this._timelineService.record({
      investigationId: investigation.id,
      type: TimelineEventType.FindingAdded,
      description: `Finding "${findingParams.title}" added`,
      metadata: { findingId: finding.id, confidence: findingParams.confidence },
    });
    investigation.addTimelineEvent(timelineEvent.id);

    await this._repository.update(investigation);
    await this.publishEvents(investigation);

    return { investigation, finding };
  }

  // ===========================
  //  Runbook Management
  // ===========================

  /**
   * Creates a RunbookReference and attaches it to the investigation.
   * The actual runbook content is managed externally.
   */
  async attachRunbook(
    investigationId: InvestigationId,
    params: {
      githubUrl?: string;
    } = {},
  ): Promise<{ investigation: Investigation; runbook: RunbookReference }> {
    const investigation = await this.loadInvestigation(investigationId);
    const runbook = params.githubUrl
      ? RunbookReference.create({ githubUrl: params.githubUrl })
      : RunbookReference.create();

    investigation.attachRunbook(runbook.id);

    if (this._runbookReferenceRepository) {
      await this._runbookReferenceRepository.create(runbook, investigationId);
    }

    const timelineEvent = this._timelineService.record({
      investigationId: investigation.id,
      type: TimelineEventType.RunbookGenerated,
      description: `Runbook ${runbook.id} attached`,
      metadata: { runbookId: runbook.id, githubUrl: params.githubUrl },
    });
    investigation.addTimelineEvent(timelineEvent.id);

    await this._repository.update(investigation);
    await this.publishEvents(investigation);

    return { investigation, runbook };
  }

  // ===========================
  //  Report Management
  // ===========================

  /**
   * Generates and attaches an investigation report.
   * Compiles timeline, evidence, findings, and recommendations into a report.
   */
  async generateReport(
    investigationId: InvestigationId,
    reportParams: {
      summary: string;
      recommendations: string[];
    },
  ): Promise<{ investigation: Investigation; report: InvestigationReport }> {
    const investigation = await this.loadInvestigation(investigationId);

    const timelineDescriptions = this._timelineService
      .getTimeline(investigation.id)
      .map((e) => e.description);

    const report = InvestigationReport.create({
      investigationId: investigation.id,
      summary: reportParams.summary,
      timeline: timelineDescriptions,
      evidenceSummary: [...investigation.evidenceIds],
      findings: [...investigation.findingIds],
      recommendations: reportParams.recommendations,
      runbookReference: investigation.runbookId,
    });

    investigation.attachReport(report.id);

    if (this._reportRepository) {
      await this._reportRepository.create(report);
    }

    const timelineEvent = this._timelineService.record({
      investigationId: investigation.id,
      type: TimelineEventType.ReportGenerated,
      description: "Investigation report generated",
      metadata: { reportId: report.id },
    });
    investigation.addTimelineEvent(timelineEvent.id);

    await this._repository.update(investigation);
    await this.publishEvents(investigation);

    return { investigation, report };
  }

  // ===========================
  //  Completion & Archival
  // ===========================

  /**
   * Completes an investigation. Transitions to Completed status.
   */
  async complete(investigationId: InvestigationId): Promise<Investigation> {
    const investigation = await this.loadInvestigation(investigationId);
    investigation.complete();

    const timelineEvent = this._timelineService.record({
      investigationId: investigation.id,
      type: TimelineEventType.Completed,
      description: "Investigation completed",
    });
    investigation.addTimelineEvent(timelineEvent.id);

    await this._repository.update(investigation);
    await this.publishEvents(investigation);

    return investigation;
  }

  /**
   * Archives an investigation. Transitions to Archived status.
   */
  async archive(investigationId: InvestigationId): Promise<Investigation> {
    const investigation = await this.loadInvestigation(investigationId);
    investigation.archive();

    const timelineEvent = this._timelineService.record({
      investigationId: investigation.id,
      type: TimelineEventType.Archived,
      description: "Investigation archived",
    });
    investigation.addTimelineEvent(timelineEvent.id);

    await this._repository.update(investigation);
    await this.publishEvents(investigation);

    return investigation;
  }

  // ===========================
  //  Query Methods
  // ===========================

  /**
   * Retrieves an investigation by ID. Throws if not found.
   */
  async getInvestigation(investigationId: InvestigationId): Promise<Investigation> {
    return this.loadInvestigation(investigationId);
  }

  /**
   * Returns the full timeline for an investigation.
   */
  async getTimeline(investigationId: InvestigationId) {
    const investigation = await this.loadInvestigation(investigationId);
    return this._timelineService.getTimeline(investigation.id);
  }

  /**
   * Returns all active investigations (not completed or archived).
   */
  async getActiveInvestigations(): Promise<Investigation[]> {
    return this._repository.findActive();
  }

  /**
   * Returns all investigations with the given status.
   */
  async getInvestigationsByStatus(status: InvestigationStatus): Promise<Investigation[]> {
    return this._repository.findByStatus(status);
  }

  // ===========================
  //  Private Helpers
  // ===========================

  /**
   * Loads an investigation or throws if not found.
   */
  private async loadInvestigation(id: InvestigationId): Promise<Investigation> {
    const investigation = await this._repository.findById(id);
    if (!investigation) {
      throw new Error(`Investigation not found: ${id}`);
    }
    return investigation;
  }

  /**
   * Records a status change timeline event and links it to the investigation.
   */
  private recordStatusTimeline(investigation: Investigation): void {
    const event = this._timelineService.record({
      investigationId: investigation.id,
      type: TimelineEventType.StatusChanged,
      description: `Status changed to ${investigation.status}`,
      metadata: { status: investigation.status },
    });
    investigation.addTimelineEvent(event.id);
  }

  /**
   * Publishes all uncommitted domain events from the investigation.
   */
  private async publishEvents(investigation: Investigation): Promise<void> {
    const events = investigation.pullEvents();
    for (const event of events) {
      await this._eventBus.publish(event);
    }
  }
}
