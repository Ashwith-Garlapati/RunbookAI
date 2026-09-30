/**
 * Slack - shared incident job plumbing.
 *
 * Helpers used both by live handlers (per-event client) and by durable job
 * replay (provider client). Client parameters stay loosely typed on purpose:
 * both the Bolt listener client and the provider WebClient satisfy them at
 * runtime; strict Slack types are asserted at the API boundary instead.
 */

import type { IncidentCoordinator, CoordinatorContext } from "../domains/incident/IncidentCoordinator.js";
import { IncidentStatus } from "../domains/incident/IncidentStatus.js";
import { controlMessageText, buildControlBlocks } from "./SlackControlMessage.js";
import { newCorrelationId, logger } from "../observability/logger.js";

export type AnyClient = {
  chat: {
    postMessage(args: Record<string, unknown>): Promise<{ ts?: string }>;
    postEphemeral(args: Record<string, unknown>): Promise<unknown>;
    update(args: Record<string, unknown>): Promise<unknown>;
  };
  views: { open(args: Record<string, unknown>): Promise<unknown> };
  conversations: {
    replies(args: Record<string, unknown>): Promise<{ messages?: Array<Record<string, unknown>> }>;
  };
};

export function ctxFor(teamId: string, actor: string, idempotencyKey?: string): CoordinatorContext {
  return {
    teamId,
    actor,
    correlationId: newCorrelationId(),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

/** Resolved, closed, or cancelled — the incident is no longer active. */
export function isOpenStatus(status: IncidentStatus): boolean {
  return status !== IncidentStatus.Resolved && status !== IncidentStatus.Closed && status !== IncidentStatus.Cancelled;
}

export async function refreshControl(
  client: AnyClient,
  coordinator: IncidentCoordinator,
  incidentId: string,
  teamId: string,
): Promise<void> {
  try {
    const incident = await coordinator.get(incidentId, teamId);
    if (!incident.channelId || !incident.controlMessageTs) return;
    await client.chat.update({
      channel: incident.channelId,
      ts: incident.controlMessageTs,
      text: controlMessageText(incident),
      blocks: buildControlBlocks(incident),
    });
  } catch (error) {
    logger.warn("IncidentSlack", "ControlRefreshFailed", {
      incidentId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function ephemeral(
  client: AnyClient,
  channel: string,
  user: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  try {
    await client.chat.postEphemeral({
      channel,
      user,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  } catch (error) {
    // postEphemeral requires bot membership. Without it, even error replies
    // fail — fall back to DM so the failure is self-explanatory instead of
    // an unhandled Bolt error. Never rethrow membership failures.
    const slackError = (error as { data?: { error?: string } })?.data?.error;
    if (slackError !== "not_in_channel") throw error;
    logger.warn("IncidentSlack", "EphemeralNotInChannel", { channelId: channel, userId: user });
    try {
      await client.chat.postMessage({
        channel: user,
        text:
          `I couldn't reply in <#${channel}> because I'm not a member there. ` +
          `Run \`/invite @RunbookAI\` in that channel first.\nOriginal message:\n${text}`,
      });
    } catch (dmError) {
      // DMs can also fail — log why instead of swallowing, still no rethrow.
      const dmReason = dmError instanceof Error ? dmError.message : String(dmError);
      logger.warn("IncidentSlack", "DMFallbackFailed", { channelId: channel, userId: user, reason: dmReason });
    }
  }
}
