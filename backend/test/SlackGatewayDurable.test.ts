/**
 * Durable gateway tests: persist-before-run, duplicate skip, boot recovery.
 * Uses an in-memory JobStore fake — no Mongo required.
 */

import { describe, it, expect, vi } from "vitest";

import { SlackGateway, startRecoveryLoop, type GatewayStore } from "../slack/SlackGateway.js";

function fakeStore(): GatewayStore & { rows: Map<string, { status: string; attempts: number }> } {
  const rows = new Map<string, { status: string; attempts: number }>();
  return {
    rows,
    save: async (job) => {
      const existing = rows.get(job.key);
      if (existing && existing.status === "done") return "duplicate";
      rows.set(job.key, { status: "inflight", attempts: 0 });
      return "accepted";
    },
    complete: async (key) => {
      rows.set(key, { status: "done", attempts: rows.get(key)?.attempts ?? 0 });
    },
    reschedule: async (key, attempts) => {
      rows.set(key, { status: "pending", attempts });
    },
    failTerminal: async (key, attempts) => {
      rows.set(key, { status: "failed", attempts });
    },
    claimDue: async () => {
      for (const [key, row] of rows) {
        if (row.status === "pending" || row.status === "inflight") {
          row.status = "inflight";
          return { key, op: "test-op", teamId: "T1", params: {}, attempts: row.attempts };
        }
      }
      return null;
    },
  };
}

describe("durable SlackGateway", () => {
  it("persists before running and completes after", async () => {
    const store = fakeStore();
    const gateway = new SlackGateway({ claimDelivery: async () => true }, { store });
    const run = vi.fn(async () => undefined);
    await gateway.enqueue({
      key: "job-1",
      run,
      durable: { op: "test-op", teamId: "T1", params: {} },
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(store.rows.get("job-1")?.status).toBe("done");
  });

  it("skips running keys that already completed", async () => {
    const store = fakeStore();
    store.rows.set("job-done", { status: "done", attempts: 1 });
    const gateway = new SlackGateway({ claimDelivery: async () => true }, { store });
    const run = vi.fn(async () => undefined);
    await gateway.enqueue({
      key: "job-done",
      run,
      durable: { op: "test-op", teamId: "T1", params: {} },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(run).not.toHaveBeenCalled();
  });

  it("recovers persisted jobs via dispatch without re-running closures", async () => {
    const store = fakeStore();
    store.rows.set("job-crashed", { status: "pending", attempts: 0 });
    const dispatch = vi.fn(async () => undefined);
    const gateway = new SlackGateway({ claimDelivery: async () => true }, { store, dispatch });
    await gateway.recover();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ key: "job-crashed", op: "test-op" }),
    );
    expect(store.rows.get("job-crashed")?.status).toBe("done");
  });

  it("marks jobs terminally failed after max attempts on recovery", async () => {
    const store = fakeStore();
    store.rows.set("job-bad", { status: "pending", attempts: 5 });
    const gateway = new SlackGateway(
      { claimDelivery: async () => true },
      { store, dispatch: async () => {
        throw new Error("nope");
      }, maxAttempts: 3 },
    );
    await gateway.recover();
    expect(store.rows.get("job-bad")?.status).toBe("failed");
  });

  it("runs closure-only jobs in-process with no store", async () => {
    const gateway = new SlackGateway({ claimDelivery: async () => true });
    const run = vi.fn(async () => undefined);
    await gateway.enqueue({ key: "mem-1", run });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it("reclaims previous-process leases on boot recovery only", async () => {
    const seen: Array<{ includeLeased?: boolean }> = [];
    const store = fakeStore();
    const inner = store.claimDue;
    store.claimDue = async (now, leaseMs, opts) => {
      seen.push({ ...(opts?.includeLeased ? { includeLeased: true } : {}) });
      return inner(now, leaseMs, opts);
    };
    const gateway = new SlackGateway(
      { claimDelivery: async () => true },
      { store, dispatch: async () => undefined },
    );
    await gateway.recover({ reclaimLeased: true });
    expect(seen[0]).toEqual({ includeLeased: true });
    seen.length = 0;
    await gateway.recover();
    for (const call of seen) expect(call).toEqual({});
  });

  it("sweeps recovery periodically until stopped", async () => {
    const store = fakeStore();
    const gateway = new SlackGateway(
      { claimDelivery: async () => true },
      { store, dispatch: async () => undefined },
    );
    const spy = vi.spyOn(gateway, "recover");
    const loop = startRecoveryLoop(gateway, 10);
    await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2));
    const count = spy.mock.calls.length;
    loop.stop();
    await new Promise((r) => setTimeout(r, 40));
    expect(spy.mock.calls.length).toBe(count);
  });
});
