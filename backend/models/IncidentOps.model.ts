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

/**
 * Durable incident job queue. One document per job key (`_id` unique =
 * idempotency across restarts). Jobs are dispatched by op with serializable
 * params only — never closures. Terminal rows age out via TTL.
 */
export type IncidentJobStatus = "pending" | "inflight" | "done" | "failed";

const IncidentJobSchema = new Schema(
  {
    _id: { type: String, required: true },
    teamId: { type: String, required: true },
    op: { type: String, required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, required: true, default: "pending" },
    attempts: { type: Number, required: true, default: 0 },
    notBefore: { type: Date, required: true, default: () => new Date() },
    leaseExpires: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { _id: false, timestamps: true },
);

IncidentJobSchema.index({ status: 1, notBefore: 1, createdAt: 1 });
IncidentJobSchema.index({ status: 1, leaseExpires: 1 });
IncidentJobSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });

export const IncidentJobModel = mongoose.model("IncidentJob", IncidentJobSchema);
