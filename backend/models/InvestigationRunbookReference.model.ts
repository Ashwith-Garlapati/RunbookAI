import mongoose, { Schema } from "mongoose";

export interface IRunbookReferenceDoc {
  _id: string;
  investigationId: string;
  version: number;
  status: string;
  generatedAt: Date;
  githubUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const RunbookReferenceSchema = new Schema<IRunbookReferenceDoc>(
  {
    _id: { type: String, required: true },
    investigationId: { type: String, required: true },
    version: { type: Number, required: true, default: 1 },
    status: {
      type: String,
      required: true,
      enum: ["pending", "generated", "approved", "published"],
      default: "pending",
    },
    generatedAt: { type: Date, required: true },
    githubUrl: { type: String },
  },
  {
    _id: false,
    timestamps: true,
  }
);

RunbookReferenceSchema.index({ investigationId: 1, version: 1 });

export const RunbookReferenceModel = mongoose.model<IRunbookReferenceDoc>(
  "RunbookReference",
  RunbookReferenceSchema
);
