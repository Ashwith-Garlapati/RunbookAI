import { ReportModel, type IReportDoc } from "../models/InvestigationReport.model.js";
import { InvestigationReport, type InvestigationReportProps } from "../domains/investigation/InvestigationReport.js";
import type { InvestigationId, ReportId } from "../domains/investigation/types.js";
import type { IReportRepository } from "../domains/investigation/RepositoryInterfaces.js";

function toDomain(doc: IReportDoc): InvestigationReport {
  return InvestigationReport.reconstitute({
    id: doc._id as ReportId,
    investigationId: doc.investigationId as InvestigationId,
    summary: doc.summary,
    timeline: doc.timeline,
    evidenceSummary: doc.evidenceSummary,
    findings: doc.findings,
    recommendations: doc.recommendations,
    runbookReference: doc.runbookReference as InvestigationReportProps["runbookReference"],
    generatedAt: doc.generatedAt,
  });
}

export class MongoReportRepository implements IReportRepository {
  async create(report: InvestigationReport): Promise<void> {
    const doc = new ReportModel({
      _id: report.id,
      investigationId: report.investigationId,
      summary: report.summary,
      timeline: report.timeline,
      evidenceSummary: report.evidenceSummary,
      findings: report.findings,
      recommendations: report.recommendations,
      runbookReference: report.runbookReference,
      generatedAt: report.generatedAt,
    });
    await doc.save();
  }

  async findById(id: ReportId): Promise<InvestigationReport | null> {
    const doc = await ReportModel.findById(id);
    return doc ? toDomain(doc) : null;
  }

  async findByInvestigationId(investigationId: InvestigationId): Promise<InvestigationReport | null> {
    const doc = await ReportModel.findOne({ investigationId });
    return doc ? toDomain(doc) : null;
  }
}
