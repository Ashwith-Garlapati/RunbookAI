/**
 * Investigation Domain - Repository Interfaces
 *
 * Defines persistence contracts for all domain entities.
 * These interfaces live in the domain layer to ensure
 * infrastructure depends on domain, not the other way around.
 */

import type { InvestigationId, EvidenceId, FindingId, ReportId, RunbookId } from "./types.js";
import type { EvidenceItem } from "./EvidenceItem.js";
import type { Finding } from "./Finding.js";
import type { InvestigationReport } from "./InvestigationReport.js";
import type { RunbookReference } from "./RunbookReference.js";

export interface IEvidenceRepository {
  create(evidence: EvidenceItem): Promise<void>;
  findById(id: EvidenceId): Promise<EvidenceItem | null>;
  findByInvestigationId(investigationId: InvestigationId): Promise<EvidenceItem[]>;
}

export interface IFindingRepository {
  create(finding: Finding, investigationId: InvestigationId): Promise<void>;
  findById(id: FindingId): Promise<Finding | null>;
  findByInvestigationId(investigationId: InvestigationId): Promise<Finding[]>;
}

export interface IReportRepository {
  create(report: InvestigationReport): Promise<void>;
  findById(id: ReportId): Promise<InvestigationReport | null>;
  findByInvestigationId(investigationId: InvestigationId): Promise<InvestigationReport | null>;
}

export interface IRunbookReferenceRepository {
  create(runbook: RunbookReference, investigationId: InvestigationId): Promise<void>;
  update(runbook: RunbookReference): Promise<void>;
  findById(id: RunbookId): Promise<RunbookReference | null>;
  findByInvestigationId(investigationId: InvestigationId): Promise<RunbookReference | null>;
}
