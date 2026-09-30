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
  | "acknowledge"
  | "assign_commander"
  | "escalate"
  | "handover"
  | "rename"
  | "link_channel"
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
  acknowledge: MembershipLevel.Member,
  assign_commander: MembershipLevel.Commander,
  escalate: MembershipLevel.Responder,
  handover: MembershipLevel.Commander,
  rename: MembershipLevel.Responder,
  link_channel: MembershipLevel.Responder,
  resolve: MembershipLevel.Commander,
  cancel: MembershipLevel.Commander,
  close: MembershipLevel.Commander,
};

export function canPerform(level: MembershipLevel, op: IncidentOperation): boolean {
  return levelAtLeast(level, MINIMUM_LEVEL[op]);
}

/**
 * Incident Commander assignment rule:
 * - vacant seat: responder level and above (reporter can take/fill it)
 * - occupied seat (reassign over someone): commander level and above
 *   (current commander, admin, owner). Members can never assign.
 */
export function canAssignRole(level: MembershipLevel, _role: IncidentRole, occupied: boolean): boolean {
  if (!occupied) return levelAtLeast(level, MembershipLevel.Responder);
  return levelAtLeast(level, MembershipLevel.Commander);
}

export class IncidentAuthorizationError extends Error {
  readonly operation: IncidentOperation;
  constructor(operation: IncidentOperation, level: MembershipLevel) {
    super(`Membership level "${level}" may not perform "${operation}"`);
    this.name = "IncidentAuthorizationError";
    this.operation = operation;
  }
}
