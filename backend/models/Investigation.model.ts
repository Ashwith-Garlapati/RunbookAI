import mongoose, { Schema } from "mongoose";

export interface IInvestigationDoc {
  _id: string;
  organizationId?: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  trigger: {
    id: string;
    source: string;
    type: string;
    actor: string;
    payload: Record<string, unknown>;
    timestamp: Date;
    metadata: Record<string, unknown>;
  };
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  affectedServices: string[];
  tags: string[];
  evidenceIds: string[];
  findingIds: string[];
  runbookId?: string;
  reportId?: string;
  timelineEventIds: string[];
  metadata: Record<string, unknown>;
}

const InvestigationSchema = new Schema<IInvestigationDoc>(
  {
    _id: { type: String, required: true },
    organizationId: { type: String },
    title: { type: String, required: true },
    description: { type: String, required: true },
    severity: { type: String, required: true },
    status: { type: String, required: true },
    trigger: {
      id: { type: String, required: true },
      source: { type: String, required: true },
      type: { type: String, required: true },
      actor: { type: String, required: true },
      payload: { type: Schema.Types.Mixed, default: {} },
      timestamp: { type: Date, required: true },
      metadata: { type: Schema.Types.Mixed, default: {} },
    },
    createdBy: { type: String, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    startedAt: { type: Date },
    completedAt: { type: Date },
    affectedServices: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    evidenceIds: { type: [String], default: [] },
    findingIds: { type: [String], default: [] },
    runbookId: { type: String },
    reportId: { type: String },
    timelineEventIds: { type: [String], default: [] },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false, timestamps: false }
);

InvestigationSchema.index({ status: 1 });
InvestigationSchema.index({ createdAt: -1 });
InvestigationSchema.index({ organizationId: 1 });

export const InvestigationModel = mongoose.model<IInvestigationDoc>(
  "Investigation",
  InvestigationSchema
);
