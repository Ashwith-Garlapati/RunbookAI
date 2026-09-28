/**
 * Incident Domain - First-class roles + membership levels.
 *
 * Role assignments are append-only history: assign/reassign/unassign each
 * record { incident, role, assignee, actor, timestamp }.
 */

export enum IncidentRole {
  IncidentLead = "incident_lead",
}

export const INCIDENT_ROLES: readonly IncidentRole[] = [IncidentRole.IncidentLead];

export const ROLE_LABELS: Readonly<Record<IncidentRole, string>> = {
  [IncidentRole.IncidentLead]: "Incident Lead",
};

export function parseRole(input: unknown): IncidentRole | undefined {
  if (typeof input !== "string") return undefined;
  const v = input.trim().toLowerCase().replace(/[_\s-]/g, "");
  if (["incidentlead", "lead", "incidentcommander", "commander", "ic"].includes(v))
    return IncidentRole.IncidentLead;
  return undefined;
}

/** Organization membership levels (least → most privilege). */
export enum MembershipLevel {
  Member = "member",
  Responder = "responder",
  Commander = "commander",
  Admin = "admin",
  Owner = "owner",
}

const LEVEL_RANK: Readonly<Record<MembershipLevel, number>> = {
  [MembershipLevel.Member]: 0,
  [MembershipLevel.Responder]: 1,
  [MembershipLevel.Commander]: 2,
  [MembershipLevel.Admin]: 3,
  [MembershipLevel.Owner]: 4,
};

export function levelAtLeast(level: MembershipLevel, minimum: MembershipLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[minimum];
}
