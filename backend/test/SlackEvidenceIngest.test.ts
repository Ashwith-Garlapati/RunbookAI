import { describe, it, expect, vi } from "vitest";

import { registerSlackEvidenceIngest } from "../slack/slackEvidenceIngest.js";

function setup() {
  const handlers = new Map<string, (args: { event: unknown; client: unknown }) => Promise<void>>();
  const bolt = {
    event: (name: string, handler: (args: { event: unknown; client: unknown }) => Promise<void>) => {
      handlers.set(name, handler);
    },
  };
  const saveAll = vi.fn(async () => ({ stored: 1, skipped: 0 }));
  const deps = {
    gateway: { acceptDelivery: async () => true },
    coordinator: {
      findByChannel: async () => ({ id: "inc-1", investigationId: "inv-1" }),
    },
    store: { saveAll },
    clients: {
      forTeam: async () => {
        throw new Error("provider must not be used for live ingest");
      },
    },
  };
  registerSlackEvidenceIngest(bolt as never, deps as never);
  const client = {
    chat: { getPermalink: async () => ({ permalink: "https://workspace.slack.com/archives/C1/p100" }) },
  };
  const emit = (event: Record<string, unknown>) =>
    (handlers.get("message") as (args: { event: unknown; client: unknown }) => Promise<void>)({ event, client });
  return { emit, saveAll };
}

const base = { team: "T1", channel: "C1", ts: "100.000100", event_ts: "100.000100", user: "U1", text: "hello" };

describe("slackEvidenceIngest subtype filter", () => {
  it("stores ordinary messages without a subtype", async () => {
    const { emit, saveAll } = setup();
    await emit({ ...base });
    expect(saveAll).toHaveBeenCalledTimes(1);
  });

  it("stores file_share and thread_broadcast content", async () => {
    const { emit, saveAll } = setup();
    await emit({ ...base, subtype: "file_share", files: [{ id: "F1" }] });
    await emit({ ...base, ts: "101.000100", subtype: "thread_broadcast", thread_ts: "99.000100" });
    expect(saveAll).toHaveBeenCalledTimes(2);
  });

  it("skips edits, deletes, joins, bot posts, and bot users", async () => {
    const { emit, saveAll } = setup();
    await emit({ ...base, subtype: "message_changed" });
    await emit({ ...base, subtype: "message_deleted" });
    await emit({ ...base, subtype: "channel_join" });
    await emit({ ...base, subtype: "bot_message" });
    await emit({ ...base, bot_id: "B1" });
    expect(saveAll).not.toHaveBeenCalled();
  });
});
