/**
 * Slack Evidence Live Ingest - new-message capture for incident channels.
 *
 * Registered on the SAME Bolt app (no second listener/client): `bolt.event`
 * like the existing app_mention handler. Delivery dedupe reuses the
 * existing SlackGateway; incident lookup reuses IncidentCoordinator
 * findByChannel; persistence reuses the CommonEvidenceStore.
 *
 * Only incident-channel messages for incidents WITH an active
 * investigation are stored. Everything else is ignored.
 */

import type { App } from "@slack/bolt";

import type { IncidentCoordinator } from "../domains/incident/IncidentCoordinator.js";
import { logger } from "../observability/logger.js";
import { SlackEvidenceCollector } from "../services/slackEvidenceCollector.js";
import { CommonEvidenceStore } from "../services/commonEvidenceStore.js";
import type { SlackHistoryClient, SlackRawMessage } from "../services/slackEvidence.js";
import type { SlackClientProvider } from "./slackClientProvider.js";
import type { SlackGateway } from "./SlackGateway.js";

export interface SlackEvidenceIngestDeps {
  readonly gateway: SlackGateway;
  readonly coordinator: IncidentCoordinator;
  readonly store: CommonEvidenceStore;
  readonly clients: SlackClientProvider;
}

/**
 * Message subtypes collected as evidence. Ordinary user messages carry no
 * subtype; file_share (user uploads, attachment metadata preserved) and
 * thread_broadcast (channel-visible reply) are real responder content.
 * Everything else (edits, deletes, joins/leaves, topic changes, …) is
 * channel noise or a duplicate vector and is skipped.
 */
const ALLOWED_MESSAGE_SUBTYPES: ReadonlySet<string> = new Set(["file_share", "thread_broadcast"]);

export function registerSlackEvidenceIngest(bolt: App, deps: SlackEvidenceIngestDeps): void {
  const collector = new SlackEvidenceCollector({ clients: deps.clients });

  bolt.event("message", async ({ event, client }) => {
    const e = event as unknown as {
      team?: string;
      team_id?: string;
      user?: string;
      bot_id?: string;
      channel?: string;
      channel_id?: string;
      ts?: string;
      thread_ts?: string;
      text?: string;
      files?: Array<Record<string, unknown>>;
      attachments?: Array<Record<string, unknown>>;
      event_ts?: string;
      subtype?: string;
    };
    try {
      const teamId = e.team ?? e.team_id ?? "";
      const channelId = e.channel ?? e.channel_id ?? "";
      const ts = e.ts ?? "";
      if (!teamId || !channelId || !ts) return;
      // bot_id posts are loop-prevention skips; only explicitly allowed
      // subtypes pass (ordinary messages carry no subtype at all).
      if (e.bot_id) return;
      if (e.subtype !== undefined && !ALLOWED_MESSAGE_SUBTYPES.has(e.subtype)) return;

      const first = await deps.gateway.acceptDelivery(teamId, `slackmsg:${channelId}:${e.event_ts ?? ts}`, "message");
      if (!first) return;

      const incident = await deps.coordinator.findByChannel(teamId, channelId).catch(() => null);
      if (!incident || !incident.investigationId) return;

      const message: SlackRawMessage = {
        ts,
        ...(e.thread_ts ? { thread_ts: e.thread_ts } : {}),
        ...(e.user ? { user: e.user } : {}),
        ...(e.text !== undefined ? { text: e.text } : {}),
        ...(e.files ? { files: e.files } : {}),
        ...(e.attachments ? { attachments: e.attachments } : {}),
      };
      const item = await collector.ingestLiveMessage({
        teamId,
        channelId,
        message,
        investigationId: incident.investigationId,
        incidentId: incident.id,
        client: client as unknown as SlackHistoryClient,
      });
      if (!item) return;
      await deps.store.saveAll(incident.investigationId, [item]);
    } catch (error) {
      logger.warn("SlackEvidence", "LiveIngestFailed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
