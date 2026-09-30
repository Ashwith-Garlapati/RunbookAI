/**
 * Permission matrix + membership resolver tests.
 */

import { describe, it, expect } from "vitest";

import { canPerform, canAssignRole } from "../domains/incident/IncidentPermissions.js";
import { DefaultMembershipResolver } from "../domains/incident/IncidentRepository.js";
import { MembershipLevel, IncidentRole } from "../domains/incident/IncidentRoles.js";
import { Incident } from "../domains/incident/Incident.js";

describe("permission matrix", () => {
  it("members can declare/view/update but not resolve", () => {
    expect(canPerform(MembershipLevel.Member, "declare")).toBe(true);
    expect(canPerform(MembershipLevel.Member, "post_update")).toBe(true);
    expect(canPerform(MembershipLevel.Member, "resolve")).toBe(false);
    expect(canPerform(MembershipLevel.Member, "create_action")).toBe(false);
  });

  it("responders manage work but not command", () => {
    expect(canPerform(MembershipLevel.Responder, "create_action")).toBe(true);
    expect(canPerform(MembershipLevel.Responder, "change_severity")).toBe(true);
    expect(canPerform(MembershipLevel.Responder, "handover")).toBe(false);
    expect(canPerform(MembershipLevel.Responder, "close")).toBe(false);
  });

  it("commanders own handover/resolve/cancel/close", () => {
    for (const op of ["handover", "resolve", "cancel", "close"] as const) {
      expect(canPerform(MembershipLevel.Commander, op)).toBe(true);
    }
  });

  it("commander seat: vacant needs responder, occupied needs commander", () => {
    // Vacant seat.
    expect(canAssignRole(MembershipLevel.Member, IncidentRole.IncidentCommander, false)).toBe(false);
    expect(canAssignRole(MembershipLevel.Responder, IncidentRole.IncidentCommander, false)).toBe(true);
    // Occupied seat (reassign over someone).
    expect(canAssignRole(MembershipLevel.Responder, IncidentRole.IncidentCommander, true)).toBe(false);
    expect(canAssignRole(MembershipLevel.Commander, IncidentRole.IncidentCommander, true)).toBe(true);
    expect(canAssignRole(MembershipLevel.Admin, IncidentRole.IncidentCommander, true)).toBe(true);
  });
});

describe("DefaultMembershipResolver", () => {
  it("maps owners/admins, commanders, participants, members", async () => {
    const resolver = new DefaultMembershipResolver(["U_owner"], ["U_admin"]);
    expect(await resolver.resolveLevel("T1", "U_owner")).toBe(MembershipLevel.Owner);
    expect(await resolver.resolveLevel("T1", "U_admin")).toBe(MembershipLevel.Admin);

    const inc = Incident.declare({ teamId: "T1", title: "x", reporterId: "U_rep" });
    inc.assignRole("U_rep", IncidentRole.IncidentCommander, "U_cmd");
    expect(await resolver.resolveLevel("T1", "U_cmd", inc)).toBe(MembershipLevel.Commander);
    expect(await resolver.resolveLevel("T1", "U_rep", inc)).toBe(MembershipLevel.Responder);
    expect(await resolver.resolveLevel("T1", "U_stranger", inc)).toBe(MembershipLevel.Member);
  });
});
