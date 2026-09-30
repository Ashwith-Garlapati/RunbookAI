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
import type { Incident } from "../domains/incident/Incident.js";
import { AuditLogModel } from "../models/IncidentOps.model.js";
import { buildControlBlocks, buildUpdateBlocks, controlMessageText } from "../slack/SlackControlMessage.js";
import type { SlackClientProvider } from "../slack/slackClientProvider.js";
import type { WebClient } from "@slack/web-api";
import { IncidentRole } from "../domains/incident/IncidentRoles.js";
import { severityLabel } from "../domains/incident/IncidentSeverity.js";
import { logger } from "../observability/logger.js";
import { slackErrorCode } from "../slack/slackErrors.js";

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
        slackError: slackErrorCode(error),
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
      // Commander-assignment DMs precede channel creation, so they bypass the
      // channel guard below. Everything else needs an attached channel.
      const isCommanderAssign =
        event.eventType === "incident.role_assigned" &&
        String(event.payload.role ?? "") === IncidentRole.IncidentCommander;
      if (!incident.channelId && !isCommanderAssign) return;
      const channelId: string = incident.channelId ?? "";
      // Per-team authorized client: the startup-global bolt.client carries
      // no token under Socket Mode, so resolve one from the install store.
      const slack = await this._clients.forTeam(event.teamId);

      switch (event.eventType) {
        case "incident.role_assigned": {
          const assignee = String(event.payload.assignee ?? "");
          if (assignee && String(event.payload.role ?? "") === IncidentRole.IncidentCommander) {
            await this.sendCommanderDM(slack, incident, assignee);
          }
          break;
        }
        case "incident.update_posted": {
          const updateId = String(event.payload.updateId ?? "");
          const update = incident.updates.find((u) => u.id === updateId);
          if (update) {
            await slack.chat.postMessage({
              channel: channelId,
              text: `Incident update from <@${update.author}>`,
              blocks: asBlocks(buildUpdateBlocks({ author: update.author, text: update.text })),
            });
          }
          break;
        }
        case "incident.escalated": {
          const toUser = String(event.payload.toUser ?? "");
          const reason = String(event.payload.reason ?? "");
          await slack.chat.postMessage({
            channel: channelId,
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
            channel: channelId,
            text: `Commander handed over to <@${next}>`,
            blocks: asBlocks([
              { type: "section", text: { type: "mrkdwn", text: `🔄 *Commander handover:* <@${next}> is now Incident Commander` } },
            ]),
          });
          if (next) {
            await this.sendCommanderDM(slack, incident, next);
          }
          break;
        }
        case "incident.resolved": {
          const outstanding = Number(event.payload.outstandingFollowUps ?? 0);
          const summary = incident.resolution?.summary ?? "";
          await slack.chat.postMessage({
            channel: channelId,
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
            channel: channelId,
            text: `Incident ${event.eventType === "incident.closed" ? "closed" : "cancelled"}`,
          });
          break;
        }
        default:
          break;
      }

      if (incident.controlMessageTs) {
        await slack.chat.update({
          channel: channelId,
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
        slackError: slackErrorCode(error),
      });
    }
  }

  /**
   * DMs the new commander with Accept / Hand Over buttons. Best effort: a DM
   * failure (e.g. DMs disabled) is logged and never fails the handler —
   * the assignment itself is already persisted.
   */
  private async sendCommanderDM(
    slack: WebClient,
    incident: Incident,
    assignee: string,
  ): Promise<void> {
    try {
      await slack.chat.postMessage({
        channel: assignee,
        text: `You are Incident Commander for ${incident.title}`,
        blocks: asBlocks([
          { type: "header", text: { type: "plain_text", text: "🚨 Incident Commander assigned", emoji: true } },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${incident.title}*\nSeverity: ${severityLabel(incident.severity)}\nTriggered by: <@${incident.reporterId}>`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Accept", emoji: true },
                style: "primary",
                action_id: "inc_accept",
                value: incident.id,
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Hand Over", emoji: true },
                action_id: "inc_handover",
                value: incident.id,
              },
            ],
          },
        ]),
      });
      logger.info("IncidentNotifier", "CommanderDMsent", { incidentId: incident.id, userId: assignee });
    } catch (error) {
      logger.warn("IncidentNotifier", "CommanderDMfailed", {
        incidentId: incident.id,
        userId: assignee,
        reason: error instanceof Error ? error.message : String(error),
        slackError: slackErrorCode(error),
      });
    }
  }
}
