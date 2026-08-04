/**
 * Slack Handlers - Trigger Layer Integration
 *
 * Every Slack event flows through the Trigger Layer pipeline:
 *
 *   Slack Event → Handler → Registry → Adapter → Factory → Validator → Dispatcher → InvestigationService
 *
 * Handlers ONLY:
 * - Receive the Slack payload
 * - Find the matching adapter from the registry
 * - Call factory.create() (which runs adapter.adapt() + validator.validate())
 * - Call dispatcher.dispatch()
 * - Return a friendly Slack response
 *
 * No handler may:
 * - Create investigations directly (dispatcher is the only path)
 * - Call Investigation constructors
 * - Read Slack threads
 * - Call AI / generate runbooks
 * - Log secrets (verification tokens, response URLs, OAuth tokens, API keys)
 */

import type { App } from "@slack/bolt";
import type { TriggerRegistry } from "../domains/trigger/TriggerRegistry.js";
import type { TriggerFactory } from "../domains/trigger/TriggerFactory.js";
import type { TriggerDispatcher } from "../domains/trigger/TriggerDispatcher.js";
import type { TriggerDispatchResult } from "../domains/trigger/interfaces.js";
import type { Trigger } from "../domains/investigation/Trigger.js";
import { TriggerSource } from "../domains/investigation/TriggerSource.js";
import { TriggerType } from "../domains/investigation/TriggerType.js";
import { TriggerValidationError } from "../domains/trigger/types.js";

export interface SlackHandlerDeps {
  registry: TriggerRegistry;
  factory: TriggerFactory;
  dispatcher: TriggerDispatcher;
}

// ===========================
//  Registration
// ===========================

/**
 * Registers all Slack event handlers on the Bolt app.
 */
export function registerSlackHandlers(bolt: App, deps: SlackHandlerDeps): void {
  registerSlashCommandHandlers(bolt, deps);
  registerMentionHandler(bolt, deps);
  registerShortcutHandler(bolt, deps);
}

// ===========================
//  Slash Commands
// ===========================

function registerSlashCommandHandlers(bolt: App, deps: SlackHandlerDeps): void {
  // /investigate - direct investigation trigger
  bolt.command("/investigate", async ({ command, ack, client }) => {
    await ack();

    const { registry, factory, dispatcher } = deps;
    const userId = command.user_id;
    const channelId = command.channel_id;

    logTrigger("Received", { Source: "Slack", Type: "SlashCommand", Command: "/investigate" });

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.SlashCommand);
    if (!adapter) {
      await replyUnavailable(client, userId, channelId);
      return;
    }

    try {
      const trigger = factory.create(adapter, command);
      logTrigger("Validated", { Source: "Slack", Type: "SlashCommand" });
      await replyWithDispatchResult(dispatcher, trigger, client, userId, channelId);
    } catch (error) {
      await replyFailure(client, userId, channelId);
    }
  });

  // /runbook start - legacy command, creates an investigation through the Trigger Layer
  bolt.command("/runbook", async ({ command, ack, client }) => {
    await ack();

    const { registry, factory, dispatcher } = deps;
    const userId = command.user_id;
    const channelId = command.channel_id;

    logTrigger("Received", { Source: "Slack", Type: "SlashCommand", Command: "/runbook" });

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.SlashCommand);
    if (!adapter) {
      await replyUnavailable(client, userId, channelId);
      return;
    }

    try {
      const trigger = factory.create(adapter, command);
      logTrigger("Validated", { Source: "Slack", Type: "SlashCommand" });
      await replyWithDispatchResult(dispatcher, trigger, client, userId, channelId);
    } catch (error) {
      // The slash adapter only accepts "/runbook start". Everything else is
      // rejected here, so the legacy subcommands (search / github-link / resolve)
      // are not re-implemented in the Trigger Layer.
      // TODO(Runbook Phase): Restore /runbook search, github-link and resolve
      // outside the investigation trigger flow.
      if (error instanceof TriggerValidationError) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: "Only `/runbook start` is supported. Use `/investigate <issue>` to create an investigation.",
        });
        return;
      }
      await replyFailure(client, userId, channelId);
    }
  });
}

// ===========================
//  @Mention
// ===========================

function registerMentionHandler(bolt: App, deps: SlackHandlerDeps): void {
  bolt.event("app_mention", async ({ event, client }) => {
    const { registry, factory, dispatcher } = deps;

    // Ignore bot messages to prevent loops
    if ((event as any).bot_id || (event as any).app_id) {
      return;
    }

    const userId = event.user;
    const channelId = event.channel;
    if (!userId || !channelId) {
      return;
    }

    logTrigger("Received", { Source: "Slack", Type: "Mention" });

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.Mention);
    if (!adapter) {
      logTrigger("Ignored", { Source: "Slack", Type: "Mention", Reason: "NoAdapter" });
      return;
    }

    try {
      const trigger = factory.create(adapter, event);
      logTrigger("Validated", { Source: "Slack", Type: "Mention" });

      const result = await dispatcher.dispatch(trigger);
      if (!result.success) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: "❌ Failed to create investigation. Please try again.",
        });
        return;
      }

      logInvestigationCreated(result);

      // Reply in the thread if the mention was inside one, otherwise in the channel
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: (event as any).thread_ts || event.ts,
        text: "✅ Investigation Created",
        blocks: buildCreatedBlocks(result),
      });
    } catch (error) {
      // Empty mentions / mentions containing only the bot mention are ignored.
      if (error instanceof TriggerValidationError) {
        logTrigger("Ignored", { Source: "Slack", Type: "Mention", Reason: "EmptyRequest" });
        return;
      }
      await replyFailure(client, userId, channelId);
    }
  });
}

// ===========================
//  Message Shortcut
// ===========================

function registerShortcutHandler(bolt: App, deps: SlackHandlerDeps): void {
  bolt.shortcut("investigate_with_runbookai", async ({ shortcut, ack, client }) => {
    await ack();

    const { registry, factory, dispatcher } = deps;
    const userId = shortcut.user.id;
    const channelId = (shortcut as any).channel?.id;

    if (!channelId) {
      return;
    }

    logTrigger("Received", { Source: "Slack", Type: "MessageShortcut" });

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.MessageShortcut);
    if (!adapter) {
      await replyUnavailable(client, userId, channelId);
      return;
    }

    try {
      const trigger = factory.create(adapter, shortcut);
      logTrigger("Validated", { Source: "Slack", Type: "MessageShortcut" });

      const result = await dispatcher.dispatch(trigger);
      if (!result.success) {
        await replyFailure(client, userId, channelId);
        return;
      }

      logInvestigationCreated(result);

      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: "✅ Investigation Created",
        blocks: buildCreatedBlocks(result),
      });
    } catch (error) {
      await replyFailure(client, userId, channelId);
    }
  });
}

// ===========================
//  Shared Pipeline & Responses
// ===========================

/**
 * Dispatches a validated trigger and replies with the outcome.
 * This is the ONLY place handlers reach InvestigationService - via the dispatcher.
 */
async function replyWithDispatchResult(
  dispatcher: TriggerDispatcher,
  trigger: Trigger,
  client: any,
  userId: string,
  channelId: string,
): Promise<void> {
  const result = await dispatcher.dispatch(trigger);

  if (!result.success) {
    await replyFailure(client, userId, channelId);
    return;
  }

  logInvestigationCreated(result);

  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: "✅ Investigation Created",
    blocks: buildCreatedBlocks(result),
  });
}

/**
 * Builds the friendly "Investigation Created" response blocks.
 * Never includes stack traces or internal error details.
 */
function buildCreatedBlocks(result: TriggerDispatchResult): any[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "✅ *Investigation Created*" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*ID:*\n${result.investigationId}` },
        { type: "mrkdwn", text: `*Status:*\n${formatStatus(result.status)}` },
        { type: "mrkdwn", text: `*Trigger:*\n${formatTriggerType(result.triggerType)}` },
      ],
    },
  ];
}

async function replyUnavailable(client: any, userId: string, channelId: string): Promise<void> {
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: "❌ Trigger adapter not configured. Please contact an administrator.",
  });
}

async function replyFailure(client: any, userId: string, channelId: string): Promise<void> {
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: "❌ Failed to create investigation. Please try again.",
  });
}

function formatStatus(status: string): string {
  if (!status) return "Draft";
  return status
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatTriggerType(type: string): string {
  switch (type) {
    case TriggerType.SlashCommand:
      return "Slash Command";
    case TriggerType.MessageShortcut:
      return "Message Shortcut";
    case TriggerType.Mention:
      return "Mention";
    default:
      return type;
  }
}

// ===========================
//  Structured Logging
// ===========================

/**
 * Structured trigger log: [Trigger] <Step> | Key=Value
 * Never logs payloads, tokens, response URLs, or headers.
 */
function logTrigger(step: string, fields: Record<string, string>): void {
  const detail = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(`[Trigger] ${step}${detail ? ` | ${detail}` : ""}`);
}

/**
 * Structured investigation log: [Investigation] Created | investigation=... | status=...
 */
function logInvestigationCreated(result: TriggerDispatchResult): void {
  console.log(
    `[Investigation] Created | investigation=${result.investigationId} | status=${result.status}`,
  );
}
