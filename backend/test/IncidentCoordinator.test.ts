/**
 * IncidentCoordinator tests: idempotent declare, authz, team isolation.
 */

import { describe, it, expect } from "vitest";

import { Incident } from "../domains/incident/Incident.js";
import { IncidentStatus } from "../domains/incident/IncidentStatus.js";
import { IncidentSeverity } from "../domains/incident/IncidentSeverity.js";
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
  readonly byKey = new Map<string, Incident>();
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
  async findByTeamAndChannel(teamId: string, channelId: string): Promise<Incident | null> {
    for (const i of this.store.values()) {
      if (i.teamId === teamId && i.channelId === channelId) return i;
    }
    return null;
  }
  async findByIdempotencyKey(teamId: string, key: string): Promise<Incident | null> {
    return this.byKey.get(`${teamId}:${key}`) ?? null;
  }
  async findOpenByTeam(teamId: string): Promise<Incident[]> {
    return [...this.store.values()].filter((i) => i.teamId === teamId);
  }
  async listByTeam(teamId: string): Promise<Incident[]> {
    return [...this.store.values()].filter((i) => i.teamId === teamId);
  }
  async linkIdempotencyKey(incidentId: string, key: string): Promise<void> {
    const i = this.store.get(incidentId);
    if (i) this.byKey.set(`${i.teamId}:${key}`, i);
  }
}

class FakeIdempotency implements IIdempotencyStore {
  readonly keys = new Set<string>();
  async claim(teamId: string, key: string): Promise<boolean> {
    const k = `${teamId}:${key}`;
    if (this.keys.has(k)) return false;
    this.keys.add(k);
    return true;
  }
  async release(teamId: string, key: string): Promise<void> {
    this.keys.delete(`${teamId}:${key}`);
  }
}

const membership: IMembershipResolver = {
  resolveLevel: async (_team, user) => (user === "U_cmd" ? MembershipLevel.Commander : MembershipLevel.Member),
};

function setup() {
  const repo = new FakeRepo();
  const bus = new IncidentBus();
  const published: string[] = [];
  bus.subscribe("*", { handle: async (e) => void published.push(e.eventType) });
  const coord = new IncidentCoordinator(repo, bus, new FakeIdempotency(), membership);
  return { repo, coord, published };
}

describe("IncidentCoordinator", () => {
  it("declares idempotently on the same key", async () => {
    const { coord, repo } = setup();
    const a = await coord.declare({
      teamId: "T1",
      title: "db down",
      reporterId: "U1",
      idempotencyKey: "k-1",
      correlationId: "c-1",
    });
    const b = await coord.declare({
      teamId: "T1",
      title: "db down",
      reporterId: "U1",
      idempotencyKey: "k-1",
      correlationId: "c-2",
    });
    expect(a.id).toBe(b.id);
    expect(repo.store.size).toBe(1);
  });

  it("enforces authorization on resolve", async () => {
    const { coord } = setup();
    const inc = await coord.declare({ teamId: "T1", title: "x", reporterId: "U1", correlationId: "c" });
    await expect(
      coord.resolve({ teamId: "T1", actor: "U1", correlationId: "c" }, inc.id, { summary: "fixed" }),
    ).rejects.toThrow(/may not perform/);
    const resolved = await coord.resolve({ teamId: "T1", actor: "U_cmd", correlationId: "c" }, inc.id, {
      summary: "fixed",
    });
    expect(resolved.status).toBe(IncidentStatus.Resolved);
  });

  it("isolates workspaces", async () => {
    const { coord } = setup();
    const inc = await coord.declare({ teamId: "T1", title: "x", reporterId: "U1", correlationId: "c" });
    await expect(coord.get(inc.id, "T2")).rejects.toThrow(/different workspace/);
  });

  it("publishes events and defaults severity", async () => {
    const { coord, published } = setup();
    const inc = await coord.declare({ teamId: "T1", title: "x", reporterId: "U1", correlationId: "c" });
    expect(inc.severity).toBe(IncidentSeverity.Minor);
    expect(published).toContain("incident.created");
  });

  it("links channels with authorization and same-channel idempotency", async () => {
    const { coord, published } = setup();
    const inc = await coord.declare({ teamId: "T1", title: "x", reporterId: "U1", correlationId: "c" });
    await expect(
      coord.linkChannel({ teamId: "T1", actor: "U1", correlationId: "c" }, inc.id, "C2", "incident-two"),
    ).rejects.toThrow(/may not perform/);
    const linked = await coord.linkChannel(
      { teamId: "T1", actor: "U_cmd", correlationId: "c" },
      inc.id,
      "C2",
      "incident-two",
    );
    expect(linked.channelId).toBe("C2");
    expect(published).toContain("incident.channel_linked");
    const timelineBefore = linked.timeline.length;
    const same = await coord.linkChannel(
      { teamId: "T1", actor: "U_cmd", correlationId: "c" },
      inc.id,
      "C2",
      "incident-two",
    );
    expect(same.timeline).toHaveLength(timelineBefore);
  });
});
