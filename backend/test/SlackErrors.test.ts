/**
 * slackErrors tests: code extraction without secrets.
 */

import { describe, it, expect } from "vitest";

import { slackErrorCode, slackRetryAfterMs, describeSlackError } from "../slack/slackErrors.js";

describe("slackErrors", () => {
  it("extracts data.error and nothing else", () => {
    expect(slackErrorCode({ data: { error: "not_in_channel" } })).toBe("not_in_channel");
    expect(slackErrorCode(new Error("boom"))).toBe("boom");
    expect(slackErrorCode(undefined)).toBe("unknown");
  });

  it("reads retry-after hints", () => {
    expect(slackRetryAfterMs({ headers: { "retry-after": "7" } })).toBe(7000);
    expect(slackRetryAfterMs({ data: { retry_after: 3 } })).toBe(3000);
    expect(slackRetryAfterMs({})).toBeUndefined();
  });

  it("builds safe diagnostic objects", () => {
    const info = describeSlackError("conversations.create", { data: { error: "ratelimited" } }, {
      teamId: "T1",
      channelId: "C1",
      operation: "incident_channel_create",
    });
    expect(info).toMatchObject({
      method: "conversations.create",
      teamId: "T1",
      channelId: "C1",
      slackError: "ratelimited",
    });
    expect(JSON.stringify(info)).not.toContain("xoxb");
  });
});
