import mongoose, { Schema } from "mongoose";

export interface IFindingDoc {
  _id: string;
  investigationId: string;
  title: string;
  summary: string;
  confidence: number;
  reasoning: string;
  recommendation: string;
  relatedEvidence: string[];
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

const FindingSchema = new Schema<IFindingDoc>(
  {
    _id: { type: String, required: true },
    investigationId: { type: String, required: true },
    title: { type: String, required: true },
    summary: { type: String, required: true },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    reasoning: { type: String, required: true },
    recommendation: { type: String, required: true },
    relatedEvidence: { type: [String], default: [] },
    status: { type: String, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { _id: false, timestamps: false }
);

FindingSchema.index({ investigationId: 1 });

export const FindingModel = mongoose.model<IFindingDoc>(
  "InvestigationFinding",
  FindingSchema
);
