/**
 * Incident Domain - Incident Aggregate Root (deterministic coordination layer).
 *
 * Pure domain model: no Mongo, no Slack, no AI. Only IncidentCoordinator
 * mutates incidents. Every mutation emits an IncidentDomainEvent for the
 * timeline / activity / audit / Slack layers.
 *
 * Identity: internal IncidentId + Slack channelId. Channel NAME is display
 * only and never used as identity.
 */

import { randomUUID } from "node:crypto";

import type {
  IncidentId,
  TeamId,
  SlackUserId,
  SlackChannelId,
  MessageTs,
  ActionId,
  FollowUpId,
  UpdateId,
  EscalationId,
  TimelineEntryId,
  ActivityEntryId,
} from "./types.js";
import {
  IncidentStatus,
  canTransitionIncident,
  InvalidIncidentTransitionError,
} from "./IncidentStatus.js";
import { IncidentSeverity } from "./IncidentSeverity.js";
import { IncidentRole } from "./IncidentRoles.js";
import type { IncidentDomainEvent, IncidentEventType } from "./IncidentEvents.js";
import { IncidentTimelineType } from "./IncidentEvents.js";

export type ActionStatus = "OPEN" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "NOT_DOING";
export type FollowUpStatus = "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";
export type ParticipantSource =
  | "reporter"
  | "invited"
  | "escalated"
  | "role_assigned"
  | "interacted";

export interface RoleAssignment {
  readonly id: string;
  readonly role: IncidentRole;
  readonly assignee: SlackUserId | null;
  readonly actor: SlackUserId;
  readonly at: Date;
  readonly action: "assigned" | "reassigned" | "unassigned";
}

export interface Participant {
  readonly userId: SlackUserId;
  readonly sources: ParticipantSource[];
  readonly joinedAt: Date;
}

export interface IncidentUpdate {
  readonly id: UpdateId;
  readonly author: SlackUserId;
  readonly at: Date;
  readonly situation: string;
  readonly changed: string;
  readonly impact: string;
  readonly nextStep: string;
}

export interface IncidentAction {
  readonly id: ActionId;
  title: string;
  description: string;
  assignee: SlackUserId | null;
  readonly priority: string;
  readonly dueAt: Date | null;
  status: ActionStatus;
  readonly createdBy: SlackUserId;
  readonly createdAt: Date;
  updatedAt: Date;
}

export interface IncidentFollowUp {
  readonly id: FollowUpId;
  readonly title: string;
  readonly description: string;
  readonly assignee: SlackUserId | null;
  readonly dueAt: Date | null;
  status: FollowUpStatus;
  readonly createdBy: SlackUserId;
  readonly createdAt: Date;
  updatedAt: Date;
}

export interface IncidentEscalation {
  readonly id: EscalationId;
  readonly toUser: SlackUserId;
  readonly reason: string;
  readonly actor: SlackUserId;
  readonly at: Date;
}

export interface SlackMessageRef {
  readonly channelId: SlackChannelId;
  readonly messageTs: MessageTs;
  readonly threadTs: MessageTs | null;
  readonly author: SlackUserId;
  readonly text: string;
  readonly permalink: string | null;
  readonly addedBy: SlackUserId;
  readonly addedAt: Date;
}

export interface TimelineEntry {
  readonly id: TimelineEntryId;
  readonly type: IncidentTimelineType;
  readonly actor: SlackUserId;
  readonly at: Date;
  readonly summary: string;
  readonly metadata: Record<string, unknown>;
}

export interface ActivityEntry {
  readonly id: ActivityEntryId;
  readonly at: Date;
  readonly actor: SlackUserId;
  readonly kind: string;
  readonly detail: string;
  readonly metadata: Record<string, unknown>;
}

export interface StateTransition {
  readonly from: IncidentStatus;
  readonly to: IncidentStatus;
  readonly actor: SlackUserId;
  readonly at: Date;
}

export interface ResolutionPacket {
  readonly resolvedBy: SlackUserId;
  readonly resolvedAt: Date;
  readonly summary: string;
  readonly finalSeverity: IncidentSeverity;
  readonly affectedService: string;
  readonly mitigation: string;
}

export interface CancelInfo {
  readonly actor: SlackUserId;
  readonly reason: string;
  readonly at: Date;
}

export interface CloseInfo {
  readonly actor: SlackUserId;
  readonly at: Date;
}

export interface IncidentProps {
  readonly id: IncidentId;
  readonly teamId: TeamId;
  readonly organizationId?: string | undefined;
  title: string;
  description: string;
  incidentType: string;
  affectedService: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  channelId: SlackChannelId | null;
  channelName: string | null;
  channelPermalink: string | null;
  originChannelId: SlackChannelId | null;
  originMessageTs: MessageTs | null;
  controlMessageTs: MessageTs | null;
  reporterId: SlackUserId;
  currentRoles: Partial<Record<IncidentRole, SlackUserId | null>>;
  roleHistory: RoleAssignment[];
  participants: Participant[];
  updates: IncidentUpdate[];
  actions: IncidentAction[];
  followUps: IncidentFollowUp[];
  escalations: IncidentEscalation[];
  messageRefs: SlackMessageRef[];
  timeline: TimelineEntry[];
  activity: ActivityEntry[];
  transitions: StateTransition[];
  severityHistory: Array<{
    from: IncidentSeverity;
    to: IncidentSeverity;
    actor: SlackUserId;
    at: Date;
  }>;
  resolution: ResolutionPacket | null;
  cancelInfo: CancelInfo | null;
  closeInfo: CloseInfo | null;
  investigationId: string | null;
  readonly createdAt: Date;
  updatedAt: Date;
}

export interface DeclareIncidentParams {
  readonly teamId: TeamId;
  readonly organizationId?: string;
  readonly title: string;
  readonly description?: string;
  readonly incidentType?: string;
  readonly affectedService?: string;
  readonly severity?: IncidentSeverity;
  readonly reporterId: SlackUserId;
  readonly originChannelId?: SlackChannelId | null;
  readonly originMessageTs?: MessageTs | null;
  readonly idempotencyKey?: string;
}

export class Incident {
  private _events: IncidentDomainEvent[] = [];

  readonly id: IncidentId;
  readonly teamId: TeamId;
  readonly organizationId: string | undefined;
  readonly reporterId: SlackUserId;
  readonly createdAt: Date;

  title: string;
  description: string;
  incidentType: string;
  affectedService: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  channelId: SlackChannelId | null;
  channelName: string | null;
  channelPermalink: string | null;
  originChannelId: SlackChannelId | null;
  originMessageTs: MessageTs | null;
  controlMessageTs: MessageTs | null;
  currentRoles: Partial<Record<IncidentRole, SlackUserId | null>>;
  roleHistory: RoleAssignment[];
  participants: Participant[];
  updates: IncidentUpdate[];
  actions: IncidentAction[];
  followUps: IncidentFollowUp[];
  escalations: IncidentEscalation[];
  messageRefs: SlackMessageRef[];
  timeline: TimelineEntry[];
  activity: ActivityEntry[];
  transitions: StateTransition[];
  severityHistory: IncidentProps["severityHistory"];
  resolution: ResolutionPacket | null;
  cancelInfo: CancelInfo | null;
  closeInfo: CloseInfo | null;
  investigationId: string | null;
  updatedAt: Date;

  private constructor(props: IncidentProps) {
    this.id = props.id;
    this.teamId = props.teamId;
    this.organizationId = props.organizationId;
    this.reporterId = props.reporterId;
    this.createdAt = props.createdAt;
    this.title = props.title;
    this.description = props.description;
    this.incidentType = props.incidentType;
    this.affectedService = props.affectedService;
    this.severity = props.severity;
    this.status = props.status;
    this.channelId = props.channelId;
    this.channelName = props.channelName;
    this.channelPermalink = props.channelPermalink;
    this.originChannelId = props.originChannelId;
    this.originMessageTs = props.originMessageTs;
    this.controlMessageTs = props.controlMessageTs;
    this.currentRoles = { ...props.currentRoles };
    this.roleHistory = [...props.roleHistory];
    this.participants = props.participants.map((p) => ({ ...p, sources: [...p.sources] }));
    this.updates = [...props.updates];
    this.actions = props.actions.map((a) => ({ ...a }));
    this.followUps = props.followUps.map((f) => ({ ...f }));
    this.escalations = [...props.escalations];
    this.messageRefs = [...props.messageRefs];
    this.timeline = [...props.timeline];
    this.activity = [...props.activity];
    this.transitions = [...props.transitions];
    this.severityHistory = [...props.severityHistory];
    this.resolution = props.resolution;
    this.cancelInfo = props.cancelInfo;
    this.closeInfo = props.closeInfo;
    this.investigationId = props.investigationId;
    this.updatedAt = props.updatedAt;
  }

  static declare(params: DeclareIncidentParams): Incident {
    const now = new Date();
    const title = params.title.trim().slice(0, 200);
    if (!title) throw new Error("Incident title is required");
    const incident = new Incident({
      id: randomUUID(),
      teamId: params.teamId,
      organizationId: params.organizationId,
      title,
      description: (params.description ?? "").slice(0, 4000),
      incidentType: (params.incidentType ?? "operational").slice(0, 100),
      affectedService: (params.affectedService ?? "").slice(0, 200),
      severity: params.severity ?? IncidentSeverity.Minor,
      status: IncidentStatus.Detected,
      channelId: null,
      channelName: null,
      channelPermalink: null,
      originChannelId: params.originChannelId ?? null,
      originMessageTs: params.originMessageTs ?? null,
      controlMessageTs: null,
      reporterId: params.reporterId,
      currentRoles: {},
      roleHistory: [],
      participants: [{ userId: params.reporterId, sources: ["reporter"], joinedAt: now }],
      updates: [],
      actions: [],
      followUps: [],
      escalations: [],
      messageRefs: [],
      timeline: [],
      activity: [],
      transitions: [],
      severityHistory: [],
      resolution: null,
      cancelInfo: null,
      closeInfo: null,
      investigationId: null,
      createdAt: now,
      updatedAt: now,
    });
    incident.addTimeline(IncidentTimelineType.Declared, params.reporterId, `Incident declared: ${title}`, {
      severity: incident.severity,
    });
    incident.addActivity(params.reporterId, "declared", `Incident declared with severity ${incident.severity}`, {
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    });
    incident.emit("incident.created", params.reporterId, { title });
    return incident;
  }

  static reconstitute(props: IncidentProps): Incident {
    return new Incident(props);
  }

  toProps(): IncidentProps {
    return {
      id: this.id,
      teamId: this.teamId,
      organizationId: this.organizationId,
      title: this.title,
      description: this.description,
      incidentType: this.incidentType,
      affectedService: this.affectedService,
      severity: this.severity,
      status: this.status,
      channelId: this.channelId,
      channelName: this.channelName,
      channelPermalink: this.channelPermalink,
      originChannelId: this.originChannelId,
      originMessageTs: this.originMessageTs,
      controlMessageTs: this.controlMessageTs,
      reporterId: this.reporterId,
      currentRoles: { ...this.currentRoles },
      roleHistory: [...this.roleHistory],
      participants: this.participants.map((p) => ({ ...p, sources: [...p.sources] })),
      updates: [...this.updates],
      actions: this.actions.map((a) => ({ ...a })),
      followUps: this.followUps.map((f) => ({ ...f })),
      escalations: [...this.escalations],
      messageRefs: [...this.messageRefs],
      timeline: [...this.timeline],
      activity: [...this.activity],
      transitions: [...this.transitions],
      severityHistory: [...this.severityHistory],
      resolution: this.resolution,
      cancelInfo: this.cancelInfo,
      closeInfo: this.closeInfo,
      investigationId: this.investigationId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  pullEvents(): IncidentDomainEvent[] {
    const events = [...this._events];
    this._events = [];
    return events;
  }

  // ---------- channel ----------

  attachChannel(actor: SlackUserId, channelId: SlackChannelId, channelName: string, permalink: string | null): void {
    if (this.channelId && this.channelId !== channelId) {
      throw new Error("Incident already has a different channel attached");
    }
    this.channelId = channelId;
    this.channelName = channelName;
    this.channelPermalink = permalink;
    this.touch();
    this.addActivity(actor, "channel_attached", `Channel #${channelName} attached`, { channelId });
  }

  setControlMessage(ts: MessageTs): void {
    this.controlMessageTs = ts;
    this.touch();
  }

  // ---------- rename ----------

  rename(actor: SlackUserId, title: string): void {
    const next = title.trim().slice(0, 200);
    if (!next) throw new Error("Incident title is required");
    const from = this.title;
    this.title = next;
    this.touch();
    this.addTimeline(IncidentTimelineType.Renamed, actor, `Incident renamed to "${next}"`, { from, to: next });
    this.addActivity(actor, "renamed", `Renamed from "${from}" to "${next}"`, { from, to: next });
    this.emit("incident.renamed", actor, { from, to: next });
  }

  // ---------- severity ----------

  setSeverity(actor: SlackUserId, severity: IncidentSeverity): void {
    if (severity === this.severity) return;
    const from = this.severity;
    this.severity = severity;
    this.severityHistory.push({ from, to: severity, actor, at: new Date() });
    this.touch();
    this.addTimeline(IncidentTimelineType.SeverityChanged, actor, `Severity changed from ${from} to ${severity}`, {
      from,
      to: severity,
    });
    this.addActivity(actor, "severity_changed", `Severity ${from} → ${severity}`, { from, to: severity });
    this.emit("incident.severity_changed", actor, { from, to: severity });
  }

  // ---------- status ----------

  changeStatus(actor: SlackUserId, to: IncidentStatus): void {
    if (!canTransitionIncident(this.status, to)) {
      throw new InvalidIncidentTransitionError(this.status, to);
    }
    const from = this.status;
    this.status = to;
    this.transitions.push({ from, to, actor, at: new Date() });
    this.touch();
    this.addTimeline(IncidentTimelineType.StatusChanged, actor, `Status changed from ${from} to ${to}`, { from, to });
    this.addActivity(actor, "status_changed", `Status ${from} → ${to}`, { from, to });
    this.emit("incident.status_changed", actor, { from, to });
  }

  // ---------- roles ----------

  assignRole(actor: SlackUserId, role: IncidentRole, assignee: SlackUserId): void {
    const current = this.currentRoles[role] ?? null;
    const action = current === null ? "assigned" : current === assignee ? "assigned" : "reassigned";
    if (current === assignee) return;
    this.currentRoles[role] = assignee;
    this.roleHistory.push({ id: randomUUID(), role, assignee, actor, at: new Date(), action });
    this.ensureParticipant(assignee, "role_assigned");
    this.touch();
    const type =
      action === "assigned" ? IncidentTimelineType.RoleAssigned : IncidentTimelineType.RoleReassigned;
    this.addTimeline(type, actor, `${role} ${action} to <@${assignee}>`, { role, assignee, previous: current });
    this.addActivity(actor, `role_${action}`, `${role} → <@${assignee}> (was ${current ?? "vacant"})`, {
      role,
      assignee,
      previous: current,
    });
    this.emit("incident.role_assigned", actor, { role, assignee, previous: current });
  }

  unassignRole(actor: SlackUserId, role: IncidentRole): void {
    const current = this.currentRoles[role] ?? null;
    if (current === null) return;
    this.currentRoles[role] = null;
    this.roleHistory.push({ id: randomUUID(), role, assignee: null, actor, at: new Date(), action: "unassigned" });
    this.touch();
    this.addTimeline(IncidentTimelineType.RoleUnassigned, actor, `${role} unassigned (was <@${current}>)`, {
      role,
      previous: current,
    });
    this.addActivity(actor, "role_unassigned", `${role} unassigned`, { role, previous: current });
    this.emit("incident.role_unassigned", actor, { role, previous: current });
  }

  // ---------- participants ----------

  ensureParticipant(userId: SlackUserId, source: ParticipantSource): void {
    const existing = this.participants.find((p) => p.userId === userId);
    if (existing) {
      if (!existing.sources.includes(source)) {
        this.participants = this.participants.map((p) =>
          p.userId === userId ? { ...p, sources: [...p.sources, source] } : p,
        );
      }
      return;
    }
    this.participants.push({ userId, sources: [source], joinedAt: new Date() });
    this.touch();
    this.addActivity(userId, "participant_added", `Participant added via ${source}`, { source });
    this.emit("incident.participant_added", userId, { source });
  }

  // ---------- updates ----------

  postUpdate(
    author: SlackUserId,
    fields: { situation: string; changed: string; impact: string; nextStep: string },
  ): IncidentUpdate {
    for (const [k, v] of Object.entries(fields)) {
      if (!v || !v.trim()) throw new Error(`Update field "${k}" is required`);
    }
    const update: IncidentUpdate = {
      id: randomUUID(),
      author,
      at: new Date(),
      situation: fields.situation.slice(0, 2000),
      changed: fields.changed.slice(0, 2000),
      impact: fields.impact.slice(0, 2000),
      nextStep: fields.nextStep.slice(0, 2000),
    };
    this.updates.push(update);
    this.ensureParticipant(author, "interacted");
    this.touch();
    this.addTimeline(IncidentTimelineType.UpdatePosted, author, `Update posted by <@${author}>`, {
      updateId: update.id,
    });
    this.addActivity(author, "update_posted", `Update ${update.id}`, { updateId: update.id });
    this.emit("incident.update_posted", author, { updateId: update.id });
    return update;
  }

  // ---------- actions ----------

  createAction(
    actor: SlackUserId,
    params: {
      title: string;
      description?: string;
      assignee?: SlackUserId | null;
      priority?: string;
      dueAt?: Date | null;
    },
  ): IncidentAction {
    const title = params.title.trim().slice(0, 200);
    if (!title) throw new Error("Action title is required");
    const action: IncidentAction = {
      id: randomUUID(),
      title,
      description: (params.description ?? "").slice(0, 2000),
      assignee: params.assignee ?? null,
      priority: (params.priority ?? "P2").slice(0, 20),
      dueAt: params.dueAt ?? null,
      status: "OPEN",
      createdBy: actor,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.actions.push(action);
    if (action.assignee) this.ensureParticipant(action.assignee, "interacted");
    this.touch();
    this.addTimeline(IncidentTimelineType.ActionCreated, actor, `Action created: ${title}`, {
      actionId: action.id,
      assignee: action.assignee,
    });
    this.addActivity(actor, "action_created", `Action ${action.id} created`, { actionId: action.id });
    this.emit("incident.action_created", actor, { actionId: action.id, title });
    return { ...action };
  }

  updateAction(
    actor: SlackUserId,
    actionId: ActionId,
    patch: { status?: ActionStatus; assignee?: SlackUserId | null; title?: string; description?: string },
  ): IncidentAction {
    const action = this.actions.find((a) => a.id === actionId);
    if (!action) throw new Error(`Action not found: ${actionId}`);
    if (patch.status) {
      const order: ActionStatus[] = ["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "NOT_DOING"];
      if (!order.includes(patch.status)) throw new Error(`Invalid action status: ${patch.status}`);
      action.status = patch.status;
    }
    if (patch.assignee !== undefined) {
      action.assignee = patch.assignee;
      if (patch.assignee) this.ensureParticipant(patch.assignee, "interacted");
    }
    if (patch.title !== undefined) {
      const t = patch.title.trim().slice(0, 200);
      if (!t) throw new Error("Action title is required");
      action.title = t;
    }
    if (patch.description !== undefined) {
      action.description = patch.description.slice(0, 2000);
    }
    action.updatedAt = new Date();
    this.touch();
    const completed = patch.status === "DONE";
    this.addTimeline(
      completed ? IncidentTimelineType.ActionCompleted : IncidentTimelineType.ActionUpdated,
      actor,
      `Action "${action.title}" → ${action.status}`,
      { actionId, status: action.status },
    );
    this.addActivity(actor, "action_updated", `Action ${actionId} → ${action.status}`, {
      actionId,
      status: action.status,
    });
    this.emit(completed ? "incident.action_completed" : "incident.action_updated", actor, {
      actionId,
      status: action.status,
    });
    return { ...action };
  }

  openActions(): IncidentAction[] {
    return this.actions.filter((a) => a.status !== "DONE" && a.status !== "NOT_DOING");
  }

  // ---------- follow-ups ----------

  createFollowUp(
    actor: SlackUserId,
    params: { title: string; description?: string; assignee?: SlackUserId | null; dueAt?: Date | null },
  ): IncidentFollowUp {
    const title = params.title.trim().slice(0, 200);
    if (!title) throw new Error("Follow-up title is required");
    const followUp: IncidentFollowUp = {
      id: randomUUID(),
      title,
      description: (params.description ?? "").slice(0, 2000),
      assignee: params.assignee ?? null,
      dueAt: params.dueAt ?? null,
      status: "OPEN",
      createdBy: actor,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.followUps.push(followUp);
    this.touch();
    this.addTimeline(IncidentTimelineType.FollowUpCreated, actor, `Follow-up created: ${title}`, {
      followUpId: followUp.id,
    });
    this.addActivity(actor, "followup_created", `Follow-up ${followUp.id} created`, { followUpId: followUp.id });
    this.emit("incident.followup_created", actor, { followUpId: followUp.id, title });
    return { ...followUp };
  }

  updateFollowUp(actor: SlackUserId, followUpId: FollowUpId, patch: { status?: FollowUpStatus }): IncidentFollowUp {
    const followUp = this.followUps.find((f) => f.id === followUpId);
    if (!followUp) throw new Error(`Follow-up not found: ${followUpId}`);
    if (patch.status) {
      const order: FollowUpStatus[] = ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"];
      if (!order.includes(patch.status)) throw new Error(`Invalid follow-up status: ${patch.status}`);
      followUp.status = patch.status;
    }
    followUp.updatedAt = new Date();
    this.touch();
    this.addActivity(actor, "followup_updated", `Follow-up ${followUpId} → ${followUp.status}`, {
      followUpId,
      status: followUp.status,
    });
    this.emit("incident.followup_updated", actor, { followUpId, status: followUp.status });
    return { ...followUp };
  }

  openFollowUps(): IncidentFollowUp[] {
    return this.followUps.filter((f) => f.status === "OPEN" || f.status === "IN_PROGRESS");
  }

  // ---------- escalation / handover ----------

  escalate(actor: SlackUserId, toUser: SlackUserId, reason: string): IncidentEscalation {
    const r = reason.trim().slice(0, 1000);
    if (!r) throw new Error("Escalation reason is required");
    const escalation: IncidentEscalation = { id: randomUUID(), toUser, reason: r, actor, at: new Date() };
    this.escalations.push(escalation);
    this.ensureParticipant(toUser, "escalated");
    this.touch();
    this.addTimeline(IncidentTimelineType.EscalationCreated, actor, `Escalated to <@${toUser}>: ${r}`, {
      escalationId: escalation.id,
      toUser,
    });
    this.addActivity(actor, "escalated", `Escalated to ${toUser}`, { escalationId: escalation.id, toUser });
    this.emit("incident.escalated", actor, { escalationId: escalation.id, toUser, reason: r });
    return escalation;
  }

  handover(actor: SlackUserId, newCommander: SlackUserId): void {
    const previous = this.currentRoles[IncidentRole.IncidentLead] ?? null;
    if (previous === newCommander) return;
    this.currentRoles[IncidentRole.IncidentLead] = newCommander;
    this.roleHistory.push({
      id: randomUUID(),
      role: IncidentRole.IncidentLead,
      assignee: newCommander,
      actor,
      at: new Date(),
      action: previous === null ? "assigned" : "reassigned",
    });
    this.ensureParticipant(newCommander, "role_assigned");
    this.touch();
    this.addTimeline(IncidentTimelineType.HandoverCompleted, actor, `Lead handed over to <@${newCommander}>`, {
      previous,
      newCommander,
    });
    this.addActivity(actor, "handover", `Lead ${previous ?? "vacant"} → ${newCommander}`, {
      previous,
      newCommander,
    });
    this.emit("incident.handover", actor, { previous, newCommander });
  }

  // ---------- message refs ----------

  addMessageRef(actor: SlackUserId, ref: Omit<SlackMessageRef, "addedBy" | "addedAt">): SlackMessageRef {
    const duplicate = this.messageRefs.some(
      (m) => m.channelId === ref.channelId && m.messageTs === ref.messageTs,
    );
    if (duplicate) throw new Error("Message already added to timeline");
    const entry: SlackMessageRef = { ...ref, text: ref.text.slice(0, 2000), addedBy: actor, addedAt: new Date() };
    this.messageRefs.push(entry);
    this.touch();
    this.addTimeline(IncidentTimelineType.MessageAdded, actor, `Message added to timeline (${ref.messageTs})`, {
      channelId: ref.channelId,
      messageTs: ref.messageTs,
    });
    this.addActivity(actor, "message_added", `Message ${ref.messageTs} pinned to timeline`, {
      channelId: ref.channelId,
      messageTs: ref.messageTs,
    });
    this.emit("incident.message_added", actor, { channelId: ref.channelId, messageTs: ref.messageTs });
    return entry;
  }

  // ---------- resolve / cancel / close ----------

  resolve(
    actor: SlackUserId,
    packet: { summary: string; affectedService?: string; mitigation?: string },
  ): ResolutionPacket {
    if (this.status === IncidentStatus.Closed || this.status === IncidentStatus.Cancelled) {
      throw new Error(`Cannot resolve an incident with status "${this.status}"`);
    }
    // Direct resolution is allowed from any open state ("allow direct
    // resolution when appropriate") — this intentionally bypasses the
    // manual changeStatus() matrix.
    if (this.status !== IncidentStatus.Resolved) {
      const from = this.status;
      this.status = IncidentStatus.Resolved;
      this.transitions.push({ from, to: IncidentStatus.Resolved, actor, at: new Date() });
      this.addTimeline(IncidentTimelineType.StatusChanged, actor, `Status changed from ${from} to resolved`, {
        from,
        to: IncidentStatus.Resolved,
      });
    }
    const summary = packet.summary.trim().slice(0, 2000);
    if (!summary) throw new Error("Resolution summary is required");
    this.resolution = {
      resolvedBy: actor,
      resolvedAt: new Date(),
      summary,
      finalSeverity: this.severity,
      affectedService: (packet.affectedService ?? this.affectedService).slice(0, 200),
      mitigation: (packet.mitigation ?? "").slice(0, 2000),
    };
    if (packet.affectedService) this.affectedService = packet.affectedService.slice(0, 200);
    this.touch();
    const outstanding = this.openFollowUps().length;
    this.addTimeline(IncidentTimelineType.Resolved, actor, `Incident resolved by <@${actor}>`, {
      outstandingFollowUps: outstanding,
    });
    this.addActivity(actor, "resolved", `Resolved (${outstanding} follow-ups open)`, {
      outstandingFollowUps: outstanding,
    });
    this.emit("incident.resolved", actor, { outstandingFollowUps: outstanding });
    return { ...this.resolution };
  }

  cancel(actor: SlackUserId, reason: string): void {
    const r = reason.trim().slice(0, 1000);
    if (!r) throw new Error("Cancellation reason is required");
    if (this.status === IncidentStatus.Closed) {
      throw new Error('Cannot cancel a closed incident');
    }
    // Cancellation is allowed from any open state — bypasses the manual
    // changeStatus() matrix like resolve() does.
    if (this.status !== IncidentStatus.Cancelled) {
      const from = this.status;
      this.status = IncidentStatus.Cancelled;
      this.transitions.push({ from, to: IncidentStatus.Cancelled, actor, at: new Date() });
      this.addTimeline(IncidentTimelineType.StatusChanged, actor, `Status changed from ${from} to cancelled`, {
        from,
        to: IncidentStatus.Cancelled,
      });
    }
    this.cancelInfo = { actor, reason: r, at: new Date() };
    this.touch();
    this.addTimeline(IncidentTimelineType.Cancelled, actor, `Incident cancelled: ${r}`, {});
    this.addActivity(actor, "cancelled", `Cancelled: ${r}`, {});
    this.emit("incident.cancelled", actor, { reason: r });
  }

  close(actor: SlackUserId): void {
    if (this.status !== IncidentStatus.Resolved && this.status !== IncidentStatus.Cancelled) {
      throw new Error(`Only resolved or cancelled incidents can be closed (currently "${this.status}")`);
    }
    if (!this.resolution && !this.cancelInfo) {
      throw new Error("Cannot close without resolution or cancellation record");
    }
    this.changeStatus(actor, IncidentStatus.Closed);
    this.closeInfo = { actor, at: new Date() };
    this.touch();
    const outstanding = this.openFollowUps().length;
    this.addTimeline(IncidentTimelineType.Closed, actor, `Incident closed by <@${actor}>`, {
      outstandingFollowUps: outstanding,
    });
    this.addActivity(actor, "closed", `Closed (${outstanding} follow-ups open)`, {
      outstandingFollowUps: outstanding,
    });
    this.emit("incident.closed", actor, { outstandingFollowUps: outstanding });
  }

  // ---------- helpers ----------

  private addTimeline(
    type: IncidentTimelineType,
    actor: SlackUserId,
    summary: string,
    metadata: Record<string, unknown>,
  ): void {
    this.timeline.push({ id: randomUUID(), type, actor, at: new Date(), summary, metadata });
  }

  private addActivity(actor: SlackUserId, kind: string, detail: string, metadata: Record<string, unknown>): void {
    this.activity.push({ id: randomUUID(), at: new Date(), actor, kind, detail, metadata });
  }

  private touch(): void {
    this.updatedAt = new Date();
  }

  private emit(eventType: IncidentEventType, actor: SlackUserId, payload: Record<string, unknown>): void {
    this._events.push({
      eventId: randomUUID(),
      eventType,
      occurredAt: new Date(),
      incidentId: this.id,
      actor,
      teamId: this.teamId,
      payload,
    });
  }
}
