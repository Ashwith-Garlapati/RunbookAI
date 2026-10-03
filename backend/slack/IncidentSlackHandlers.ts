/**
 * Slack - incident coordination handlers (/inc commands, buttons, modals).
 *
 * Thin by design: validate Slack payload → resolve workspace/user →
 * dedupe delivery → ACK fast → enqueue background work → IncidentCoordinator
 * (auth + state + persistence) → refresh control message.
 *
 * No business logic here. No AI. Secret-safe logging only.
 */

import type { App } from "@slack/bolt";

import type { IncidentCoordinator, CoordinatorContext } from "../domains/incident/IncidentCoordinator.js";
import type { IMembershipResolver } from "../domains/incident/IncidentRepository.js";
import { IncidentAuthorizationError } from "../domains/incident/IncidentPermissions.js";
import { parseSeverity } from "../domains/incident/IncidentSeverity.js";
import { SlackGateway } from "./SlackGateway.js";
import { runIncidentJob, type IncidentJobContext, type IncidentJobDescriptor, type IncidentJobOp } from "./incidentJobs.js";
import type { AnyClient as JobClient } from "./incidentJobShared.js";
import {
  CONTROL_ACTIONS,
  buildTimelineBlocks,
  buildIncidentDetailsBlocks,
} from "./SlackControlMessage.js";
import {
  MODAL_CALLBACKS,
  declareModal,
  updateModal,
  roleModal,
  actionModal,
  followUpModal,
  escalateModal,
  handoverModal,
  resolveModal,
  cancelModal,
  richTextToMarkdown,
} from "./SlackModals.js";
import { newCorrelationId, logger } from "../observability/logger.js";
import { slackErrorCode } from "./slackErrors.js";

export interface IncidentSlackDeps {
  coordinator: IncidentCoordinator;
  gateway: SlackGateway;
  membership: IMembershipResolver;
  /** Shared job runner context (live runs and replays execute the same code). */
  jobs: IncidentJobContext;
  /** Resolves the team-configured default commander, if any. */
  resolveDefaultCommander?: (teamId: string) => Promise<string | null>;
}

type AnyClient = {
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

async function ephemeral(client: AnyClient, channel: string, user: string, text: string, threadTs?: string): Promise<void> {
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
function ctxFor(teamId: string, actor: string, idempotencyKey?: string): CoordinatorContext {
  return {
    teamId,
    actor,
    correlationId: newCorrelationId(),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

/**
 * Enqueues one durable job shared by the live run and any crash replay:
 * the same key + descriptor drives both, so idempotency keys, error
 * handling, and teamId propagation can never diverge.
 */
function enqueueIncidentJob(deps: IncidentSlackDeps, client: unknown, job: IncidentJobDescriptor): void {
  deps.gateway.enqueue({
    key: job.key,
    durable: { op: job.op, teamId: job.teamId, params: job.params },
    run: () => runIncidentJob(deps.jobs, job, client as JobClient),
  });
}

export function registerIncidentSlackHandlers(bolt: App, deps: IncidentSlackDeps): void {
  registerIncCommand(bolt, deps);
  registerControlActions(bolt, deps);
  registerViewSubmissions(bolt, deps);
  registerAddToTimelineShortcut(bolt, deps);
  registerCreateIncidentShortcut(bolt, deps);
}

// ---------- /inc command group ----------

function registerIncCommand(bolt: App, deps: IncidentSlackDeps): void {
  bolt.command("/inc", async ({ command, ack, client }) => {
    await ack();
    const c = client as unknown as AnyClient;
    const teamId = command.team_id;
    const userId = command.user_id;
    const channelId = command.channel_id;
    const raw = (command.text ?? "").trim();
    const [sub, ...rest] = raw.split(/\s+/);
    const correlationId = newCorrelationId();

    const first = await deps.gateway.acceptDelivery(teamId, `cmd:${command.trigger_id}`, "slash_command");
    if (!first) return;

    try {
      switch ((sub ?? "").toLowerCase()) {
        case "":
          // Bare `/inc` declares — the most common action gets the shortest path.
          await (c.views.open as (a: Record<string, unknown>) => Promise<unknown>)({
            trigger_id: command.trigger_id,
            view: declareModal(JSON.stringify({ originChannelId: channelId })),
          });
          return;
        case "help":
          await ephemeral(c, channelId, userId, INC_HELP);
          return;
        case "timeline": {
          const incident = await deps.coordinator.findByChannel(teamId, channelId);
          if (!incident) {
            await ephemeral(c, channelId, userId, "No incident is linked to this channel. Use `/inc` first.");
            return;
          }
          await ephemeral(c, channelId, userId, "Incident timeline", undefined);
          await c.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: "Incident timeline",
            blocks: buildTimelineBlocks(incident.timeline),
          });
          return;
        }
        case "status": {
          // Read-only: shows current incident details, changes nothing.
          const incident = await deps.coordinator.findByChannel(teamId, channelId);
          if (!incident) {
            await ephemeral(c, channelId, userId, "No incident is linked to this channel. Use `/inc` first.");
            return;
          }
          await c.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: `Incident status: ${incident.title}`,
            blocks: buildIncidentDetailsBlocks(incident),
          });
          return;
        }
        case "update":
        case "roles":
        case "role":
        case "action":
        case "follow-up":
        case "followup":
        case "escalate":
        case "handover":
        case "resolve":
        case "cancel": {
          const incident = await deps.coordinator.findByChannel(teamId, channelId);
          if (!incident) {
            await ephemeral(c, channelId, userId, "No incident is linked to this channel. Use `/inc` first.");
            return;
          }
          const modalMap: Record<string, (id: string) => unknown> = {
            update: updateModal,
            roles: roleModal,
            role: roleModal,
            action: actionModal,
            "follow-up": followUpModal,
            followup: followUpModal,
            escalate: escalateModal,
            handover: handoverModal,
            resolve: resolveModal,
            cancel: cancelModal,
          };
          const builder = modalMap[(sub ?? "").toLowerCase()];
          if (!builder) return;
          await (c.views.open as (a: Record<string, unknown>) => Promise<unknown>)({
            trigger_id: command.trigger_id,
            view: builder(incident.id),
          });
          return;
        }
        case "close": {
          const incident = await deps.coordinator.findByChannel(teamId, channelId);
          if (!incident) {
            await ephemeral(c, channelId, userId, "No incident is linked to this channel.");
            return;
          }
          const job: IncidentJobDescriptor = {
            key: `close:${incident.id}:${command.trigger_id}`,
            op: "close",
            teamId,
            params: { incidentId: incident.id, userId },
          };
          enqueueIncidentJob(deps, c, job);
          await ephemeral(c, channelId, userId, "Closing incident…");
          return;
        }
        case "rename": {
          const incident = await deps.coordinator.findByChannel(teamId, channelId);
          if (!incident) {
            await ephemeral(c, channelId, userId, "No incident is linked to this channel.");
            return;
          }
          const title = rest.join(" ").trim();
          if (!title) {
            await ephemeral(c, channelId, userId, "Usage: `/inc rename <new title>`");
            return;
          }
          const job: IncidentJobDescriptor = {
            key: `rename:${incident.id}:${command.trigger_id}`,
            op: "rename",
            teamId,
            params: { incidentId: incident.id, userId, title },
          };
          enqueueIncidentJob(deps, c, job);
          await ephemeral(c, channelId, userId, "Renaming incident…");
          return;
        }
        case "link": {
          const targetId = rest.join(" ").trim();
          if (!targetId) {
            await ephemeral(c, channelId, userId, "Usage: `/inc link <incident-id>`");
            return;
          }
          const job: IncidentJobDescriptor = {
            key: `link:${targetId}:${channelId}:${command.trigger_id}`,
            op: "link",
            teamId,
            params: { incidentId: targetId, targetId, userId, channelId, channelName: command.channel_name ?? channelId },
          };
          enqueueIncidentJob(deps, c, job);
          await ephemeral(c, channelId, userId, "Linking incident to this channel…");
          return;
        }
        default:
          await ephemeral(c, channelId, userId, `Unknown subcommand \`${sub}\`.\n${INC_HELP}`);
          return;
      }
    } catch (error) {
      logger.warn("IncidentSlack", "IncCommandFailed", { correlationId, reason: error instanceof Error ? error.message : String(error) });
      await ephemeral(
        c,
        channelId,
        userId,
        error instanceof IncidentAuthorizationError ? "You are not permitted to do that." : "Something went wrong. Please try again.",
      );
    }
  });
}

const INC_HELP = [
  "*RunbookAI incident commands*",
  "• `/inc` — declare an incident (opens a form)",
  "• `/inc update|roles|action|follow-up|escalate|handover|resolve|cancel` — incident operations",
  "• `/inc status` — show current incident details (read-only)",
  "• `/inc timeline` — view the curated timeline",
  "• `/inc rename <title>` — rename the incident",
  "• `/inc link <incident-id>` — coordinate an existing incident from this channel",
  "• `/inc close` — close a resolved/cancelled incident",
].join("\n");

// ---------- control message buttons ----------

function registerControlActions(bolt: App, deps: IncidentSlackDeps): void {
  const openModalForAction: Record<string, (id: string) => unknown> = {
    [CONTROL_ACTIONS.update]: updateModal,
    [CONTROL_ACTIONS.roles]: roleModal,
    [CONTROL_ACTIONS.actions]: actionModal,
    [CONTROL_ACTIONS.followups]: followUpModal,
    [CONTROL_ACTIONS.escalate]: escalateModal,
    [CONTROL_ACTIONS.handover]: handoverModal,
    [CONTROL_ACTIONS.resolve]: resolveModal,
    [CONTROL_ACTIONS.cancel]: cancelModal,
  };

  for (const [actionId, builder] of Object.entries(openModalForAction)) {
    bolt.action(actionId, async ({ ack, body, client }) => {
      await ack();
      const c = client as unknown as AnyClient;
      const b = body as unknown as {
        team?: { id?: string };
        user?: { id?: string };
        trigger_id?: string;
        actions?: Array<{ value?: string }>;
        channel?: { id?: string };
      };
      const teamId = b.team?.id ?? "";
      const userId = b.user?.id ?? "";
      const incidentId = b.actions?.[0]?.value ?? "";
      if (!teamId || !userId || !incidentId || !b.trigger_id) return;
      const first = await deps.gateway.acceptDelivery(teamId, `action:${actionId}:${b.trigger_id}`, "block_action");
      if (!first) return;
      try {
        await (c.views.open as (a: Record<string, unknown>) => Promise<unknown>)({
          trigger_id: b.trigger_id,
          view: builder(incidentId),
        });
      } catch (error) {
        logger.warn("IncidentSlack", "OpenModalFailed", {
          actionId,
          incidentId,
          reason: error instanceof Error ? error.message : String(error),
          slackError: slackErrorCode(error),
        });
      }
    });
  }

  bolt.action(CONTROL_ACTIONS.status, async ({ ack, body, client }) => {
    await ack();
    const c = client as unknown as AnyClient;
    const b = body as unknown as {
      team?: { id?: string };
      user?: { id?: string };
      channel?: { id?: string };
      actions?: Array<{ value?: string }>;
    };
    const teamId = b.team?.id ?? "";
    const userId = b.user?.id ?? "";
    const incidentId = b.actions?.[0]?.value ?? "";
    const channelId = b.channel?.id ?? "";
    if (!teamId || !userId || !incidentId) return;
    try {
      const incident = await deps.coordinator.get(incidentId, teamId);
      await c.chat.postEphemeral({
        channel: channelId || incident.channelId || "",
        user: userId,
        text: `Incident status: ${incident.title}`,
        blocks: buildIncidentDetailsBlocks(incident),
      });
    } catch (error) {
      logger.warn("IncidentSlack", "StatusViewFailed", {
        incidentId,
        reason: error instanceof Error ? error.message : String(error),
        slackError: slackErrorCode(error),
      });
    }
  });

    bolt.action(CONTROL_ACTIONS.accept, async ({ ack, body, client }) => {
    await ack();
    const c = client as unknown as AnyClient;
    const b = body as unknown as {
      team?: { id?: string };
      user?: { id?: string };
      actions?: Array<{ value?: string }>;
      trigger_id?: string;
    };
    const teamId = b.team?.id ?? "";
    const userId = b.user?.id ?? "";
    const incidentId = b.actions?.[0]?.value ?? "";
    const triggerId = b.trigger_id ?? "";
    if (!teamId || !userId || !incidentId) return;
    const job: IncidentJobDescriptor = {
      key: `accept:${incidentId}:${userId}:${triggerId}`,
      op: "accept",
      teamId,
      params: { incidentId, userId },
    };
    enqueueIncidentJob(deps, c, job);
  });

  bolt.action(CONTROL_ACTIONS.timeline, async ({ ack, body, client }) => {
    await ack();
    const c = client as unknown as AnyClient;
    const b = body as unknown as {
      team?: { id?: string };
      user?: { id?: string };
      channel?: { id?: string };
      actions?: Array<{ value?: string }>;
    };
    const teamId = b.team?.id ?? "";
    const userId = b.user?.id ?? "";
    const incidentId = b.actions?.[0]?.value ?? "";
    const channelId = b.channel?.id ?? "";
    if (!teamId || !userId || !incidentId) return;
    try {
      const incident = await deps.coordinator.get(incidentId, teamId);
      await c.chat.postEphemeral({
        channel: channelId || incident.channelId || "",
        user: userId,
        text: "Incident timeline",
        blocks: buildTimelineBlocks(incident.timeline),
      });
    } catch (error) {
      logger.warn("IncidentSlack", "TimelineViewFailed", {
        incidentId,
        reason: error instanceof Error ? error.message : String(error),
        slackError: slackErrorCode(error),
      });
    }
  });

  bolt.action(CONTROL_ACTIONS.close, async ({ ack, body, client }) => {
    await ack();
    const c = client as unknown as AnyClient;
    const b = body as unknown as {
      team?: { id?: string };
      user?: { id?: string };
      actions?: Array<{ value?: string }>;
      trigger_id?: string;
    };
    const teamId = b.team?.id ?? "";
    const userId = b.user?.id ?? "";
    const incidentId = b.actions?.[0]?.value ?? "";
    if (!teamId || !userId || !incidentId) return;
    const job: IncidentJobDescriptor = {
      key: `close:${incidentId}:${userId}:${b.trigger_id ?? "manual"}`,
      op: "close",
      teamId,
      params: { incidentId, userId },
    };
    enqueueIncidentJob(deps, c, job);
  });
}

// ---------- modal submissions ----------

type ViewState = Record<
  string,
  Record<
    string,
    {
      value?: string;
      selected_option?: { value?: string };
      selected_user?: string;
      selected_users?: string[];
      rich_text_value?: unknown;
    }
  >
>;

function val(state: ViewState, block: string, action: string): string {
  const b = state[block]?.[action];
  return b?.value ?? b?.selected_option?.value ?? b?.selected_user ?? "";
}

/** Reads a rich-text composer field, preserving the user's wording/formatting. */
function rval(state: ViewState, block: string, action: string): string {
  const b = state[block]?.[action];
  if (b?.rich_text_value !== undefined) return richTextToMarkdown(b.rich_text_value);
  return b?.value ?? "";
}

/** Reads a single- or multi-user select as a list. */
function usersVal(state: ViewState, block: string, action: string): string[] {
  const b = state[block]?.[action];
  if (Array.isArray(b?.selected_users)) return b.selected_users.filter(Boolean);
  if (b?.selected_user) return [b.selected_user];
  return [];
}

function registerViewSubmissions(bolt: App, deps: IncidentSlackDeps): void {
  bolt.view(MODAL_CALLBACKS.declare, async ({ ack, body, view, client }) => {
    await ack();
    const c = client as unknown as AnyClient;
    const b = body as unknown as { team?: { id?: string }; user?: { id?: string } };
    const teamId = b.team?.id ?? "";
    const userId = b.user?.id ?? "";
    if (!teamId || !userId) return;
    const state = view.state.values as unknown as ViewState;
    const title = val(state, "b_title", "title");
    const description = rval(state, "b_desc", "desc");
    const severityRaw = val(state, "b_sev", "severity");
    const service = val(state, "b_service", "service");
    let meta: { originChannelId?: string; originMessageTs?: string | null } = {};
    try {
      meta = JSON.parse(view.private_metadata || "{}");
    } catch {
      meta = {};
    }
    const severity = parseSeverity(severityRaw) ?? undefined;
    const idempotencyKey = `declare:${teamId}:${userId}:${view.id}`;

    const job: IncidentJobDescriptor = {
      key: idempotencyKey,
      op: "declare",
      teamId,
      params: {
        title,
        description,
        ...(severity ? { severity } : {}),
        service,
        userId,
        originChannelId: (meta.originChannelId as string | undefined) ?? null,
        originMessageTs: (meta.originMessageTs as string | undefined) ?? null,
        idempotencyKey,
      },
    };
    enqueueIncidentJob(deps, c, job);
  });

  const simpleModal = (
    callbackId: string,
    describe: (
      incidentId: string,
      teamId: string,
      userId: string,
      state: ViewState,
    ) => { op: IncidentJobOp; params: Record<string, unknown> },
  ): void => {
    bolt.view(callbackId, async ({ ack, body, view, client }) => {
      await ack();
      const c = client as unknown as AnyClient;
      const b = body as unknown as { team?: { id?: string }; user?: { id?: string } };
      const teamId = b.team?.id ?? "";
      const userId = b.user?.id ?? "";
      const incidentId = view.private_metadata || "";
      if (!teamId || !userId || !incidentId) return;
      const state = view.state.values as unknown as ViewState;
      const { op, params } = describe(incidentId, teamId, userId, state);
      const job: IncidentJobDescriptor = {
        key: `${callbackId}:${view.id}`,
        op,
        teamId,
        params: { incidentId, userId, ...params },
      };
      enqueueIncidentJob(deps, c, job);
    });
  };

  simpleModal(MODAL_CALLBACKS.update, (_incidentId, _teamId, _userId, state) => ({
    op: "update",
    params: {
      text: rval(state, "b_chg", "changed"),
      severity: val(state, "b_sev", "severity"),
      status: val(state, "b_status", "status"),
      minutes: val(state, "b_next_in", "next_in"),
    },
  }));

  simpleModal(MODAL_CALLBACKS.role, (_incidentId, _teamId, _userId, state) => ({
    op: "role",
    params: { role: val(state, "b_role", "role"), assignee: val(state, "b_user", "assignee") },
  }));

  simpleModal(MODAL_CALLBACKS.action, (_incidentId, _teamId, _userId, state) => ({
    op: "action",
    params: {
      title: val(state, "b_title", "title"),
      description: rval(state, "b_desc", "desc"),
      assignee: val(state, "b_assignee", "assignee") || null,
    },
  }));

  simpleModal(MODAL_CALLBACKS.followup, (_incidentId, _teamId, _userId, state) => ({
    op: "followup",
    params: { title: val(state, "b_title", "title"), description: rval(state, "b_desc", "desc") },
  }));

  simpleModal(MODAL_CALLBACKS.escalate, (_incidentId, _teamId, _userId, state) => ({
    op: "escalate",
    params: { targets: usersVal(state, "b_user", "to_user"), reason: rval(state, "b_reason", "reason") },
  }));

  simpleModal(MODAL_CALLBACKS.handover, (_incidentId, _teamId, _userId, state) => ({
    op: "handover",
    params: { newCommander: val(state, "b_user", "new_commander") },
  }));

  simpleModal(MODAL_CALLBACKS.resolve, (_incidentId, _teamId, _userId, state) => ({
    op: "resolve",
    params: { summary: rval(state, "b_summary", "summary"), mitigation: rval(state, "b_mitigation", "mitigation") },
  }));

  simpleModal(MODAL_CALLBACKS.cancel, (_incidentId, _teamId, _userId, state) => ({
    op: "cancel",
    params: { reason: rval(state, "b_reason", "reason") },
  }));
}

// ---------- Add-to-timeline shortcut ----------

function registerAddToTimelineShortcut(bolt: App, deps: IncidentSlackDeps): void {
  bolt.shortcut("add_to_timeline", async ({ shortcut, ack, client }) => {
    await ack();
    const c = client as unknown as AnyClient;
    const s = shortcut as unknown as {
      team?: { id?: string };
      user?: { id?: string };
      channel?: { id?: string };
      message?: { ts?: string; thread_ts?: string; user?: string; text?: string };
      trigger_id?: string;
    };
    const teamId = s.team?.id ?? "";
    const userId = s.user?.id ?? "";
    const channelId = s.channel?.id ?? "";
    const msg = s.message;
    if (!teamId || !userId || !channelId || !msg?.ts) return;
    const first = await deps.gateway.acceptDelivery(teamId, `shortcut:${s.trigger_id ?? msg.ts}`, "message_action");
    if (!first) return;
    try {
      const incident = await deps.coordinator.findByChannel(teamId, channelId);
      if (!incident) {
        await ephemeral(c, channelId, userId, "No incident is linked to this channel.");
        return;
      }
      await deps.coordinator.addMessageRef(ctxFor(teamId, userId), incident.id, {
        channelId,
        messageTs: msg.ts,
        threadTs: msg.thread_ts ?? null,
        author: msg.user ?? "unknown",
        text: msg.text ?? "",
        permalink: null,
      });
      await ephemeral(c, channelId, userId, "Message added to the incident timeline.");
    } catch (error) {
      await ephemeral(
        c,
        channelId,
        userId,
        error instanceof Error && /already added/i.test(error.message)
          ? "That message is already on the timeline."
          : "Could not add the message. Please try again.",
      );
    }
  });
}

// ---------- Create-incident shortcut ----------

function registerCreateIncidentShortcut(bolt: App, deps: IncidentSlackDeps): void {
  bolt.shortcut("create_incident", async ({ shortcut, ack, client }) => {
    await ack();
    const c = client as unknown as AnyClient;
    const s = shortcut as unknown as {
      team?: { id?: string };
      user?: { id?: string };
      channel?: { id?: string };
      message?: { ts?: string; text?: string };
      trigger_id?: string;
    };
    const teamId = s.team?.id ?? "";
    const userId = s.user?.id ?? "";
    const channelId = s.channel?.id ?? "";
    if (!teamId || !userId || !channelId || !s.trigger_id) return;

    const first = await deps.gateway.acceptDelivery(teamId, `shortcut:create_incident:${s.trigger_id}`, "message_action");
    if (!first) return;

    // Same declare form as bare `/inc`, prefilled with the message that
    // the shortcut was invoked on. Opened synchronously: trigger_id expires
    // within seconds, so this must not go through the background queue.
    const meta = JSON.stringify({
      originChannelId: channelId,
      originMessageTs: s.message?.ts ?? null,
    });
    try {
      await (c.views.open as (a: Record<string, unknown>) => Promise<unknown>)({
        trigger_id: s.trigger_id,
        view: declareModal(meta, { description: (s.message?.text ?? "").slice(0, 2000) }),
      });
    } catch (error) {
      logger.warn("IncidentSlack", "CreateIncidentModalFailed", {
        channelId,
        userId,
        reason: error instanceof Error ? error.message : String(error),
        slackError: slackErrorCode(error),
      });
      await ephemeral(c, channelId, userId, "Could not open the incident form. Please try `/inc` instead.");
    }
  });
}
