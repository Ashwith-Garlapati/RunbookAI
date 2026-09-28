/**
 * slackClientProvider tests: per-team caching, unknown workspace rejection.
 */

import { describe, it, expect, vi } from "vitest";

import { createSlackClientProvider } from "../slack/slackClientProvider.js";

describe("createSlackClientProvider", () => {
  it("returns the same client per team and rejects unknown teams", async () => {
    const lookup = {
      findByTeam: vi.fn(async (teamId: string) =>
        teamId === "T1" ? { teamId, botToken: "enc-x", botUserId: "U1" } : null,
      ),
    };
    const provider = createSlackClientProvider({ lookup, decrypt: (s: string) => s });
    const a = await provider.forTeam("T1");
    const b = await provider.forTeam("T1");
    expect(a).toBe(b);
    expect(lookup.findByTeam).toHaveBeenCalledTimes(1);
    await expect(provider.forTeam("T9")).rejects.toThrow(/not found/);
  });
});
