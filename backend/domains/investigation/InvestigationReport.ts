/**
 * Investigation Domain - Investigation Report Value Object
 *
 * A compiled report summarizing an investigation's timeline, evidence,
 * findings, and recommendations. Generated at the end of the investigation
 * lifecycle and linked to the investigation via reportId.
 *
 * AI report generation is NOT implemented here — this is a domain placeholder.
 */

import { randomUUID } from "node:crypto";

import type { ReportId, InvestigationId, EvidenceId, FindingId, RunbookId } from "./types.js";

export interface InvestigationReportProps {
  readonly id: ReportId;
  readonly investigationId: InvestigationId;
  readonly summary: string;
  readonly timeline: string[];
  readonly evidenceSummary: EvidenceId[];
  readonly findings: FindingId[];
  readonly recommendations: string[];
  readonly runbookReference?: RunbookId | undefined;
  readonly generatedAt: Date;
}

export class InvestigationReport {
  readonly id: ReportId;
  readonly investigationId: InvestigationId;
  readonly summary: string;
  readonly timeline: string[];
  readonly evidenceSummary: EvidenceId[];
  readonly findings: FindingId[];
  readonly recommendations: string[];
  readonly runbookReference: RunbookId | undefined;
  readonly generatedAt: Date;

  private constructor(props: InvestigationReportProps) {
    this.id = props.id;
    this.investigationId = props.investigationId;
    this.summary = props.summary;
    this.timeline = [...props.timeline];
    this.evidenceSummary = [...props.evidenceSummary];
    this.findings = [...props.findings];
    this.recommendations = [...props.recommendations];
    this.runbookReference = props.runbookReference;
    this.generatedAt = props.generatedAt;
  }

  /**
   * Creates a new InvestigationReport.
   */
  static create(params: {
    investigationId: InvestigationId;
    summary: string;
    timeline: string[];
    evidenceSummary: EvidenceId[];
    findings: FindingId[];
    recommendations: string[];
    runbookReference?: RunbookId | undefined;
  }): InvestigationReport {
    return new InvestigationReport({
      id: randomUUID(),
      investigationId: params.investigationId,
      summary: params.summary,
      timeline: params.timeline,
      evidenceSummary: params.evidenceSummary,
      findings: params.findings,
      recommendations: params.recommendations,
      runbookReference: params.runbookReference,
      generatedAt: new Date(),
    });
  }

  /**
   * Reconstitutes an InvestigationReport from persisted data.
   */
  static reconstitute(props: InvestigationReportProps): InvestigationReport {
    return new InvestigationReport(props);
  }
}
