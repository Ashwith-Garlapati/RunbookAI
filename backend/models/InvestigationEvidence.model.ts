import mongoose, { Schema } from "mongoose";

export interface IEvidenceDoc {
  _id: string;
  investigationId: string;
  source: string;
  type: string;
  reference: string;
  collectedAt: Date;
  metadata: Record<string, unknown>;
  /** Canonical contract fields (optional — rows predating them read back fine). */
  teamId?: string;
  incidentId?: string;
  title?: string;
  content?: string;
  searchableText?: string;
  occurredAt?: Date;
  provenance?: Record<string, unknown>;
  sourceId?: string;
  hash?: string;
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
    teamId: { type: String },
    incidentId: { type: String },
    title: { type: String },
    content: { type: String },
    searchableText: { type: String },
    occurredAt: { type: Date },
    provenance: { type: Schema.Types.Mixed },
    sourceId: { type: String },
    hash: { type: String },
  },
  { _id: false, timestamps: false }
);

EvidenceSchema.index({ investigationId: 1 });
// Dedupe key is sourceId ?? reference (canonical items set both equal,
// reference is required on every row including legacy ones), so uniqueness
// on reference covers all rows without a null-field hazard.
EvidenceSchema.index({ investigationId: 1, reference: 1 }, { unique: true });

export const EvidenceModel = mongoose.model<IEvidenceDoc>(
  "InvestigationEvidence",
  EvidenceSchema
);
