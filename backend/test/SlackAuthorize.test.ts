/**
 * slackAuthorize tests: token resolution, botId fallback + caching, errors.
 */

import { describe, it, expect, vi } from "vitest";

import { createSlackAuthorize, type InstallationLookup } from "../slack/slackAuthorize.js";

function setup(storedBotId: string | null = null) {
  const lookup: InstallationLookup = {
    findByTeam: vi.fn(async (teamId: string) =>
      teamId === "T1"
        ? { teamId: "T1", botToken: "enc-token", botUserId: "UBOT", botId: storedBotId }
        : null,
    ),
  };
  const authTest = vi.fn(async () => ({ bot_id: "B123" }));
  const authorize = createSlackAuthorize({
    lookup,
    decrypt: (s: string) => s.replace(/^enc-/, "xoxb-"),
    webClientFactory: () => ({ auth: { test: authTest } }),
  });
  return { lookup, authTest, authorize };
}

describe("createSlackAuthorize", () => {
  it("resolves token and stored botId without auth.test", async () => {
    const { authorize, authTest } = setup("B999");
    const result = await authorize({ teamId: "T1", enterpriseId: undefined } as never);
    expect(result.botToken).toBe("xoxb-token");
    expect(result.botId).toBe("B999");
    expect(result.botUserId).toBe("UBOT");
    expect(authTest).not.toHaveBeenCalled();
  });

  it("falls back to auth.test once and caches per team", async () => {
    const { authorize, authTest } = setup(null);
    const first = await authorize({ teamId: "T1" } as never);
    const second = await authorize({ teamId: "T1" } as never);
    expect(first.botId).toBe("B123");
    expect(second.botId).toBe("B123");
    expect(authTest).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown workspaces and missing team ids", async () => {
    const { authorize } = setup(null);
    await expect(authorize({ teamId: "T9" } as never)).rejects.toThrow(/not found/);
    await expect(authorize({} as never)).rejects.toThrow(/Missing teamId/);
  });
});
