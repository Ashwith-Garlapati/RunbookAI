import { describe, it, expect, vi } from "vitest";

import { Incident } from "../domains/incident/Incident.js";
import { startUpdateReminderLoop } from "../slack/updateReminder.js";

function dueIncident(reporter: string, withChannel: boolean): Incident {
  const incident = Incident.declare({ teamId: "T1", title: `inc ${reporter}`, reporterId: reporter });
  if (withChannel) incident.attachChannel(reporter, `C-${reporter}`, `inc-${reporter}`, null);
  incident.nextUpdateAt = new Date(Date.now() - 1000);
  incident.nextUpdateFor = reporter;
  return incident;
}

describe("updateReminder sweep isolation", () => {
  it("skips incidents whose schedule clear fails and continues the sweep", async () => {
    const badChannel = dueIncident("U-bad", true);
    const noChannel = dueIncident("U-none", false);
    const good = dueIncident("U-good", true);
    const updated: string[] = [];
    const repo = {
      findOpenByTeam: async () => [badChannel, noChannel, good],
      update: async (incident: Incident) => {
        if (incident.reporterId === "U-bad" || incident.reporterId === "U-none") {
          throw Object.assign(new Error("version conflict"), { name: "IncidentVersionConflictError" });
        }
        updated.push(incident.reporterId);
        return incident;
      },
    };
    const posted: string[] = [];
    const clients = {
      forTeam: async () => ({
        chat: {
          postMessage: async (args: { channel: string }) => {
            posted.push(args.channel);
          },
        },
      }),
    };
    const loop = startUpdateReminderLoop({ incidentRepo: repo, listTeams: async () => ["T1"], clients: clients as never, intervalMs: 60_000 });
    await vi.waitFor(() => expect(posted).toContain("C-U-good"));
    loop.stop();
    // Failing incidents were skipped; the healthy one still nudged.
    expect(updated).toEqual(["U-good"]);
    expect(posted).toEqual(["C-U-good"]);
  });
});
