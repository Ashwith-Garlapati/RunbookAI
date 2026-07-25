import mongoose, { Schema } from "mongoose";

export interface IEvidenceDoc {
  _id: string;
  investigationId: string;
  source: string;
  type: string;
  reference: string;
  collectedAt: Date;
  metadata: Record<string, unknown>;
}

const EvidenceSchema = new Schema<IEvidenceDoc>(
  {
    _id: { type: String, required: true },
    investigationId: { type: String, required: true },
    source: { type: String, required: true },
    type: { type: String, required: true },
    reference: { type: String, required: true },
    collectedAt: { type: Date, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false, timestamps: false }
);

EvidenceSchema.index({ investigationId: 1 });

export const EvidenceModel = mongoose.model<IEvidenceDoc>(
  "InvestigationEvidence",
  EvidenceSchema
);
