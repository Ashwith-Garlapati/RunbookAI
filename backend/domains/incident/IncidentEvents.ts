/**
 * Incident Domain - Domain Events (deterministic coordination layer).
 *
 * Consumed by: curated timeline writer, activity log, audit log,
 * control-message updater, Slack notifier. No AI consumers.
 */

export type IncidentEventType =
  | "incident.created"
  | "incident.renamed"
  | "incident.status_changed"
  | "incident.severity_changed"
  | "incident.role_assigned"
  | "incident.role_acknowledged"
  | "incident.role_unassigned"
  | "incident.participant_added"
  | "incident.update_posted"
  | "incident.action_created"
  | "incident.action_updated"
  | "incident.action_completed"
  | "incident.followup_created"
  | "incident.followup_updated"
  | "incident.escalated"
  | "incident.handover"
  | "incident.message_added"
  | "incident.channel_linked"
  | "incident.resolved"
  | "incident.cancelled"
  | "incident.closed";

export interface IncidentDomainEvent {
  readonly eventId: string;
  readonly eventType: IncidentEventType;
  readonly occurredAt: Date;
  readonly incidentId: string;
  readonly actor: string;
  readonly teamId: string;
  readonly payload: Record<string, unknown>;
}

/** Curated timeline event types (human-readable, never rewritten). */
export enum IncidentTimelineType {
  Declared = "INCIDENT_DECLARED",
  SeverityChanged = "SEVERITY_CHANGED",
  StatusChanged = "STATUS_CHANGED",
  RoleAssigned = "ROLE_ASSIGNED",
  RoleReassigned = "ROLE_REASSIGNED",
  RoleAcknowledged = "ROLE_ACKNOWLEDGED",
  RoleUnassigned = "ROLE_UNASSIGNED",
  ActionCreated = "ACTION_CREATED",
  ActionUpdated = "ACTION_UPDATED",
  ActionCompleted = "ACTION_COMPLETED",
  FollowUpCreated = "FOLLOW_UP_CREATED",
  UpdatePosted = "UPDATE_POSTED",
  MessageAdded = "MESSAGE_ADDED_TO_TIMELINE",
  ChannelLinked = "CHANNEL_LINKED",
  EscalationCreated = "ESCALATION_CREATED",
  HandoverCompleted = "HANDOVER_COMPLETED",
  Renamed = "INCIDENT_RENAMED",
  Resolved = "INCIDENT_RESOLVED",
  Reopened = "INCIDENT_REOPENED",
  Cancelled = "INCIDENT_CANCELLED",
  Closed = "INCIDENT_CLOSED",
}
