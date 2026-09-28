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
 * - Adapt / validate / dispatch (investigate intent) or route by intent
 * - Return a friendly Slack response
 *
 * @RunbookAI mentions are routed by intent (see services/MentionIntentDetector.ts):
 * - investigate → Trigger Layer pipeline (creates or reuses an investigation)
 * - question    → QuestionAnsweringService (read-only, never creates anything)
 * - resolve     → InvestigationService.resolveInvestigation() (explicit command)
 * - reopen      → InvestigationService.reopenInvestigation() (explicit command)
 * - help        → static help text
 * - unknown     → clarification request (nothing is mutated)
 *
 * Every conversational response to a @RunbookAI mention is EPHEMERAL
 * (client.chat.postEphemeral) - visible only to the requesting user. The
 * only public message in a mention flow is the durable investigation card
 * posted by SlackIncidentCardService (the investigation record itself is
 * never ephemeral).
 *
 * No handler may:
 * - Create investigations directly (dispatcher is the only path)
 * - Call Investigation constructors
 * - Read Slack thread history for slash commands
 * - Call AI / generate runbooks
 * - Log secrets (verification tokens, response URLs, OAuth tokens, API keys)
 */

import type { App } from "@slack/bolt";
import type { TriggerRegistry } from "../domains/trigger/TriggerRegistry.js";
import type { TriggerFactory } from "../domains/trigger/TriggerFactory.js";
import type { TriggerDispatcher } from "../domains/trigger/TriggerDispatcher.js";
import type { TriggerDispatchResult } from "../domains/trigger/interfaces.js";
import type { Trigger } from "../domains/investigation/Trigger.js";
import type { InvestigationService } from "../domains/investigation/InvestigationService.js";
import { InvestigationStatus } from "../domains/investigation/InvestigationStatus.js";
import { TriggerSource } from "../domains/investigation/TriggerSource.js";
import { TriggerType } from "../domains/investigation/TriggerType.js";
import { TriggerValidationError } from "../domains/trigger/types.js";
import type { MentionIntentDetector } from "../services/MentionIntentDetector.js";
import { MentionIntent } from "../services/MentionIntentDetector.js";
import type { QuestionAnsweringService } from "../services/QuestionAnsweringService.js";
import type { SlackIncidentCardService } from "../services/SlackIncidentCardService.js";
import { formatStatus } from "../services/formatStatus.js";

export interface SlackHandlerDeps {
  registry: TriggerRegistry;
  factory: TriggerFactory;
  dispatcher: TriggerDispatcher;
  investigationService: InvestigationService;
  intentDetector: MentionIntentDetector;
  questionService: QuestionAnsweringService;
  cardService: SlackIncidentCardService;
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
  // /investigate - direct investigation trigger.
  // Creates a clean investigation ONLY. No Slack history is read, no AI is
  // called, no runbook is generated, no channel is created, no pin.
  bolt.command("/investigate", async ({ command, ack, client }) => {
    await ack();

    const { registry, factory, dispatcher } = deps;
    const userId = command.user_id;
    const channelId = command.channel_id;

    log("Trigger", "Received", { Source: "Slack", Type: "SlashCommand", Command: "/investigate" });

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.SlashCommand);
    if (!adapter) {
      await replyUnavailable(client, userId, channelId);
      return;
    }

    try {
      const trigger = factory.create(adapter, command);
      log("Trigger", "Validated", { Source: "Slack", Type: "SlashCommand" });
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

    log("Trigger", "Received", { Source: "Slack", Type: "SlashCommand", Command: "/runbook" });

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.SlashCommand);
    if (!adapter) {
      await replyUnavailable(client, userId, channelId);
      return;
    }

    try {
      const trigger = factory.create(adapter, command);
      log("Trigger", "Validated", { Source: "Slack", Type: "SlashCommand" });
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
//  @Mention - Intent Routing
// ===========================

function registerMentionHandler(bolt: App, deps: SlackHandlerDeps): void {
  bolt.event("app_mention", async ({ event, client }) => {
    const { registry, intentDetector } = deps;

    // Ignore bot messages to prevent loops
    if ((event as any).bot_id || (event as any).app_id) {
      return;
    }

    const userId = event.user;
    const channelId = event.channel;
    if (!userId || !channelId) {
      return;
    }

    log("Trigger", "Received", { Source: "Slack", Type: "Mention" });

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.Mention);
    if (!adapter) {
      log("Trigger", "Ignored", { Source: "Slack", Type: "Mention", Reason: "NoAdapter" });
      return;
    }

    // Adapt WITHOUT dispatching: mentions are routed by intent first.
    // Empty mentions / mentions containing only the bot mention are ignored here.
    const trigger = adapter.adapt(event);
    if (!trigger) {
      log("Trigger", "Ignored", { Source: "Slack", Type: "Mention", Reason: "EmptyRequest" });
      return;
    }

    const messageText = String(trigger.payload.messageText ?? "");
    const { intent } = intentDetector.detect(messageText);
    log("Mention", "IntentDetected", { intent });

    switch (intent) {
      case MentionIntent.Investigate:
        await handleMentionInvestigate(deps, adapter, event, client, userId, channelId, trigger);
        return;
      case MentionIntent.Question:
        await handleMentionQuestion(deps, event, client, userId, channelId, messageText);
        return;
      case MentionIntent.Resolve:
        await handleMentionResolve(deps, event, client, userId, channelId);
        return;
      case MentionIntent.Reopen:
        await handleMentionReopen(deps, event, client, userId, channelId);
        return;
      case MentionIntent.Help:
        await replyHelp(client, userId, channelId, (event as any).thread_ts || event.ts);
        return;
      default:
        await replyClarification(client, userId, channelId, (event as any).thread_ts || event.ts);
    }
  });
}

async function handleMentionInvestigate(
  deps: SlackHandlerDeps,
  adapter: NonNullable<ReturnType<TriggerRegistry["findAdapter"]>>,
  event: any,
  client: any,
  userId: string,
  channelId: string,
  adaptedTrigger: Trigger,
): Promise<void> {
  const { factory, dispatcher, cardService, investigationService } = deps;

  try {
    // factory.create() re-adapts + validates through the Trigger Layer
    const trigger = factory.create(adapter, event);
    log("Trigger", "Validated", { Source: "Slack", Type: "Mention" });

    // Mentions reuse an existing active investigation when one matches the
    // conversation (association handled by InvestigationService - not here).
    const result = await dispatcher.dispatch(trigger, { associate: true });
    if (!result.success) {
      await replyFailure(client, userId, channelId);
      return;
    }

    log("Investigation", result.associated ? "Reused" : "Created", {
      investigation: result.investigationId,
      status: result.status,
      association: result.association ?? "created",
    });

    const threadTs = (event as any).thread_ts || event.ts;

    // Multiple existing candidates - do NOT guess; ask the user to choose.
    if ((result.candidates?.length ?? 0) > 0) {
      await replyChooseInvestigation(client, channelId, userId, result.candidates ?? [], true);
      return;
    }

    // Post the investigation card ONLY when a brand-new investigation was
    // created. Reused investigations are already tracked in the conversation,
    // so a duplicate card would be noisy. A card failure must never lose the
    // investigation confirmation. The card is the durable investigation
    // record - it stays PUBLIC; only the conversational confirmation below
    // is ephemeral.
    if (!result.associated) {
      let cardTs: string | null = null;
      try {
        cardTs = await cardService.postInvestigationCard({
          channelId,
          threadTs,
          title: String(adaptedTrigger.payload.messageText ?? result.investigationId),
          investigationId: result.investigationId,
          status: result.status,
          pin: !!event.thread_ts,
        });

        if (cardTs) {
          await investigationService.updateInvestigationMetadata(
            result.investigationId,
            "slackCardTs",
            cardTs,
          );
        }
      } catch (error) {
        log("Slack", "CardPostFailed", { investigation: result.investigationId });
      }
    }

    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: threadTs,
      text: result.associated ? "🔁 Investigation Reused" : "✅ Investigation Created",
      blocks: buildAcquiredBlocks(result),
    });
  } catch (error) {
    await replyFailure(client, userId, channelId);
  }
}

async function handleMentionQuestion(
  deps: SlackHandlerDeps,
  event: any,
  client: any,
  userId: string,
  channelId: string,
  question: string,
): Promise<void> {
  const { questionService } = deps;

  try {
    const result = await questionService.answer({
      question,
      channelId,
      threadTs: (event as any).thread_ts,
    });

    log("Question", "Answered", {
      investigation: result.investigationId,
      context: result.investigationId ? "linked" : "none",
    });

    // Question answers are ephemeral - only the requesting user sees them.
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: (event as any).thread_ts || event.ts,
      text: result.answer,
    });
  } catch (error) {
    // Question answering never creates investigations; a failure here is safe
    // to surface as a friendly clarification.
    await replyClarification(client, userId, channelId, (event as any).thread_ts || event.ts);
  }
}

async function handleMentionResolve(
  deps: SlackHandlerDeps,
  event: any,
  client: any,
  userId: string,
  channelId: string,
): Promise<void> {
  const { investigationService } = deps;
  const threadTs = (event as any).thread_ts || event.ts;

  try {
    const investigation = await investigationService.findBySlackContext(
      channelId,
      (event as any).thread_ts,
    );

    if (!investigation) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: threadTs,
        text:
          "I couldn't find a linked investigation in this conversation. " +
          "Start one with `/investigate <issue>` or `@RunbookAI investigate <issue>`.",
      });
      return;
    }

    if (investigation.status === InvestigationStatus.Resolved) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: threadTs,
        text: `✅ *${investigation.title}* is already resolved (by ${investigation.resolvedBy ?? "unknown"}).`,
      });
      return;
    }

    const resolved = await investigationService.resolveInvestigation(investigation.id, userId);
    log("Investigation", "Resolved", { investigation: resolved.id });

    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: threadTs,
      text: "✅ Investigation Resolved",
      blocks: buildResolvedBlocks(resolved),
    });
  } catch (error) {
    await replyFailure(client, userId, channelId);
  }
}

async function handleMentionReopen(
  deps: SlackHandlerDeps,
  event: any,
  client: any,
  userId: string,
  channelId: string,
): Promise<void> {
  const { investigationService } = deps;
  const threadTs = (event as any).thread_ts || event.ts;

  try {
    const investigation = await investigationService.findBySlackContext(
      channelId,
      (event as any).thread_ts,
    );

    if (!investigation) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: threadTs,
        text:
          "I couldn't find a linked investigation to reopen in this conversation. " +
          "Start one with `/investigate <issue>` or `@RunbookAI investigate <issue>`.",
      });
      return;
    }

    if (investigation.status !== InvestigationStatus.Resolved) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: threadTs,
        text:
          `*${investigation.title}* is not Resolved (currently ${formatStatus(investigation.status)}) - ` +
          "only a resolved investigation can be reopened.",
      });
      return;
    }

    const reopened = await investigationService.reopenInvestigation(investigation.id, userId);
    log("Investigation", "Reopened", { investigation: reopened.id });

    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: threadTs,
      text: "🔓 Investigation Reopened",
      blocks: buildReopenedBlocks(reopened),
    });
  } catch (error) {
    await replyFailure(client, userId, channelId);
  }
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

    log("Trigger", "Received", { Source: "Slack", Type: "MessageShortcut" });

    const adapter = registry.findAdapter(TriggerSource.Slack, TriggerType.MessageShortcut);
    if (!adapter) {
      await replyUnavailable(client, userId, channelId);
      return;
    }

    try {
      const trigger = factory.create(adapter, shortcut);
      log("Trigger", "Validated", { Source: "Slack", Type: "MessageShortcut" });

      // Shortcuts share the SAME association logic as mentions: existing
      // active investigations are reused when they match the conversation.
      const result = await dispatcher.dispatch(trigger, { associate: true });
      if (!result.success) {
        await replyFailure(client, userId, channelId);
        return;
      }

      log("Investigation", result.associated ? "Reused" : "Created", {
        investigation: result.investigationId,
        status: result.status,
        association: result.association ?? "created",
      });

      if ((result.candidates?.length ?? 0) > 0) {
        await replyChooseInvestigation(
          client,
          channelId,
          userId,
          result.candidates ?? [],
          true,
        );
        return;
      }

      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: result.associated ? "🔁 Investigation Reused" : "✅ Investigation Created",
        blocks: buildAcquiredBlocks(result),
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
 * This is the ONLY place handlers reach InvestigationService for creation -
 * via the dispatcher.
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

  log("Investigation", "Created", { investigation: result.investigationId, status: result.status });

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
        { type: "mrkdwn", text: `*Evidence:*\n0 collected` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*Next steps:*\n" +
          "• Use `@RunbookAI` in the incident thread\n" +
          "• Use the message shortcut on the relevant Slack message\n" +
          "• Add GitHub context later",
      },
    },
  ];
}

/**
 * Builds the response blocks for an investigation-acquisition dispatch
 * (mention / shortcut). For a reused investigation it confirms the linked
 * conversation instead of hinting at a fresh card/pin.
 */
function buildAcquiredBlocks(result: TriggerDispatchResult): any[] {
  if (!result.associated) {
    return buildCreatedBlocks(result);
  }

  const associationLabel: Record<string, string> = {
    thread: "This investigation is already linked to this exact thread.",
    channel: "This investigation is already active in this channel.",
    recent_user: "Reused from your recent investigation (within the last 30 minutes).",
  };

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "🔁 *Investigation Reused*" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*ID:*\n${result.investigationId}` },
        { type: "mrkdwn", text: `*Status:*\n${formatStatus(result.status)}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: associationLabel[result.association ?? ""] ?? "This investigation is already active.",
      },
    },
  ];
}

/**
 * Asks the user to choose when association found multiple existing
 * investigations. We never guess - the user picks the correct one.
 */
async function replyChooseInvestigation(
  client: any,
  channelId: string,
  recipient: string,
  candidates: ReadonlyArray<{ investigationId: string; title: string; status: string }>,
  ephemeral = false,
): Promise<void> {
  const list = candidates
    .map(
      (candidate) =>
        `• \`${candidate.investigationId}\` — ${candidate.title} (${formatStatus(candidate.status)})`,
    )
    .join("\n");

  const firstId = candidates[0]?.investigationId ?? "INV-000";

  const text =
    `I found *${candidates.length} active investigations* in this conversation — ` +
    `which one should this be linked to?\n\n${list}\n\n` +
    `Reply with the one to use (e.g. \`@RunbookAI use ${firstId}\`).`;

  if (ephemeral) {
    await client.chat.postEphemeral({ channel: channelId, user: recipient, text });
    return;
  }
  await client.chat.postMessage({ channel: channelId, thread_ts: recipient, text });
}

/**
 * Builds the friendly "Investigation Resolved" response blocks.
 */
function buildResolvedBlocks(investigation: any): any[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "✅ *Investigation Resolved*" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*ID:*\n${investigation.id}` },
        { type: "mrkdwn", text: `*Title:*\n${investigation.title}` },
        { type: "mrkdwn", text: `*Status:*\n${formatStatus(investigation.status)}` },
        { type: "mrkdwn", text: `*Resolved by:*\n<@${investigation.resolvedBy}>` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*Next:* runbook generation starts now that the incident is resolved. " +
          "The incident is not archived yet.",
      },
    },
  ];
}

/**
 * Builds the friendly "Investigation Reopened" response blocks.
 */
function buildReopenedBlocks(investigation: any): any[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "🔓 *Investigation Reopened*" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*ID:*\n${investigation.id}` },
        { type: "mrkdwn", text: `*Title:*\n${investigation.title}` },
        { type: "mrkdwn", text: `*Status:*\n${formatStatus(investigation.status)}` },
        { type: "mrkdwn", text: `*Reopened by:*\n<@${investigation.reopenedBy}>` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "The investigation resumed evidence collection. It can be resolved again when the incident is truly over.",
      },
    },
  ];
}

async function replyHelp(client: any, userId: string, channelId: string, threadTs: string): Promise<void> {
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    thread_ts: threadTs,
    text: "RunbookAI — Incident Investigation Assistant",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "*RunbookAI* is your incident investigation assistant.\n\n" +
            "*Investigate an incident*\n" +
            "• `/investigate <issue>` — start a clean investigation\n" +
            "• `@RunbookAI investigate <issue>` — start one from the current discussion\n" +
            "• Message shortcut *\"Investigate with RunbookAI\"* — on any Slack message\n\n" +
            "*Ask questions*\n" +
            "• `@RunbookAI summarize this thread`\n" +
            "• `@RunbookAI what caused this?`\n" +
            "• `@RunbookAI is it resolved yet?`\n\n" +
            "*Resolve / Reopen*\n" +
            "• `@RunbookAI resolve this investigation` — marks the incident resolved; " +
            "runbook generation follows\n" +
            "• `@RunbookAI reopen this investigation` — reopens a resolved incident\n\n" +
            "*Help*\n" +
            "• `@RunbookAI help` — show this message",
        },
      },
    ],
  });
}

async function replyClarification(
  client: any,
  userId: string,
  channelId: string,
  threadTs: string,
): Promise<void> {
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    thread_ts: threadTs,
    text:
      "I'm not sure what you'd like me to do. Did you want to:\n" +
      "• `@RunbookAI investigate <issue>` — start an investigation\n" +
      "• `@RunbookAI summarize this thread` or `@RunbookAI is it resolved yet?` — check status / ask a question\n" +
      "• `@RunbookAI resolve this investigation` — mark it resolved\n" +
      "• `@RunbookAI reopen this investigation` — reopen a resolved one\n\n" +
      "Nothing was changed.",
  });
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
    text: "❌ Something went wrong. Please try again.",
  });
}

// ===========================
//  Structured Logging
// ===========================

/**
 * Structured log: [<Section>] <Step> | Key=Value
 * Never logs payloads, tokens, response URLs, or headers.
 */
function log(section: string, step: string, fields: Record<string, string | undefined>): void {
  const detail = Object.entries(fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(`[${section}] ${step}${detail ? ` | ${detail}` : ""}`);
}
