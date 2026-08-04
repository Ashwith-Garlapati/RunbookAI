/**
 * Trigger Layer - Slack Slash Command Adapter
 *
 * Converts Slack slash command events into Trigger objects.
 * Supports: /investigate (and /runbook start for compatibility)
 *
 * Slack slash command payload format:
 * {
 *   command: "/investigate",
 *   text: "checkout API failures",
 *   user_id: "U12345",
 *   user_name: "john.doe",
 *   channel_id: "C12345",
 *   channel_name: "incidents",
 *   team_id: "T12345",
 *   trigger_id: "1234567890.123456",
 *   api_app_id: "A12345",
 *   token: "verification_token",
 *   response_url: "https://hooks.slack.com/actions/..."
 * }
 */

import { randomUUID } from "node:crypto";

import { Trigger } from "../../investigation/Trigger.js";
import { TriggerSource } from "../../investigation/TriggerSource.js";
import { TriggerType } from "../../investigation/TriggerType.js";
import type { TriggerId } from "../../investigation/types.js";
import type { ITriggerAdapter } from "../interfaces.js";
import type { RawSlackEvent } from "../types.js";

export class SlackSlashCommandAdapter implements ITriggerAdapter {
  readonly source = TriggerSource.Slack;
  readonly type = TriggerType.SlashCommand;

  /**
   * Converts a Slack slash command event into a Trigger.
   * Returns null if the event is missing required fields.
   */
  adapt(rawEvent: unknown): Trigger | null {
    const event = rawEvent as RawSlackEvent;

    // Validate required fields
    if (!event.user_id || !event.channel_id || !event.command) {
      return null;
    }

    // Check if this is an /investigate or /runbook command
    const command = (event.command as string).toLowerCase();
    if (command !== "/investigate" && command !== "/runbook") {
      return null;
    }

    // For /runbook, check if it starts with "start"
    if (command === "/runbook") {
      const text = event.text?.trim() ?? "";
      if (!text.startsWith("start")) {
        return null;
      }
    }

    const id = randomUUID() as TriggerId;

    // NOTE: Slack verification tokens and response URLs are never copied into
    // the trigger payload - they are secrets and must not be persisted or logged.
    return Trigger.reconstitute({
      id,
      source: TriggerSource.Slack,
      type: TriggerType.SlashCommand,
      actor: event.user_id,
      payload: {
        command: event.command,
        text: event.text ?? "",
        channel: event.channel_id,
        channelName: event.channel_name,
        teamId: event.team_id,
        triggerId: event.trigger_id,
        apiAppId: event.api_app_id,
      },
      timestamp: new Date(),
      metadata: {
        slackUserId: event.user_id,
        slackUserName: event.user_name,
        slackChannelId: event.channel_id,
        slackChannelName: event.channel_name,
        slackTeamId: event.team_id,
      },
    });
  }
}
