/**
 * Slack - update reminder sweeper.
 *
 * When an update sets "next update in N minutes", this loop fires once at
 * the deadline: clears the schedule (each reminder fires exactly once, even
 * across restarts since state lives in Mongo) and nudges the channel.
 * Failures are isolated per incident; the loop never throws.
 */

import type { IIncidentRepository } from "../domains/incident/IncidentRepository.js";
import type { SlackClientProvider } from "./slackClientProvider.js";
import { logger } from "../observability/logger.js";

export interface UpdateReminderDeps {
  readonly incidentRepo: Pick<IIncidentRepository, "findOpenByTeam" | "update">;
  readonly listTeams: () => Promise<string[]>;
  readonly clients: SlackClientProvider;
  readonly intervalMs?: number;
}

export function startUpdateReminderLoop(deps: UpdateReminderDeps): { stop(): void } {
  const sweep = async (): Promise<void> => {
    try {
      const now = new Date();
      for (const teamId of await deps.listTeams()) {
        let open;
        try {
          open = await deps.incidentRepo.findOpenByTeam(teamId);
        } catch {
          continue;
        }
        for (const incident of open) {
          if (!incident.nextUpdateAt || incident.nextUpdateAt.getTime() > now.getTime()) continue;
          if (!incident.channelId) {
            incident.markReminderSent(now);
            try {
              await deps.incidentRepo.update(incident);
            } catch (error) {
              logger.warn("UpdateReminder", "ClearScheduleFailed", {
                incidentId: incident.id,
                reason: error instanceof Error ? error.message : String(error),
              });
            }
            continue;
          }
          const target = incident.nextUpdateFor;
          incident.markReminderSent(now);
          try {
            await deps.incidentRepo.update(incident);
          } catch (error) {
            logger.warn("UpdateReminder", "ClearScheduleFailed", {
              incidentId: incident.id,
              reason: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          try {
            const slack = await deps.clients.forTeam(teamId);
            await slack.chat.postMessage({
              channel: incident.channelId,
              text: `Update due for ${incident.title}`,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `⏰ ${target ? `<@${target}> ` : ""}Update due for *${incident.title}* — post one with \`/inc update\`.`,
                  },
                },
              ] as never[],
            });
            logger.info("UpdateReminder", "Sent", { incidentId: incident.id, teamId });
          } catch (error) {
            logger.warn("UpdateReminder", "SendFailed", {
              incidentId: incident.id,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    } catch (error) {
      logger.warn("UpdateReminder", "SweepFailed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  void sweep();
  const timer = setInterval(() => void sweep(), deps.intervalMs ?? 60_000);
  return { stop: () => clearInterval(timer) };
}
