/**
 * Incident Domain - Authorization matrix.
 *
 * Slack identity is NEVER trusted alone: callers resolve a Slack user to a
 * MembershipLevel first (workspace membership + incident-scoped commander
 * override), then check the operation matrix here, server-side.
 */

import { IncidentRole, MembershipLevel, levelAtLeast } from "./IncidentRoles.js";

export type IncidentOperation =
  | "declare"
  | "view"
  | "post_update"
  | "add_message_ref"
  | "create_action"
  | "update_action"
  | "create_followup"
  | "update_followup"
  | "change_severity"
  | "change_status"
  | "assign_role"
  | "assign_commander"
  | "escalate"
  | "handover"
  | "rename"
  | "resolve"
  | "cancel"
  | "close";

const MINIMUM_LEVEL: Readonly<Record<IncidentOperation, MembershipLevel>> = {
  declare: MembershipLevel.Member,
  view: MembershipLevel.Member,
  post_update: MembershipLevel.Member,
  add_message_ref: MembershipLevel.Member,
  create_action: MembershipLevel.Responder,
  update_action: MembershipLevel.Responder,
  create_followup: MembershipLevel.Responder,
  update_followup: MembershipLevel.Responder,
  change_severity: MembershipLevel.Responder,
  change_status: MembershipLevel.Responder,
  assign_role: MembershipLevel.Responder,
  assign_commander: MembershipLevel.Commander,
  escalate: MembershipLevel.Responder,
  handover: MembershipLevel.Commander,
  rename: MembershipLevel.Responder,
  resolve: MembershipLevel.Commander,
  cancel: MembershipLevel.Commander,
  close: MembershipLevel.Commander,
};

export function canPerform(level: MembershipLevel, op: IncidentOperation): boolean {
  return levelAtLeast(level, MINIMUM_LEVEL[op]);
}

/**
 * The single Incident Lead seat requires responder level (so the reporter,
 * who is auto-registered as a participant, can assign it). Handover of the
 * seat stays commander-level and is held by the current lead.
 */
export function canAssignRole(level: MembershipLevel, _role: IncidentRole): boolean {
  return levelAtLeast(level, MembershipLevel.Responder);
}

export class IncidentAuthorizationError extends Error {
  readonly operation: IncidentOperation;
  constructor(operation: IncidentOperation, level: MembershipLevel) {
    super(`Membership level "${level}" may not perform "${operation}"`);
    this.name = "IncidentAuthorizationError";
    this.operation = operation;
  }
}
