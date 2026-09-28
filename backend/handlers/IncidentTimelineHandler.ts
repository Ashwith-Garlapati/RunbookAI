/**
 * Incident handlers - audit trail + Slack notifications for incident.* events.
 *
 * Subscribes to the IncidentBus with "*" and:
 * - appends every event to the audit log (append-only, never updated)
 * - posts formatted update/escalation/handover/resolution messages
 * - refreshes the control message so it never goes stale
 *
 * Timeline entries themselves are written synchronously by the aggregate
 * (curated, immutable). The activity log lives on the aggregate too.
 * This handler only mirrors to Mongo audit + Slack.
 */

import { randomUUID } from "node:crypto";

import type { IncidentDomainEvent } from "../domains/incident/IncidentEvents.js";
import type { IIncidentEventHandler } from "../domains/incident/IncidentBus.js";
import type { IncidentCoordinator } from "../domains/incident/IncidentCoordinator.js";
import { AuditLogModel } from "../models/IncidentOps.model.js";
import { buildControlBlocks, buildUpdateBlocks, controlMessageText } from "../slack/SlackControlMessage.js";
import type { SlackClientProvider } from "../slack/slackClientProvider.js";
import { logger } from "../observability/logger.js";

export interface NotifyClient {
  chat: {
    postMessage(args: Record<string, unknown>): Promise<{ ts?: string }>;
    update(args: Record<string, unknown>): Promise<unknown>;
  };
}

/** Block Kit payloads are built as plain JSON; cast once at the API boundary. */
function asBlocks(blocks: unknown[]): never[] {
  return blocks as never[];
}

export class IncidentAuditHandler implements IIncidentEventHandler {
  async handle(event: IncidentDomainEvent): Promise<void> {
    try {
      await AuditLogModel.create({
        _id: randomUUID(),
        teamId: event.teamId,
        incidentId: event.incidentId,
        actor: event.actor,
        action: event.eventType,
        at: event.occurredAt,
        metadata: event.payload,
      });
    } catch (error) {
      logger.error("IncidentAudit", "WriteFailed", {
        incidentId: event.incidentId,
        eventType: event.eventType,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export class IncidentNotifier implements IIncidentEventHandler {
  constructor(
    private readonly _coordinator: IncidentCoordinator,
    private readonly _clients: SlackClientProvider,
  ) {}

  async handle(event: IncidentDomainEvent): Promise<void> {
    try {
      const incident = await this._coordinator.get(event.incidentId, event.teamId);
      if (!incident.channelId) return;
      // Per-team authorized client: the startup-global bolt.client carries
      // no token under Socket Mode, so resolve one from the install store.
      const slack = await this._clients.forTeam(event.teamId);

      switch (event.eventType) {
        case "incident.update_posted": {
          const updateId = String(event.payload.updateId ?? "");
          const update = incident.updates.find((u) => u.id === updateId);
          if (update) {
            await slack.chat.postMessage({
              channel: incident.channelId,
              text: `Incident update from <@${update.author}>`,
              blocks: asBlocks(
                buildUpdateBlocks({
                  author: update.author,
                  situation: update.situation,
                  changed: update.changed,
                  impact: update.impact,
                  nextStep: update.nextStep,
                }),
              ),
            });
          }
          break;
        }
        case "incident.escalated": {
          const toUser = String(event.payload.toUser ?? "");
          const reason = String(event.payload.reason ?? "");
          await slack.chat.postMessage({
            channel: incident.channelId,
            text: `Escalated to <@${toUser}>`,
            blocks: asBlocks([
              { type: "section", text: { type: "mrkdwn", text: `⚠️ *Escalated to <@${toUser}>*\n*Reason:* ${reason}` } },
            ]),
          });
          break;
        }
        case "incident.handover": {
          const next = String(event.payload.newCommander ?? "");
          await slack.chat.postMessage({
            channel: incident.channelId,
            text: `Lead handed over to <@${next}>`,
            blocks: asBlocks([
              { type: "section", text: { type: "mrkdwn", text: `🔄 *Lead handover:* <@${next}> is now Incident Lead` } },
            ]),
          });
          break;
        }
        case "incident.resolved": {
          const outstanding = Number(event.payload.outstandingFollowUps ?? 0);
          const summary = incident.resolution?.summary ?? "";
          await slack.chat.postMessage({
            channel: incident.channelId,
            text: "Incident resolved",
            blocks: asBlocks([
              { type: "section", text: { type: "mrkdwn", text: `✅ *Incident resolved*\n${summary}` } },
              ...(outstanding > 0
                ? [{ type: "section", text: { type: "mrkdwn", text: `⚠️ *${outstanding} follow-up(s) still open* — address them before closing.` } }]
                : []),
            ]),
          });
          break;
        }
        case "incident.closed":
        case "incident.cancelled": {
          await slack.chat.postMessage({
            channel: incident.channelId,
            text: `Incident ${event.eventType === "incident.closed" ? "closed" : "cancelled"}`,
          });
          break;
        }
        default:
          break;
      }

      if (incident.controlMessageTs) {
        await slack.chat.update({
          channel: incident.channelId,
          ts: incident.controlMessageTs,
          text: controlMessageText(incident),
          blocks: asBlocks(buildControlBlocks(incident)),
        });
      }
    } catch (error) {
      logger.warn("IncidentNotifier", "NotifyFailed", {
        incidentId: event.incidentId,
        eventType: event.eventType,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
