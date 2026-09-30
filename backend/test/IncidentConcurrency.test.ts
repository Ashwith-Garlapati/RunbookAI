/**
 * Optimistic concurrency tests: versioned writes, conflict retry, no lost updates.
 *
 * The fake repository mirrors MongoIncidentRepository semantics exactly:
 * conditional write on (id, version), legacy rows without a version field
 * match once (bootstrap), every successful write stamps version+1 and
 * advances the in-memory aggregate to match.
 */

import { describe, it, expect } from "vitest";

import { Incident } from "../domains/incident/Incident.js";
import { IncidentStatus } from "../domains/incident/IncidentStatus.js";
import { IncidentSeverity } from "../domains/incident/IncidentSeverity.js";
import { IncidentRole } from "../domains/incident/IncidentRoles.js";
import { IncidentCoordinator } from "../domains/incident/IncidentCoordinator.js";
import { IncidentBus } from "../domains/incident/IncidentBus.js";
import type {
  IIncidentRepository,
  IIdempotencyStore,
  IMembershipResolver,
} from "../domains/incident/IncidentRepository.js";
import { IncidentVersionConflictError } from "../domains/incident/IncidentRepository.js";
import { MembershipLevel } from "../domains/incident/IncidentRoles.js";

type StoredDoc = { data: Record<string, unknown> };

function snapshot(incident: Incident): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...incident.toProps() })) as Record<string, unknown>;
}

function currentVersion(doc: StoredDoc): number | null {
  const v = (doc.data as { version?: unknown }).version;
  return typeof v === "number" ? v : null;
}

class VersionedFakeRepo implements IIncidentRepository {
  readonly docs = new Map<string, StoredDoc>();
  readonly byKey = new Map<string, string>();

  /** 1ms latency so concurrent flows interleave like real async persistence. */
  private async tick(): Promise<void> {
    await new Promise((r) => setTimeout(r, 1));
  }

  async create(incident: Incident): Promise<Incident> {
    this.docs.set(incident.id, { data: snapshot(incident) });
    return incident;
  }

  async update(incident: Incident): Promise<Incident> {
    await this.tick();
    const existing = this.docs.get(incident.id);
    if (!existing) throw new IncidentVersionConflictError(incident.id, incident.version, null);
    const current = currentVersion(existing);
    const matches = current === null || current === incident.version;
    if (!matches) throw new IncidentVersionConflictError(incident.id, incident.version, current);
    const next = incident.version + 1;
    this.docs.set(incident.id, { data: { ...snapshot(incident), version: next } });
    incident.version = next;
    return incident;
  }

  async findById(id: string): Promise<Incident | null> {
    await this.tick();
    const existing = this.docs.get(id);
    if (!existing) return null;
    return Incident.reconstitute({
      ...(existing.data as unknown as Parameters<typeof Incident.reconstitute>[0]),
      ...(currentVersion(existing) === null ? { version: 1 } : {}),
    });
  }

  async findByTeamAndChannel(): Promise<Incident | null> {
    return null;
  }
  async findByIdempotencyKey(teamId: string, key: string): Promise<Incident | null> {
    const id = this.byKey.get(`${teamId}:${key}`);
    if (!id) return null;
    return this.findById(id);
  }
  async linkIdempotencyKey(incidentId: string, key: string): Promise<void> {
    const doc = this.docs.get(incidentId);
    if (doc) this.byKey.set(`${(doc.data as { teamId?: string }).teamId}:${key}`, incidentId);
  }
  async findOpenByTeam(): Promise<Incident[]> {
    return [];
  }
  async listByTeam(): Promise<Incident[]> {
    return [];
  }

  /** Simulates a legacy row written before versioning existed. */
  injectLegacy(incident: Incident): void {
    const data = snapshot(incident) as Record<string, unknown>;
    delete data.version;
    this.docs.set(incident.id, { data });
  }

  storedVersion(id: string): number | null {
    const doc = this.docs.get(id);
    return doc ? currentVersion(doc) : null;
  }
}

class FakeIdempotency implements IIdempotencyStore {
  async claim(): Promise<boolean> {
    return true;
  }
  async release(): Promise<void> {}
}

const membership: IMembershipResolver = {
  resolveLevel: async () => MembershipLevel.Commander,
};

function setup() {
  const repo = new VersionedFakeRepo();
  const bus = new IncidentBus();
  const events: string[] = [];
  bus.subscribe("*", { handle: async (e) => void events.push(e.eventType) });
  const coord = new IncidentCoordinator(repo, bus, new FakeIdempotency(), membership);
  return { repo, coord, events };
}

const ctx = (actor: string) => ({ teamId: "T1", actor, correlationId: "c" });

describe("optimistic concurrency", () => {
  it("increments version on every mutation: 10 -> 11", async () => {
    const { coord, repo } = setup();
    const inc = await coord.declare({ teamId: "T1", title: "x", reporterId: "U1", correlationId: "c" });
    expect(inc.version).toBe(1);
    // Drive to version 10 with benign mutations.
    for (let i = 0; i < 9; i += 1) {
      await coord.addMessageRef(ctx("U1"), inc.id, {
        channelId: "C1",
        messageTs: `${i}.0`,
        threadTs: null,
        author: "U2",
        text: `m${i}`,
        permalink: null,
      });
    }
    expect(repo.storedVersion(inc.id)).toBe(10);
    await coord.changeStatus(ctx("U1"), inc.id, IncidentStatus.Investigating);
    expect(repo.storedVersion(inc.id)).toBe(11);
  });

  it("two simultaneous status updates both land without loss", async () => {
    const { coord } = setup();
    const inc = await coord.declare({ teamId: "T1", title: "x", reporterId: "U1", correlationId: "c" });
    const [a, b] = await Promise.all([
      coord.changeStatus(ctx("U1"), inc.id, IncidentStatus.Investigating),
      coord.changeStatus(ctx("U2"), inc.id, IncidentStatus.Mitigating),
    ]);
    void a;
    const final = await coord.get(inc.id, "T1");
    expect(final.status).toBe(IncidentStatus.Mitigating);
    expect(final.version).toBe(3);
    expect(b.version).toBe(3);
  });

  it("status + severity concurrently: both changes survive (no lost update)", async () => {
    const { coord } = setup();
    const inc = await coord.declare({ teamId: "T1", title: "x", reporterId: "U1", correlationId: "c" });
    await Promise.all([
      coord.changeStatus(ctx("Alice"), inc.id, IncidentStatus.Investigating),
      coord.setSeverity(ctx("Bob"), inc.id, IncidentSeverity.Critical),
    ]);
    const final = await coord.get(inc.id, "T1");
    expect(final.status).toBe(IncidentStatus.Investigating);
    expect(final.severity).toBe(IncidentSeverity.Critical);
    expect(final.version).toBe(3);
  });

  it("two simultaneous role assignments preserve full history", async () => {
    const { coord } = setup();
    const inc = await coord.declare({ teamId: "T1", title: "x", reporterId: "U1", correlationId: "c" });
    await Promise.all([
      coord.assignRole(ctx("U1"), inc.id, IncidentRole.IncidentCommander, "U_a"),
      coord.assignRole(ctx("U2"), inc.id, IncidentRole.IncidentCommander, "U_b"),
    ]);
    const final = await coord.get(inc.id, "T1");
    expect(final.roleHistory.filter((h) => h.assignee !== null)).toHaveLength(2);
    expect(final.version).toBe(3);
  });

  it("concurrent handover and role mutation converge", async () => {
    const { coord } = setup();
    const inc = await coord.declare({ teamId: "T1", title: "x", reporterId: "U1", correlationId: "c" });
    await coord.assignRole(ctx("U1"), inc.id, IncidentRole.IncidentCommander, "U_a");
    await coord.acknowledgeRole(ctx("U_a"), inc.id, IncidentRole.IncidentCommander);
    await Promise.all([
      coord.handover(ctx("U_a"), inc.id, "U_b"),
      coord.postUpdate(ctx("U_c"), inc.id, { text: "parallel note" }),
    ]);
    const final = await coord.get(inc.id, "T1");
    expect(final.currentRoles[IncidentRole.IncidentCommander]).toBe("U_b");
    expect(final.updates).toHaveLength(1);
  });

  it("stale-version write is rejected and current state is unchanged", async () => {
    const { coord, repo } = setup();
    const inc = await coord.declare({ teamId: "T1", title: "x", reporterId: "U1", correlationId: "c" });
    await coord.changeStatus(ctx("U1"), inc.id, IncidentStatus.Investigating);
    expect(repo.storedVersion(inc.id)).toBe(2);
    // inc object still holds version 1 -> direct write must fail.
    await expect(repo.update(inc)).rejects.toThrow(IncidentVersionConflictError);
    await expect(repo.update(inc)).rejects.toThrow(/expected version 1.*current is 2/);
    const current = await coord.get(inc.id, "T1");
    expect(current.status).toBe(IncidentStatus.Investigating);
    expect(current.version).toBe(2);
  });

  it("safe retry after conflict converges with no duplicate timeline entries", async () => {
    const { coord } = setup();
    const inc = await coord.declare({ teamId: "T1", title: "x", reporterId: "U1", correlationId: "c" });
    const before = (await coord.get(inc.id, "T1")).timeline.length;
    await Promise.all([
      coord.postUpdate(ctx("U1"), inc.id, { text: "first" }),
      coord.postUpdate(ctx("U2"), inc.id, { text: "second" }),
    ]);
    const final = await coord.get(inc.id, "T1");
    expect(final.updates.map((u) => u.text).sort()).toEqual(["first", "second"]);
    // Exactly 2 update timeline entries — the retried write published once.
    expect(final.timeline.length).toBe(before + 2);
  });

  it("invalid retry after conflict surfaces validation, not a silent overwrite", async () => {
    const { coord } = setup();
    const inc = await coord.declare({ teamId: "T1", title: "x", reporterId: "U1", correlationId: "c" });
    await coord.resolve(ctx("U1"), inc.id, { summary: "over" });
    await coord.close(ctx("U1"), inc.id);
    // Resolving a closed incident is invalid on current state — must throw
    // the domain error rather than conflicting or overwriting.
    await expect(coord.resolve(ctx("U2"), inc.id, { summary: "again" })).rejects.toThrow(
      /Cannot resolve an incident/,
    );
    expect((await coord.get(inc.id, "T1")).status).toBe(IncidentStatus.Closed);
  });

  it("legacy rows without a version bootstrap on first write", async () => {
    const { coord, repo } = setup();
    const fresh = Incident.declare({ teamId: "T1", title: "legacy", reporterId: "U1" });
    repo.injectLegacy(fresh);
    const loaded = await coord.get(fresh.id, "T1");
    expect(loaded.version).toBe(1);
    await coord.changeStatus(ctx("U1"), fresh.id, IncidentStatus.Investigating);
    expect(repo.storedVersion(fresh.id)).toBe(2);
  });

  it("commander assign/reassign rule holds under the new naming", async () => {
    const { coord, repo } = setup();
    const inc = await coord.declare({ teamId: "T1", title: "x", reporterId: "U_rep", correlationId: "c" });
    // Reporter resolves as responder (participant) -> may fill the vacant seat.
    const memberMembership: IMembershipResolver = {
      resolveLevel: async (_team, user) =>
        user === "U_rep" ? MembershipLevel.Responder : MembershipLevel.Member,
    };
    const coord2 = new IncidentCoordinator(repo, new IncidentBus(), new FakeIdempotency(), memberMembership);
    await coord2.assignRole(ctx("U_rep"), inc.id, IncidentRole.IncidentCommander, "U_cmd");
    // Stranger (member) cannot assign the now-occupied seat.
    await expect(
      coord2.assignRole(ctx("U_stranger"), inc.id, IncidentRole.IncidentCommander, "U_x"),
    ).rejects.toThrow(/may not perform/);
  });

  it("default commander assignment still works end to end", async () => {
    const { coord, events } = setup();
    const inc = await coord.declare({
      teamId: "T1",
      title: "x",
      reporterId: "U_rep",
      defaultCommanderId: "U_cmd",
      correlationId: "c",
    });
    expect(inc.currentRoles[IncidentRole.IncidentCommander]).toBe("U_cmd");
    expect(events).toContain("incident.role_assigned");
    await coord.acknowledgeRole(ctx("U_cmd"), inc.id, IncidentRole.IncidentCommander);
    expect((await coord.get(inc.id, "T1")).assignmentState(IncidentRole.IncidentCommander)).toBe("active");
  });

  it("existing idempotency still works alongside versioning", async () => {
    const { coord, repo } = setup();
    const params = {
      teamId: "T1",
      title: "x",
      reporterId: "U1",
      correlationId: "c",
      idempotencyKey: "k-conc",
    };
    const a = await coord.declare(params);
    const b = await coord.declare({ ...params, correlationId: "c2" });
    expect(a.id).toBe(b.id);
    expect(repo.docs.size).toBe(1);
  });
});
