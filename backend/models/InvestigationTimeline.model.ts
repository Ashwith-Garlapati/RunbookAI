import mongoose, { Schema } from "mongoose";

export interface ITimelineEventDoc {
  _id: string;
  investigationId: string;
  type: string;
  timestamp: Date;
  description: string;
  metadata: Record<string, unknown>;
}

const TimelineEventSchema = new Schema<ITimelineEventDoc>(
  {
    _id: { type: String, required: true },
    investigationId: { type: String, required: true },
    type: { type: String, required: true },
    timestamp: { type: Date, required: true },
    description: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false, timestamps: false }
);

TimelineEventSchema.index({ investigationId: 1, timestamp: 1 });

export const TimelineEventModel = mongoose.model<ITimelineEventDoc>(
  "InvestigationTimelineEvent",
  TimelineEventSchema
);
