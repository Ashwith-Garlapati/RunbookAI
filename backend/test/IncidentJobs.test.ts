/**
 * incidentJobs dispatch tests: replay guards and unknown ops.
 * Fakes mirror IncidentCoordinator.test.ts — no Mongo, no Slack.
 */

import { describe, it, expect, vi } from "vitest";

import { Incident } from "../domains/incident/Incident.js";
import { IncidentStatus } from "../domains/incident/IncidentStatus.js";
import { runIncidentJob, type IncidentJobContext } from "../slack/incidentJobs.js";
import { IncidentBus } from "../domains/incident/IncidentBus.js";
import { IncidentCoordinator } from "../domains/incident/IncidentCoordinator.js";
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
    for (const incident of this.store.values()) {
      if (incident.teamId === teamId && incident.channelId === channelId) return incident;
    }
    return null;
  }
  async findByIdempotencyKey(teamId: string, key: string): Promise<Incident | null> {
    return this.byKey.get(`${teamId}:${key}`) ?? null;
  }
  async linkIdempotencyKey(incidentId: string, key: string): Promise<void> {
    const incident = this.store.get(incidentId);
    if (incident) this.byKey.set(`${incident.teamId}:${key}`, incident);
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
  resolveLevel: async () => MembershipLevel.Commander,
};

function setup() {
  const repo = new FakeRepo();
  const coord = new IncidentCoordinator(repo, new IncidentBus(), new FakeIdempotency(), membership);
  const postMessage = vi.fn(async () => ({ ts: "9.9" }));
  const slack: unknown = {
    chat: { postMessage, postEphemeral: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
    conversations: { create: vi.fn(async () => ({ channel: { id: "C9", name: "inc-x" } })), invite: vi.fn(async () => ({})) },
  };
  const ctx: IncidentJobContext = {
    coordinator: coord,
    clients: { forTeam: async () => slack } as unknown as IncidentJobContext["clients"],
    resolveDefaultCommander: async () => null,
  };
  return { coord, ctx, postMessage };
}

describe("runIncidentJob", () => {
  it("rejects unknown ops", async () => {
    const { ctx } = setup();
    await expect(
      runIncidentJob(ctx, { key: "k", op: "nope" as never, teamId: "T1", params: {} }),
    ).rejects.toThrow(/Unknown incident job op/);
  });

  it("declare skips channel wiring when replayed after success", async () => {
    const { coord, ctx, postMessage } = setup();
    const key = "declare-replay-1";
    const base = {
      key,
      op: "declare" as const,
      teamId: "T1",
      params: {
        title: "outage",
        description: "",
        service: "",
        userId: "U1",
        idempotencyKey: key,
      },
    };
    await runIncidentJob(ctx, base);
    expect(postMessage).toHaveBeenCalledTimes(1);
    // Replay (crash after persist, job re-dispatched): must not re-post.
    await runIncidentJob(ctx, base);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const stored = await coord.get(
      (await coord.findByChannel("T1", "C9"))?.id ?? "missing",
      "T1",
    );
    expect(stored.channelId).toBe("C9");
  });

  it("close is idempotent on replay", async () => {
    const { coord, ctx } = setup();
    const inc = await coord.declare({ teamId: "T1", title: "x", reporterId: "U1", correlationId: "c" });
    await coord.resolve({ teamId: "T1", actor: "U1", correlationId: "c" }, inc.id, { summary: "s" });
    const job = { key: "close-1", op: "close" as const, teamId: "T1", params: { incidentId: inc.id, userId: "U1" } };
    await runIncidentJob(ctx, job);
    await runIncidentJob(ctx, job);
    expect((await coord.get(inc.id, "T1")).status).toBe(IncidentStatus.Closed);
  });
});
