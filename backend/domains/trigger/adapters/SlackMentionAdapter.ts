/**
 * Trigger Layer - Slack @RunbookAI Mention Adapter
 *
 * Converts Slack @RunbookAI mention events into Trigger objects.
 * Supports: @RunbookAI investigate checkout API failures
 *
 * Slack mention event payload format (app_mention):
 * {
 *   type: "app_mention",
 *   user: "U12345",
 *   text: "<@U_BOT_ID> investigate checkout API failures",
 *   ts: "1234567890.123456",
 *   channel: "C12345",
 *   thread_ts: "..." (optional, if in a thread)
 *   team: "T12345",
 *   api_app_id: "A12345"
 * }
 *
 * This adapter supports starting investigations from:
 * - A standalone message
 * - An existing incident discussion thread
 */

import { randomUUID } from "node:crypto";

import { Trigger } from "../../investigation/Trigger.js";
import { TriggerSource } from "../../investigation/TriggerSource.js";
import { TriggerType } from "../../investigation/TriggerType.js";
import type { TriggerId } from "../../investigation/types.js";
import type { ITriggerAdapter } from "../interfaces.js";

interface SlackMentionEvent {
  type?: string;
  user?: string;
  text?: string;
  ts?: string;
  channel?: string;
  thread_ts?: string;
  team?: string;
  api_app_id?: string;
  bot_id?: string;
  [key: string]: unknown;
}

export class SlackMentionAdapter implements ITriggerAdapter {
  readonly source = TriggerSource.Slack;
  readonly type = TriggerType.Mention;

  /**
   * Converts a Slack mention event into a Trigger.
   * Returns null if the event is missing required fields.
   */
  adapt(rawEvent: unknown): Trigger | null {
    const event = rawEvent as SlackMentionEvent;

    // Validate required fields
    if (!event.user || !event.channel || !event.text) {
      return null;
    }

    // Ignore bot messages to prevent loops
    if (event.bot_id) {
      return null;
    }

    // Extract the actual message text (remove the @mention)
    const messageText = this.extractMessageText(event.text);

    if (messageText.trim().length === 0) {
      return null;
    }

    const id = randomUUID() as TriggerId;

    return Trigger.reconstitute({
      id,
      source: TriggerSource.Slack,
      type: TriggerType.Mention,
      actor: event.user,
      payload: {
        messageText,
        messageTs: event.ts,
        threadTs: event.thread_ts ?? "",
        channel: event.channel,
        teamId: event.team,
        apiAppId: event.api_app_id,
        originalText: event.text,
      },
      timestamp: new Date(),
      metadata: {
        slackUserId: event.user,
        slackChannelId: event.channel,
        slackTeamId: event.team,
        messageTs: event.ts,
        threadTs: event.thread_ts,
        isThread: !!event.thread_ts,
      },
    });
  }

  /**
   * Extracts the message text after the @mention.
   * Removes the @RunbookAI mention from the beginning of the text.
   */
  private extractMessageText(text: string): string {
    // Remove @mentions (pattern: <@U12345>, <@W12345>, <@U_BOT_ID>, etc.)
    const withoutMentions = text.replace(/<@[UW][A-Za-z0-9_]+>/g, "").trim();
    return withoutMentions;
  }
}
