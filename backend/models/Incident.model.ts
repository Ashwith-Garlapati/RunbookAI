/**
 * Incident persistence - single `incidents` collection with subdocuments.
 *
 * Smallest model that supports the coordination requirements: channel,
 * roles (+history), participants, updates, actions, follow-ups, escalations,
 * message refs, curated timeline (immutable by convention), activity log,
 * state transitions, severity history, resolution/cancel/close packets.
 */

import mongoose, { Schema } from "mongoose";

const Mixed = Schema.Types.Mixed;

const RoleAssignmentSchema = new Schema(
  {
    id: String,
    role: String,
    assignee: { type: String, default: null },
    actor: String,
    at: Date,
    action: String,
  },
  { _id: false },
);

const ParticipantSchema = new Schema(
  {
    userId: String,
    sources: [String],
    joinedAt: Date,
  },
  { _id: false },
);

const UpdateSchema = new Schema(
  {
    id: String,
    author: String,
    at: Date,
    situation: String,
    changed: String,
    impact: String,
    nextStep: String,
  },
  { _id: false },
);

const ActionSchema = new Schema(
  {
    id: String,
    title: String,
    description: String,
    assignee: { type: String, default: null },
    priority: String,
    dueAt: { type: Date, default: null },
    status: String,
    createdBy: String,
    createdAt: Date,
    updatedAt: Date,
  },
  { _id: false },
);

const FollowUpSchema = new Schema(
  {
    id: String,
    title: String,
    description: String,
    assignee: { type: String, default: null },
    dueAt: { type: Date, default: null },
    status: String,
    createdBy: String,
    createdAt: Date,
    updatedAt: Date,
  },
  { _id: false },
);

const EscalationSchema = new Schema(
  {
    id: String,
    toUser: String,
    reason: String,
    actor: String,
    at: Date,
  },
  { _id: false },
);

const MessageRefSchema = new Schema(
  {
    channelId: String,
    messageTs: String,
    threadTs: { type: String, default: null },
    author: String,
    text: String,
    permalink: { type: String, default: null },
    addedBy: String,
    addedAt: Date,
  },
  { _id: false },
);

const TimelineEntrySchema = new Schema(
  {
    id: String,
    type: String,
    actor: String,
    at: Date,
    summary: String,
    metadata: { type: Mixed, default: {} },
  },
  { _id: false },
);

const ActivityEntrySchema = new Schema(
  {
    id: String,
    at: Date,
    actor: String,
    kind: String,
    detail: String,
    metadata: { type: Mixed, default: {} },
  },
  { _id: false },
);

const TransitionSchema = new Schema(
  {
    from: String,
    to: String,
    actor: String,
    at: Date,
  },
  { _id: false },
);

const IncidentSchema = new Schema(
  {
    _id: { type: String, required: true },
    teamId: { type: String, required: true },
    organizationId: { type: String },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    incidentType: { type: String, default: "operational" },
    affectedService: { type: String, default: "" },
    severity: { type: String, required: true },
    status: { type: String, required: true },
    channelId: { type: String, default: null },
    channelName: { type: String, default: null },
    channelPermalink: { type: String, default: null },
    originChannelId: { type: String, default: null },
    originMessageTs: { type: String, default: null },
    controlMessageTs: { type: String, default: null },
    reporterId: { type: String, required: true },
    currentRoles: { type: Mixed, default: {} },
    roleHistory: { type: [RoleAssignmentSchema], default: [] },
    participants: { type: [ParticipantSchema], default: [] },
    updates: { type: [UpdateSchema], default: [] },
    actions: { type: [ActionSchema], default: [] },
    followUps: { type: [FollowUpSchema], default: [] },
    escalations: { type: [EscalationSchema], default: [] },
    messageRefs: { type: [MessageRefSchema], default: [] },
    timeline: { type: [TimelineEntrySchema], default: [] },
    activity: { type: [ActivityEntrySchema], default: [] },
    transitions: { type: [TransitionSchema], default: [] },
    severityHistory: { type: Mixed, default: [] },
    resolution: { type: Mixed, default: null },
    cancelInfo: { type: Mixed, default: null },
    closeInfo: { type: Mixed, default: null },
    investigationId: { type: String, default: null },
    idempotencyKey: { type: String, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { _id: false, timestamps: false },
);

IncidentSchema.index({ teamId: 1, status: 1 });
IncidentSchema.index({ teamId: 1, channelId: 1 }, { sparse: true });
IncidentSchema.index({ teamId: 1, createdAt: -1 });
IncidentSchema.index({ teamId: 1, idempotencyKey: 1 }, { sparse: true });

export const IncidentModel = mongoose.model("Incident", IncidentSchema);
