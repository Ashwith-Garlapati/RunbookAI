/**
 * Incident aggregate unit tests (deterministic coordination, no AI).
 */

import { describe, it, expect } from "vitest";

import { Incident } from "../domains/incident/Incident.js";
import { IncidentStatus } from "../domains/incident/IncidentStatus.js";
import { IncidentSeverity } from "../domains/incident/IncidentSeverity.js";
import { IncidentRole } from "../domains/incident/IncidentRoles.js";

function declareBasic() {
  return Incident.declare({
    teamId: "T1",
    title: "Checkout API 500s",
    reporterId: "U1",
    severity: IncidentSeverity.Major,
  });
}

describe("Incident lifecycle", () => {
  it("declares in detected status with timeline + activity", () => {
    const inc = declareBasic();
    expect(inc.status).toBe(IncidentStatus.Detected);
    expect(inc.severity).toBe(IncidentSeverity.Major);
    expect(inc.timeline).toHaveLength(1);
    expect(inc.pullEvents()).toHaveLength(1);
  });

  it("walks the happy path to closed", () => {
    const inc = declareBasic();
    inc.pullEvents();
    inc.changeStatus("U1", IncidentStatus.Investigating);
    inc.changeStatus("U1", IncidentStatus.Mitigating);
    inc.changeStatus("U1", IncidentStatus.Monitoring);
    inc.resolve("U2", { summary: "restarted pool" });
    expect(inc.status).toBe(IncidentStatus.Resolved);
    expect(inc.resolution?.resolvedBy).toBe("U2");
    inc.close("U2");
    expect(inc.status).toBe(IncidentStatus.Closed);
    expect(inc.closeInfo?.actor).toBe("U2");
  });

  it("rejects invalid transitions", () => {
    const inc = declareBasic();
    expect(() => inc.changeStatus("U1", IncidentStatus.Closed)).toThrow(/Invalid incident transition/);
    expect(() => inc.changeStatus("U1", IncidentStatus.Monitoring)).toThrow();
  });

  it("supports direct resolve and cancel branches", () => {
    const a = declareBasic();
    a.changeStatus("U1", IncidentStatus.Investigating);
    a.resolve("U1", { summary: "false alarm fixed" });
    expect(a.status).toBe(IncidentStatus.Resolved);

    const b = declareBasic();
    b.changeStatus("U1", IncidentStatus.Cancelled);
    expect(b.status).toBe(IncidentStatus.Cancelled);
    b.cancel("U1", "duplicate of #12");
    b.close("U1");
    expect(b.status).toBe(IncidentStatus.Closed);
  });

  it("requires resolution info and close guards", () => {
    const inc = declareBasic();
    expect(() => inc.close("U1")).toThrow();
    expect(() => inc.resolve("U1", { summary: "  " })).toThrow();
  });

  it("tracks severity history", () => {
    const inc = declareBasic();
    inc.setSeverity("U1", IncidentSeverity.Critical);
    inc.setSeverity("U1", IncidentSeverity.Critical); // no-op
    expect(inc.severityHistory).toHaveLength(1);
    expect(inc.timeline.some((t) => t.type === "SEVERITY_CHANGED")).toBe(true);
  });

  it("manages roles with history", () => {
    const inc = declareBasic();
    inc.assignRole("U1", IncidentRole.IncidentLead, "U2");
    inc.assignRole("U1", IncidentRole.IncidentLead, "U2"); // no-op, same assignee
    inc.assignRole("U1", IncidentRole.IncidentLead, "U3");
    expect(inc.currentRoles[IncidentRole.IncidentLead]).toBe("U3");
    inc.unassignRole("U1", IncidentRole.IncidentLead);
    inc.unassignRole("U1", IncidentRole.IncidentLead); // no-op, vacant
    expect(inc.currentRoles[IncidentRole.IncidentLead] ?? null).toBe(null);
    expect(inc.roleHistory).toHaveLength(3);
    expect(inc.participants.some((p) => p.userId === "U3")).toBe(true);
  });

  it("manages actions and follow-ups with open counts", () => {
    const inc = declareBasic();
    const action = inc.createAction("U1", { title: "Restart pool", assignee: "U2" });
    inc.updateAction("U2", action.id, { status: "IN_PROGRESS" });
    inc.updateAction("U2", action.id, { status: "DONE" });
    expect(inc.openActions()).toHaveLength(0);
    const fu = inc.createFollowUp("U1", { title: "Add alert" });
    expect(inc.openFollowUps()).toHaveLength(1);
    inc.updateFollowUp("U1", fu.id, { status: "DONE" });
    expect(inc.openFollowUps()).toHaveLength(0);
  });

  it("escalates, hands over, and pins message refs without duplicates", () => {
    const inc = declareBasic();
    inc.escalate("U1", "U9", "need DBA");
    inc.handover("U1", "U9");
    expect(inc.currentRoles[IncidentRole.IncidentLead]).toBe("U9");
    inc.addMessageRef("U1", {
      channelId: "C1",
      messageTs: "1.0",
      threadTs: null,
      author: "U2",
      text: "db is on fire",
      permalink: null,
    });
    expect(() =>
      inc.addMessageRef("U1", {
        channelId: "C1",
        messageTs: "1.0",
        threadTs: null,
        author: "U2",
        text: "dup",
        permalink: null,
      }),
    ).toThrow(/already added/);
  });

  it("preserves user wording in updates and validates fields", () => {
    const inc = declareBasic();
    const update = inc.postUpdate("U1", {
      situation: "  exact words  ",
      changed: "c",
      impact: "i",
      nextStep: "n",
    });
    expect(update.situation).toBe("  exact words  ".slice(0, 2000));
    expect(() => inc.postUpdate("U1", { situation: "", changed: "c", impact: "i", nextStep: "n" })).toThrow();
  });
});
