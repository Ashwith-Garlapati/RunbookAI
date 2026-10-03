/**
 * Slack gateway reliability tests: replay window, backoff, dedupe, channel names.
 */

import { describe, it, expect, vi } from "vitest";

import {
  SlackGateway,
  computeBackoff,
  isFreshSlackTimestamp,
  normalizeMention,
} from "../slack/SlackGateway.js";
import { buildChannelName } from "../slack/SlackChannelManager.js";
import { IncidentAuthorizationError } from "../domains/incident/IncidentPermissions.js";
import { MembershipLevel } from "../domains/incident/IncidentRoles.js";

describe("isFreshSlackTimestamp", () => {
  it("accepts fresh, rejects stale and far-future", () => {
    const now = Date.now();
    expect(isFreshSlackTimestamp(Math.floor(now / 1000), now)).toBe(true);
    expect(isFreshSlackTimestamp(Math.floor(now / 1000) - 60, now)).toBe(true);
    expect(isFreshSlackTimestamp(Math.floor(now / 1000) - 301, now)).toBe(false);
    expect(isFreshSlackTimestamp(Math.floor(now / 1000) + 3600, now)).toBe(false);
  });
});

describe("computeBackoff", () => {
  it("exponential without rate-limit, honors Retry-After", () => {
    expect(computeBackoff(1, null)).toBe(1000);
    expect(computeBackoff(3, null)).toBe(4000);
    expect(computeBackoff(1, 30000)).toBe(30000);
  });
});

describe("SlackGateway idempotency", () => {
  it("skips duplicate deliveries", async () => {
    const claimed = new Set<string>();
    const gateway = new SlackGateway({
      claimDelivery: async (teamId: string, eventId: string) => {
        const key = `${teamId}:${eventId}`;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
    });
    expect(await gateway.acceptDelivery("T1", "evt-1", "app_mention")).toBe(true);
    expect(await gateway.acceptDelivery("T1", "evt-1", "app_mention")).toBe(false);
  });

  it("retries failures then succeeds", async () => {
    const gateway = new SlackGateway({ claimDelivery: async () => true });
    let calls = 0;
    gateway.enqueue({
      key: "job-1",
      run: async () => {
        calls += 1;
        if (calls < 3) throw new Error("boom");
      },
    });
    await vi.waitFor(() => expect(calls).toBe(3), { timeout: 15000 });
  });

  it("does not retry authorization failures", async () => {
    const gateway = new SlackGateway({ claimDelivery: async () => true });
    let calls = 0;
    gateway.enqueue({
      key: "job-auth",
      run: async () => {
        calls += 1;
        throw new IncidentAuthorizationError("close", MembershipLevel.Member);
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBe(1);
  });

  it("does not retry validation failures", async () => {
    const gateway = new SlackGateway({ claimDelivery: async () => true });
    let calls = 0;
    gateway.enqueue({
      key: "job-invalid",
      run: async () => {
        calls += 1;
        throw new Error("Role and assignee are required");
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBe(1);
  });
});

describe("buildChannelName", () => {
  it("is deterministic, lowercase, collision-safe", () => {
    const now = new Date("2026-09-25T12:00:00Z");
    const a = buildChannelName("Checkout API 500s!", now, "ab12");
    expect(a).toBe("inc-checkout-api-500s-0925-ab12");
    const b = buildChannelName("Checkout API 500s!", now, "zz99");
    expect(b).not.toBe(a);
    expect(a).toMatch(/^[a-z0-9-_]+$/);
  });
});

describe("normalizeMention", () => {
  it("caps text and assigns correlation", () => {
    const env = normalizeMention({
      teamId: "T1",
      eventId: "e1",
      userId: "U1",
      channelId: "C1",
      messageTs: "1.0",
      text: "x".repeat(9000),
    });
    expect(env.text).toHaveLength(4000);
    expect(env.correlationId).toBeTruthy();
  });
});
