/**
 * Incident Commander acknowledgement tests: provisional assignment at declare,
 * pending→active, idempotent double-accept, handover resets to pending.
 */

import { describe, it, expect } from "vitest";

import { Incident } from "../domains/incident/Incident.js";
import { IncidentRole } from "../domains/incident/IncidentRoles.js";
import { IncidentCoordinator } from "../domains/incident/IncidentCoordinator.js";
import { IncidentBus } from "../domains/incident/IncidentBus.js";
import type {
  IIncidentRepository,
  IIdempotencyStore,
  IMembershipResolver,
} from "../domains/incident/IncidentRepository.js";
import { MembershipLevel } from "../domains/incident/IncidentRoles.js";

class FakeRepo implements IIncidentRepository {
  readonly store = new Map<string, Incident>();
  async create(i: Incident): Promise<Incident> {
    this.store.set(i.id, i);
    return i;
  }
  async update(i: Incident): Promise<Incident> {
    this.store.set(i.id, i);
    return i;
  }
  async findById(id: string): Promise<Incident | null> {
    return this.store.get(id) ?? null;
  }
  async findByTeamAndChannel(): Promise<Incident | null> {
    return null;
  }
  async findByIdempotencyKey(): Promise<Incident | null> {
    return null;
  }
  async findOpenByTeam(): Promise<Incident[]> {
    return [];
  }
  async listByTeam(): Promise<Incident[]> {
    return [];
  }
}

class FakeIdempotency implements IIdempotencyStore {
  async claim(): Promise<boolean> {
    return true;
  }
  async release(): Promise<void> {}
}

const membership: IMembershipResolver = {
  resolveLevel: async (_team, user) =>
    user === "U_lead" || user === "U_lead2" ? MembershipLevel.Responder : MembershipLevel.Member,
};

function setup() {
  const bus = new IncidentBus();
  const events: string[] = [];
  bus.subscribe("*", { handle: async (e) => void events.push(e.eventType) });
  const coord = new IncidentCoordinator(new FakeRepo(), bus, new FakeIdempotency(), membership);
  return { coord, events };
}

describe("Incident Commander acknowledgement", () => {
  it("assigns provisional lead at declare as pending_ack", async () => {
    const { coord, events } = setup();
    const inc = await coord.declare({
      teamId: "T1",
      title: "db down",
      reporterId: "U_rep",
      defaultCommanderId: "U_lead",
      correlationId: "c-1",
    });
    expect(inc.currentRoles[IncidentRole.IncidentCommander]).toBe("U_lead");
    expect(inc.assignmentState(IncidentRole.IncidentCommander)).toBe("pending_ack");
    expect(events).toContain("incident.role_assigned");
  });

  it("accept transitions pending_ack → active, idempotent on repeat", async () => {
    const { coord } = setup();
    const inc = await coord.declare({
      teamId: "T1",
      title: "x",
      reporterId: "U_rep",
      defaultCommanderId: "U_lead",
      correlationId: "c-1",
    });
    const ctx = { teamId: "T1", actor: "U_lead", correlationId: "c-2" };
    const acked = await coord.acknowledgeRole(ctx, inc.id, IncidentRole.IncidentCommander);
    expect(acked.assignmentState(IncidentRole.IncidentCommander)).toBe("active");
    const timelineBefore = acked.timeline.length;
    const again = await coord.acknowledgeRole(ctx, inc.id, IncidentRole.IncidentCommander);
    expect(again.timeline).toHaveLength(timelineBefore);
  });

  it("rejects acknowledgement by an unrelated member", async () => {
    const { coord } = setup();
    const inc = await coord.declare({
      teamId: "T1",
      title: "x",
      reporterId: "U_rep",
      defaultCommanderId: "U_lead",
      correlationId: "c-1",
    });
    await expect(
      coord.acknowledgeRole({ teamId: "T1", actor: "U_stranger", correlationId: "c-2" }, inc.id, IncidentRole.IncidentCommander),
    ).rejects.toThrow(/may not perform/);
  });

  it("handover resets the new lead to pending_ack", async () => {
    const { coord } = setup();
    const inc = await coord.declare({
      teamId: "T1",
      title: "x",
      reporterId: "U_rep",
      defaultCommanderId: "U_lead",
      correlationId: "c-1",
    });
    await coord.acknowledgeRole({ teamId: "T1", actor: "U_lead", correlationId: "c-2" }, inc.id, IncidentRole.IncidentCommander);
    // Handover requires commander level: lead holder resolves as responder,
    // so use the membership override via a commander actor instead.
    const commanderMembership: IMembershipResolver = {
      resolveLevel: async () => MembershipLevel.Commander,
    };
    const bus2 = new IncidentBus();
    const repo2 = new FakeRepo();
    await repo2.create(inc);
    const coord2 = new IncidentCoordinator(repo2, bus2, new FakeIdempotency(), commanderMembership);
    const handed = await coord2.handover(
      { teamId: "T1", actor: "U_lead", correlationId: "c-3" },
      inc.id,
      "U_lead2",
    );
    expect(handed.assignmentState(IncidentRole.IncidentCommander)).toBe("pending_ack");
    expect(handed.roleHistory.filter((h) => h.assignee === "U_lead2")[0]?.acknowledgedAt).toBe(null);
  });
});
