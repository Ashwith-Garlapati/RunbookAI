import mongoose, { Schema } from "mongoose";

export interface IReportDoc {
  _id: string;
  investigationId: string;
  summary: string;
  timeline: string[];
  evidenceSummary: string[];
  findings: string[];
  recommendations: string[];
  runbookReference?: string;
  generatedAt: Date;
}

const ReportSchema = new Schema<IReportDoc>(
  {
    _id: { type: String, required: true },
    investigationId: { type: String, required: true },
    summary: { type: String, required: true },
    timeline: { type: [String], default: [] },
    evidenceSummary: { type: [String], default: [] },
    findings: { type: [String], default: [] },
    recommendations: { type: [String], default: [] },
    runbookReference: { type: String },
    generatedAt: { type: Date, required: true },
  },
  { _id: false, timestamps: false }
);

ReportSchema.index({ investigationId: 1 });

export const ReportModel = mongoose.model<IReportDoc>(
  "InvestigationReport",
  ReportSchema
);
