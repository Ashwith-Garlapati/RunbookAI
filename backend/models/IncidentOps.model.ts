/**
 * Incident ops persistence: Slack delivery idempotency + append-only audit log.
 */

import mongoose, { Schema } from "mongoose";

const ProcessedEventSchema = new Schema(
  {
    _id: { type: String, required: true },
    teamId: { type: String, required: true },
    eventId: { type: String, required: true },
    kind: { type: String, required: true },
    createdAt: { type: Date, required: true, expires: 60 * 60 * 24 * 14 },
  },
  { _id: false, timestamps: false },
);

ProcessedEventSchema.index({ teamId: 1, eventId: 1 }, { unique: true });

export const SlackProcessedEventModel = mongoose.model("SlackProcessedEvent", ProcessedEventSchema);

const AuditLogSchema = new Schema(
  {
    _id: { type: String, required: true },
    teamId: { type: String, required: true },
    incidentId: { type: String, default: null },
    actor: { type: String, required: true },
    action: { type: String, required: true },
    at: { type: Date, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false, timestamps: false },
);

AuditLogSchema.index({ teamId: 1, incidentId: 1, at: 1 });

export const AuditLogModel = mongoose.model("AuditLog", AuditLogSchema);
