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
import { IncidentStatus } from "../domains/incident/IncidentStatus.js";
import { parseSeverity } from "../domains/incident/IncidentSeverity.js";
import { parseRole } from "../domains/incident/IncidentRoles.js";
import { SlackGateway, normalizeMention } from "./SlackGateway.js";
import { SlackChannelManager, type ChannelClientLike } from "./SlackChannelManager.js";
import {
  CONTROL_ACTIONS,
  buildControlBlocks,
  buildUpdateBlocks,
  buildTimelineBlocks,
  buildIncidentDetailsBlocks,
  controlMessageText,
} from "./SlackControlMessage.js";
import {
  MODAL_CALLBACKS,
  declareModal,
  updateModal,
  severityModal,
  roleModal,
  actionModal,
  followUpModal,
  escalateModal,
  handoverModal,
  resolveModal,
  cancelModal,
} from "./SlackModals.js";
import { newCorrelationId, logger } from "../observability/logger.js";

export interface IncidentSlackDeps {
  coordinator: IncidentCoordinator;
  gateway: SlackGateway;
  membership: IMembershipResolver;
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

async function refreshControl(client: AnyClient, deps: IncidentSlackDeps, incidentId: string, teamId: string): Promise<void> {
  try {
    const incident = await deps.coordinator.get(incidentId, teamId);
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

async function ephemeral(client: AnyClient, channel: string, user: string, text: string, threadTs?: string): Promise<void> {
  await client.chat.postEphemeral({
    channel,
    user,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
}

function ctxFor(teamId: string, actor: string, idempotencyKey?: string): CoordinatorContext {
  return {
    teamId,
    actor,
    correlationId: newCorrelationId(),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

export function registerIncidentSlackHandlers(bolt: App, deps: IncidentSlackDeps): void {
  registerIncCommand(bolt, deps);
  registerControlActions(bolt, deps);
  registerViewSubmissions(bolt, deps);
  registerAddToTimelineShortcut(bolt, deps);
  registerCreateIncidentShortcut(bolt, deps);
  registerIncidentMention(bolt, deps);
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
        case "severity":
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
            severity: severityModal,
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
          deps.gateway.enqueue({
            key: `close:${incident.id}:${command.trigger_id}`,
            run: async () => {
              await deps.coordinator.close(ctxFor(teamId, userId, `close:${command.trigger_id}`), incident.id);
              await refreshControl(c, deps, incident.id, teamId);
            },
          });
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
          deps.gateway.enqueue({
            key: `rename:${incident.id}:${command.trigger_id}`,
            run: async () => {
              await deps.coordinator.rename(ctxFor(teamId, userId, `rename:${command.trigger_id}`), incident.id, title);
              await refreshControl(c, deps, incident.id, teamId);
            },
          });
          await ephemeral(c, channelId, userId, "Renaming incident…");
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
  "• `/inc update|severity|roles|action|follow-up|escalate|handover|resolve|cancel` — incident operations",
  "• `/inc status` — show current incident details (read-only)",
  "• `/inc timeline` — view the curated timeline",
  "• `/inc rename <title>` — rename the incident",
  "• `/inc close` — close a resolved/cancelled incident",
].join("\n");

// ---------- control message buttons ----------

function registerControlActions(bolt: App, deps: IncidentSlackDeps): void {
  const openModalForAction: Record<string, (id: string) => unknown> = {
    [CONTROL_ACTIONS.update]: updateModal,
    [CONTROL_ACTIONS.severity]: severityModal,
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
      });
    }
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
    };
    const teamId = b.team?.id ?? "";
    const userId = b.user?.id ?? "";
    const incidentId = b.actions?.[0]?.value ?? "";
    if (!teamId || !userId || !incidentId) return;
    deps.gateway.enqueue({
      key: `close:${incidentId}:${userId}:${Date.now()}`,
      run: async () => {
        try {
          await deps.coordinator.close(ctxFor(teamId, userId), incidentId);
          await refreshControl(c, deps, incidentId, teamId);
        } catch (error) {
          logger.warn("IncidentSlack", "CloseFailed", {
            incidentId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });
  });
}

// ---------- modal submissions ----------

type ViewState = Record<string, Record<string, { value?: string; selected_option?: { value?: string }; selected_user?: string }>>;

function val(state: ViewState, block: string, action: string): string {
  const b = state[block]?.[action];
  return b?.value ?? b?.selected_option?.value ?? b?.selected_user ?? "";
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
    const description = val(state, "b_desc", "desc");
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

    deps.gateway.enqueue({
      key: idempotencyKey,
      run: async () => {
        try {
          const incident = await deps.coordinator.declare({
            teamId,
            title,
            description,
            incidentType: "operational",
            affectedService: service,
            ...(severity ? { severity } : {}),
            reporterId: userId,
            originChannelId: (meta.originChannelId as string | undefined) ?? null,
            originMessageTs: (meta.originMessageTs as string | undefined) ?? null,
            idempotencyKey,
            correlationId: newCorrelationId(),
          });

          // Create + wire the incident channel. The manager is built from the
          // per-event authorized client: the startup-global bolt.client
          // carries no token under Socket Mode (custom authorize) and every
          // call made with it fails with not_authed.
          const jobChannels = new SlackChannelManager(c as unknown as ChannelClientLike);
          const { channelId, channelName } = await jobChannels.createIncidentChannel({
            title: incident.title,
            correlationId: newCorrelationId(),
          });
          await deps.coordinator.attachChannel(ctxFor(teamId, userId), incident.id, channelId, channelName, null);
          await jobChannels.inviteResponders(channelId, [userId], newCorrelationId());

          const full = await deps.coordinator.get(incident.id, teamId);
          const posted = await c.chat.postMessage({
            channel: channelId,
            text: controlMessageText(full),
            blocks: buildControlBlocks(full),
          });
          if (posted.ts) {
            await deps.coordinator.setControlMessage(incident.id, teamId, posted.ts);
            const permalink = await jobChannels.getPermalink(channelId, posted.ts);
            if (permalink) {
              await deps.coordinator.attachChannel(ctxFor(teamId, userId), incident.id, channelId, channelName, permalink);
            }
          }
          logger.info("IncidentSlack", "DeclaredWithChannel", { incidentId: incident.id, channelId });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          logger.error("IncidentSlack", "DeclareFailed", { reason });
          // not_authed = stored workspace token is dead (app reinstalled or
          // scopes changed without reinstall). The incident record exists;
          // only Slack wiring failed — tell the reporter how to recover.
          if (/not_authed|invalid_auth|token_revoked|account_inactive/i.test(reason)) {
            const originChannelId = meta.originChannelId as string | undefined;
            if (originChannelId) {
              try {
                await c.chat.postEphemeral({
                  channel: originChannelId,
                  user: userId,
                  text:
                    "⚠️ Incident was recorded, but I could not create the incident channel: " +
                    "Slack rejected my workspace token. Please reinstall the RunbookAI app " +
                    "to this workspace, then `/inc` again.",
                });
              } catch {
                // Best effort — never fail the job on a notification.
              }
            }
          }
        }
      },
    });
  });

  const simpleModal = (
    callbackId: string,
    handler: (coord: IncidentCoordinator, incidentId: string, teamId: string, userId: string, state: ViewState) => Promise<void>,
  ): void => {
    bolt.view(callbackId, async ({ ack, body, view }) => {
      await ack();
      const b = body as unknown as { team?: { id?: string }; user?: { id?: string } };
      const teamId = b.team?.id ?? "";
      const userId = b.user?.id ?? "";
      const incidentId = view.private_metadata || "";
      if (!teamId || !userId || !incidentId) return;
      const state = view.state.values as unknown as ViewState;
      deps.gateway.enqueue({
        key: `${callbackId}:${view.id}`,
        run: async () => {
          try {
            await handler(deps.coordinator, incidentId, teamId, userId, state);
          } catch (error) {
            logger.warn("IncidentSlack", "ModalFailed", {
              callbackId,
              incidentId,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });
    });
  };

  simpleModal(MODAL_CALLBACKS.update, async (coord, incidentId, teamId, userId, state) => {
    const ctx = ctxFor(teamId, userId, `update:${incidentId}:${Date.now()}`);
    await coord.postUpdate(ctx, incidentId, {
      situation: val(state, "b_sit", "situation"),
      changed: val(state, "b_chg", "changed"),
      impact: val(state, "b_imp", "impact"),
      nextStep: val(state, "b_next", "next"),
    });
    // Optional dropdowns: severity and status change with the update.
    const severity = parseSeverity(val(state, "b_sev", "severity"));
    if (severity) {
      await coord.setSeverity(ctxFor(teamId, userId), incidentId, severity);
    }
    const statusRaw = val(state, "b_status", "status").toLowerCase();
    if (statusRaw && (Object.values(IncidentStatus) as string[]).includes(statusRaw)) {
      await coord.changeStatus(ctxFor(teamId, userId), incidentId, statusRaw as IncidentStatus);
    }
  });

  simpleModal(MODAL_CALLBACKS.severity, async (coord, incidentId, teamId, userId, state) => {
    const parsed = parseSeverity(val(state, "b_value", "severity"));
    if (!parsed) throw new Error("Invalid severity");
    await coord.setSeverity(ctxFor(teamId, userId), incidentId, parsed);
  });

  simpleModal(MODAL_CALLBACKS.role, async (coord, incidentId, teamId, userId, state) => {
    const role = parseRole(val(state, "b_role", "role"));
    const assignee = val(state, "b_user", "assignee");
    if (!role || !assignee) throw new Error("Role and assignee are required");
    await coord.assignRole(ctxFor(teamId, userId), incidentId, role, assignee);
  });

  simpleModal(MODAL_CALLBACKS.action, async (coord, incidentId, teamId, userId, state) => {
    await coord.createAction(ctxFor(teamId, userId), incidentId, {
      title: val(state, "b_title", "title"),
      description: val(state, "b_desc", "desc"),
      assignee: val(state, "b_assignee", "assignee") || null,
    });
  });

  simpleModal(MODAL_CALLBACKS.followup, async (coord, incidentId, teamId, userId, state) => {
    await coord.createFollowUp(ctxFor(teamId, userId), incidentId, {
      title: val(state, "b_title", "title"),
      description: val(state, "b_desc", "desc"),
    });
  });

  simpleModal(MODAL_CALLBACKS.escalate, async (coord, incidentId, teamId, userId, state) => {
    await coord.escalate(ctxFor(teamId, userId), incidentId, val(state, "b_user", "to_user"), val(state, "b_reason", "reason"));
  });

  simpleModal(MODAL_CALLBACKS.handover, async (coord, incidentId, teamId, userId, state) => {
    await coord.handover(ctxFor(teamId, userId), incidentId, val(state, "b_user", "new_commander"));
  });

  simpleModal(MODAL_CALLBACKS.resolve, async (coord, incidentId, teamId, userId, state) => {
    await coord.resolve(ctxFor(teamId, userId), incidentId, {
      summary: val(state, "b_summary", "summary"),
      mitigation: val(state, "b_mitigation", "mitigation"),
    });
  });

  simpleModal(MODAL_CALLBACKS.cancel, async (coord, incidentId, teamId, userId, state) => {
    await coord.cancel(ctxFor(teamId, userId), incidentId, val(state, "b_reason", "reason"));
  });
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
      });
      await ephemeral(c, channelId, userId, "Could not open the incident form. Please try `/inc` instead.");
    }
  });
}

// ---------- @RunbookAI incident declare from a thread ----------

function registerIncidentMention(bolt: App, deps: IncidentSlackDeps): void {
  bolt.event("app_mention", async ({ event, client }) => {
    const e = event as unknown as {
      team?: string;
      user?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
      text?: string;
      bot_id?: string;
    };
    if (e.bot_id || !e.user || !e.channel || !e.ts) return;
    const text = e.text ?? "";
    if (!/\b(incident|declare)\b/i.test(text)) return; // other intents belong to existing handlers
    const c = client as unknown as AnyClient;
    const teamId = e.team ?? "";
    if (!teamId) return;
    const envelope = normalizeMention({
      teamId,
      eventId: `${e.channel}:${e.ts}:${e.user}`,
      userId: e.user,
      channelId: e.channel,
      messageTs: e.ts,
      threadTs: e.thread_ts ?? null,
      text,
    });
    const eventId = envelope.eventId;
    const first = await deps.gateway.acceptDelivery(teamId, eventId, "app_mention_incident");
    if (!first) return;

    deps.gateway.enqueue({
      key: `mention-declare:${eventId}`,
      run: async () => {
        try {
          const title = text.replace(/<@[^>]+>/g, "").replace(/\b(incident|declare)\b/gi, "").trim().slice(0, 200) || "Incident from thread";
          const idempotencyKey = `mention:${teamId}:${e.channel}:${e.thread_ts ?? e.ts}`;
          const existing = await deps.coordinator.findByChannel(teamId, e.channel as string);
          if (existing) {
            await ephemeral(c, e.channel as string, e.user as string, `This channel already tracks incident *${existing.title}*.`, e.thread_ts ?? e.ts);
            return;
          }
          const incident = await deps.coordinator.declare({
            teamId,
            title,
            description: "",
            reporterId: e.user as string,
            originChannelId: e.channel as string,
            originMessageTs: (e.thread_ts ?? e.ts ?? null) as string | null,
            idempotencyKey,
            correlationId: envelope.correlationId,
          });
          // Bootstrap the origin thread (bounded: latest 20, then event-driven).
          try {
            const clientAny = c as unknown as { conversations: { replies(args: Record<string, unknown>): Promise<{ messages?: Array<Record<string, unknown>> }> } };
            const replies = await clientAny.conversations.replies({ channel: e.channel, ts: e.thread_ts ?? e.ts, limit: 20 });
            for (const m of (replies.messages ?? []).slice(0, 20)) {
              const mts = String(m.ts ?? "");
              if (!mts || m.bot_id) continue;
              try {
                await deps.coordinator.addMessageRef(ctxFor(teamId, e.user as string), incident.id, {
                  channelId: e.channel as string,
                  messageTs: mts,
                  threadTs: (e.thread_ts ?? e.ts) as string,
                  author: String(m.user ?? "unknown"),
                  text: String(m.text ?? "").slice(0, 2000),
                  permalink: null,
                });
              } catch {
                // duplicates / validation — skip silently
              }
            }
          } catch {
            // thread bootstrap is best-effort
          }
          await ephemeral(
            c,
            e.channel as string,
            e.user as string,
            `🚨 Incident *${incident.title}* declared. Run \`/inc\` in the new incident channel to coordinate.`,
            e.thread_ts ?? e.ts,
          );
        } catch (error) {
          logger.warn("IncidentSlack", "MentionDeclareFailed", {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });
  });
}
