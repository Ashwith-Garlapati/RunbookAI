/**
 * Trigger Layer - Slack Message Shortcut Adapter
 *
 * Converts Slack message shortcut events into Trigger objects.
 * Supports: "Investigate with RunbookAI" shortcut
 *
 * Slack message shortcut payload format:
 * {
 *   type: "message_action",
 *   callback_id: "investigate_with_runbookai",
 *   user: { id: "U12345", username: "john.doe", name: "John Doe" },
 *   channel: { id: "C12345", name: "incidents" },
 *   message: { text: "...", ts: "1234567890.123456", thread_ts: "..." },
 *   team_id: "T12345",
 *   trigger_id: "1234567890.123456",
 *   api_app_id: "A12345",
 *   token: "verification_token"
 * }
 */

import { randomUUID } from "node:crypto";

import { Trigger } from "../../investigation/Trigger.js";
import { TriggerSource } from "../../investigation/TriggerSource.js";
import { TriggerType } from "../../investigation/TriggerType.js";
import type { TriggerId } from "../../investigation/types.js";
import type { ITriggerAdapter } from "../interfaces.js";

interface SlackShortcutEvent {
  type?: string;
  callback_id?: string;
  user?: {
    id?: string;
    username?: string;
    name?: string;
  };
  channel?: {
    id?: string;
    name?: string;
  };
  team?: {
    id?: string;
    name?: string;
  };
  message?: {
    text?: string;
    ts?: string;
    thread_ts?: string;
  };
  team_id?: string;
  trigger_id?: string;
  api_app_id?: string;
  token?: string;
  [key: string]: unknown;
}

export class SlackShortcutAdapter implements ITriggerAdapter {
  readonly source = TriggerSource.Slack;
  readonly type = TriggerType.MessageShortcut;

  /**
   * Converts a Slack message shortcut event into a Trigger.
   * Returns null if the event is missing required fields.
   */
  adapt(rawEvent: unknown): Trigger | null {
    const event = rawEvent as SlackShortcutEvent;

    // Validate required fields
    if (!event.user?.id || !event.channel?.id || !event.callback_id) {
      return null;
    }

    // Check if this is the "Investigate with RunbookAI" shortcut
    if (event.callback_id !== "investigate_with_runbookai") {
      return null;
    }

    const id = randomUUID() as TriggerId;

    // NOTE: The Slack verification token is a secret and is never copied into
    // the trigger payload - it must not be persisted or logged.
    return Trigger.reconstitute({
      id,
      source: TriggerSource.Slack,
      type: TriggerType.MessageShortcut,
      actor: event.user.id,
      payload: {
        callbackId: event.callback_id,
        messageText: event.message?.text ?? "",
        messageTs: event.message?.ts ?? "",
        threadTs: event.message?.thread_ts ?? "",
        channel: event.channel.id,
        channelName: event.channel.name,
        teamId: event.team_id ?? event.team?.id,
        triggerId: event.trigger_id,
        apiAppId: event.api_app_id,
      },
      timestamp: new Date(),
      metadata: {
        slackUserId: event.user.id,
        slackUserName: event.user.username,
        slackChannelId: event.channel.id,
        slackChannelName: event.channel.name,
        slackTeamId: event.team_id ?? event.team?.id,
        messageTs: event.message?.ts,
        threadTs: event.message?.thread_ts,
      },
    });
  }
}
