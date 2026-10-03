/**
 * Slack - durable incident job implementations.
 *
 * Every background unit of incident work lives here as a pure function of
 * (context, serializable params) so it can run live (per-event client) AND
 * replay after a crash (provider client) with identical behavior. Handlers
 * only read modal/view state and enqueue descriptors; they contain no
 * business logic and no Slack write logic beyond immediate ACKs.
 *
 * At-least-once semantics: replayed jobs converge via idempotency keys and
 * state guards (declare skips when a channel exists, acknowledge/close/link
 * are naturally idempotent). A crash between the last write and the job
 * completion mark can duplicate a timeline entry — accepted and logged.
 */

import type { IncidentCoordinator } from "../domains/incident/IncidentCoordinator.js";
import { IncidentStatus, incidentStatusLabel } from "../domains/incident/IncidentStatus.js";
import { parseSeverity } from "../domains/incident/IncidentSeverity.js";
import { parseRole, IncidentRole } from "../domains/incident/IncidentRoles.js";
import { IncidentAuthorizationError } from "../domains/incident/IncidentPermissions.js";
import { IncidentChannelConflictError } from "../domains/incident/IncidentRepository.js";
import type { SlackClientProvider } from "./slackClientProvider.js";
import { SlackChannelManager, type ChannelClientLike } from "./SlackChannelManager.js";
import { buildControlBlocks, controlMessageText } from "./SlackControlMessage.js";
import {
  type AnyClient,
  ctxFor,
  ephemeral,
  isOpenStatus,
} from "./incidentJobShared.js";
import { newCorrelationId, logger } from "../observability/logger.js";

export interface IncidentJobContext {
  readonly coordinator: IncidentCoordinator;
  readonly clients: SlackClientProvider;
  readonly resolveDefaultCommander?: (teamId: string) => Promise<string | null>;
}

export type IncidentJobOp =
  | "declare"
  | "update"
  | "role"
  | "action"
  | "followup"
  | "escalate"
  | "handover"
  | "resolve"
  | "cancel"
  | "close"
  | "rename"
  | "link"
  | "accept";

export interface IncidentJobDescriptor {
  readonly key: string;
  readonly op: IncidentJobOp;
  readonly teamId: string;
  readonly params: Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export async function runIncidentJob(
  ctx: IncidentJobContext,
  job: IncidentJobDescriptor,
  slackOverride?: AnyClient,
): Promise<void> {
  const slack = slackOverride ?? ((await ctx.clients.forTeam(job.teamId)) as unknown as AnyClient);
  switch (job.op) {
    case "declare":
      await runDeclare(ctx, slack, job);
      return;
    case "update":
      await runUpdate(ctx, slack, job);
      return;
    case "role":
      await runRole(ctx, job);
      return;
    case "action":
      await runAction(ctx, job);
      return;
    case "followup":
      await runFollowUp(ctx, job);
      return;
    case "escalate":
      await runEscalate(ctx, job);
      return;
    case "handover":
      await runHandover(ctx, job);
      return;
    case "resolve":
      await runResolve(ctx, slack, job);
      return;
    case "cancel":
      await runCancel(ctx, job);
      return;
    case "close":
      await runClose(ctx, slack, job);
      return;
    case "rename":
      await runRename(ctx, slack, job);
      return;
    case "link":
      await runLink(ctx, slack, job);
      return;
    case "accept":
      await runAccept(ctx, slack, job);
      return;
    default:
      throw new Error(`Unknown incident job op: ${String((job as { op?: unknown }).op)}`);
  }
}

function notifyIn(channelId: string | null, userId: string) {
  return async (slack: AnyClient, text: string): Promise<void> => {
    if (!channelId) return;
    await ephemeral(slack, channelId, userId, text);
  };
}

/**
 * Single failure notifier for live runs and replays: ephemeral in the
 * incident channel when known, DM to the user otherwise. Best-effort —
 * never fails the job. (notifyIn covers business-logic notices; this
 * covers failure delivery with the DM fallback.)
 */
async function notifyFailure(
  slack: AnyClient,
  channelId: string | null,
  userId: string,
  text: string,
): Promise<void> {
  try {
    if (channelId) {
      await ephemeral(slack, channelId, userId, text);
    } else {
      await (slack.chat.postMessage as (a: Record<string, unknown>) => Promise<{ ts?: string }>)({
        channel: userId,
        text,
      });
    }
  } catch {
    // Best effort — never fail the job on a notification.
  }
}

async function runDeclare(
  ctx: IncidentJobContext,
  slack: AnyClient,
  job: IncidentJobDescriptor,
): Promise<void> {
  const p = job.params;
  const teamId = job.teamId;
  const userId = str(p.userId);
  const idempotencyKey = str(p.idempotencyKey);
  try {
    const defaultCommander =
      (await ctx.resolveDefaultCommander?.(teamId).catch(() => null)) ?? userId;
    const severity = parseSeverity(p.severity);
    const incident = await ctx.coordinator.declare({
      teamId,
      title: str(p.title),
      description: str(p.description),
      incidentType: "operational",
      affectedService: str(p.service),
      ...(severity ? { severity } : {}),
      reporterId: userId,
      originChannelId: strOrNull(p.originChannelId),
      originMessageTs: strOrNull(p.originMessageTs),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      correlationId: newCorrelationId(),
      defaultCommanderId: defaultCommander || userId,
    });

    // Replay guard: a previous attempt already wired the channel.
    if (incident.channelId) {
      logger.info("IncidentJobs", "DeclareAlreadyWired", { incidentId: incident.id });
      return;
    }

    const jobChannels = new SlackChannelManager(slack as unknown as ChannelClientLike);
    const { channelId, channelName } = await jobChannels.createIncidentChannel({
      title: incident.title,
      correlationId: newCorrelationId(),
      teamId,
    });
    await ctx.coordinator.attachChannel(ctxFor(teamId, userId), incident.id, channelId, channelName, null);
    const commanders = incident.currentRoles[IncidentRole.IncidentCommander] ? [incident.currentRoles[IncidentRole.IncidentCommander]] : [];
    await jobChannels.inviteResponders(channelId, [...new Set([userId, ...commanders])], newCorrelationId(), teamId);

    const full = await ctx.coordinator.get(incident.id, teamId);
    const posted = await (slack.chat.postMessage as (a: Record<string, unknown>) => Promise<{ ts?: string }>)({
      channel: channelId,
      text: controlMessageText(full),
      blocks: buildControlBlocks(full),
    });
    if (posted.ts) {
      await ctx.coordinator.setControlMessage(incident.id, teamId, posted.ts);
      const permalink = await jobChannels.getPermalink(channelId, posted.ts);
      if (permalink) {
        await ctx.coordinator.attachChannel(ctxFor(teamId, userId), incident.id, channelId, channelName, permalink);
      }
    }
    logger.info("IncidentJobs", "DeclaredWithChannel", { incidentId: incident.id, channelId });

    // Optional origin-thread bootstrap (mention declares).
    const bootstrapTs = strOrNull(p.bootstrapThreadTs);
    const originChannelId = strOrNull(p.originChannelId);
    if (bootstrapTs && originChannelId) {
      try {
        const replies = await (slack.conversations.replies as (a: Record<string, unknown>) => Promise<{
          messages?: Array<Record<string, unknown>>;
        }>)({ channel: originChannelId, ts: bootstrapTs, limit: 20 });
        for (const m of (replies.messages ?? []).slice(0, 20)) {
          const mts = String(m.ts ?? "");
          if (!mts || m.bot_id) continue;
          try {
            await ctx.coordinator.addMessageRef(ctxFor(teamId, userId), incident.id, {
              channelId: originChannelId,
              messageTs: mts,
              threadTs: bootstrapTs,
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
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error("IncidentJobs", "DeclareFailed", { reason });
    if (/not_authed|invalid_auth|token_revoked|account_inactive/i.test(reason)) {
      const originChannelId = strOrNull(p.originChannelId);
      if (originChannelId) {
        try {
          await (slack.chat.postEphemeral as (a: Record<string, unknown>) => Promise<unknown>)({
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
    throw error;
  }
}

async function runUpdate(
  ctx: IncidentJobContext,
  slack: AnyClient,
  job: IncidentJobDescriptor,
): Promise<void> {
  const p = job.params;
  const teamId = job.teamId;
  const userId = str(p.userId);
  const incidentId = str(p.incidentId);
  const before = await ctx.coordinator.get(incidentId, teamId);
  // Live modal params carry no channelId — fall back to the incident channel
  // so replays notify exactly like live runs.
  const notify = notifyIn(strOrNull(p.channelId) ?? before.channelId, userId).bind(null, slack);
  if (before.status === "closed" || before.status === "cancelled") {
    await notify(
      `This incident is *${incidentStatusLabel(before.status)}* — updates are disabled. Reopen a new incident with \`/inc\` if the issue is back.`,
    );
    return;
  }
  const wasResolved = !isOpenStatus(before.status);
  const minutesText = str(p.minutes);
  const minutesParsed = minutesText ? Number(minutesText) : NaN;
  const minutes = Number.isFinite(minutesParsed) ? minutesParsed : null;
  await ctx.coordinator.postUpdate(ctxFor(teamId, userId, `update:${incidentId}:${job.key}`), incidentId, {
    text: str(p.text),
    ...(minutes !== null ? { nextUpdateInMinutes: minutes } : {}),
  });
  const current = await ctx.coordinator.get(incidentId, teamId);
  const severity = parseSeverity(p.severity);
  if (severity && severity !== current.severity) {
    await ctx.coordinator.setSeverity(ctxFor(teamId, userId), incidentId, severity);
  }
  const statusRaw = str(p.status).toLowerCase();
  if (
    statusRaw &&
    (Object.values(IncidentStatus) as string[]).includes(statusRaw) &&
    statusRaw !== current.status
  ) {
    await ctx.coordinator.changeStatus(ctxFor(teamId, userId), incidentId, statusRaw as IncidentStatus);
  }
  if (wasResolved) {
    const by = before.resolution ? ` by <@${before.resolution.resolvedBy}>` : "";
    await notify(
      `Heads up: this incident was already *${incidentStatusLabel(before.status)}*${by}. Your update was still recorded.`,
    );
  }
  await refreshControlFrom(ctx, slack, incidentId, teamId);
}

async function runRole(ctx: IncidentJobContext, job: IncidentJobDescriptor): Promise<void> {
  const p = job.params;
  const role = parseRole(p.role);
  const assignee = str(p.assignee);
  if (!role || !assignee) throw new Error("Role and assignee are required");
  await ctx.coordinator.assignRole(ctxFor(job.teamId, str(p.userId)), str(p.incidentId), role, assignee);
}

async function runAction(ctx: IncidentJobContext, job: IncidentJobDescriptor): Promise<void> {
  const p = job.params;
  await ctx.coordinator.createAction(ctxFor(job.teamId, str(p.userId), `action:${job.key}`), str(p.incidentId), {
    title: str(p.title),
    description: str(p.description),
    assignee: strOrNull(p.assignee),
  });
}

async function runFollowUp(ctx: IncidentJobContext, job: IncidentJobDescriptor): Promise<void> {
  const p = job.params;
  await ctx.coordinator.createFollowUp(ctxFor(job.teamId, str(p.userId), `followup:${job.key}`), str(p.incidentId), {
    title: str(p.title),
    description: str(p.description),
  });
}

async function runEscalate(ctx: IncidentJobContext, job: IncidentJobDescriptor): Promise<void> {
  const p = job.params;
  const targets = Array.isArray(p.targets) ? p.targets.map(String).filter(Boolean) : [];
  if (targets.length === 0) throw new Error("Select at least one person to escalate to");
  const reason = str(p.reason);
  if (!reason.trim()) throw new Error("Escalation reason is required");
  for (const toUser of targets) {
    await ctx.coordinator.escalate(ctxFor(job.teamId, str(p.userId), `escalate:${job.key}:${toUser}`), str(p.incidentId), toUser, reason);
  }
}

async function runHandover(ctx: IncidentJobContext, job: IncidentJobDescriptor): Promise<void> {
  const p = job.params;
  await ctx.coordinator.handover(ctxFor(job.teamId, str(p.userId), `handover:${job.key}`), str(p.incidentId), str(p.newCommander));
}

async function runResolve(
  ctx: IncidentJobContext,
  slack: AnyClient,
  job: IncidentJobDescriptor,
): Promise<void> {
  const p = job.params;
  const teamId = job.teamId;
  const userId = str(p.userId);
  const incidentId = str(p.incidentId);
  const before = await ctx.coordinator.get(incidentId, teamId);
  // Live modal params carry no channelId — fall back to the incident channel
  // so replays notify exactly like live runs.
  const notify = notifyIn(strOrNull(p.channelId) ?? before.channelId, userId).bind(null, slack);
  if (before.status === "resolved") {
    await notify(
      `This incident is already *Resolved*${before.resolution ? ` by <@${before.resolution.resolvedBy}>` : ""}. Nothing changed — close it with \`/inc close\` when the workflow is complete.`,
    );
    return;
  }
  await ctx.coordinator.resolve(ctxFor(teamId, userId, `resolve:${job.key}`), incidentId, {
    summary: str(p.summary),
    mitigation: str(p.mitigation),
  });
  await refreshControlFrom(ctx, slack, incidentId, teamId);
}

async function runCancel(ctx: IncidentJobContext, job: IncidentJobDescriptor): Promise<void> {
  const p = job.params;
  await ctx.coordinator.cancel(ctxFor(job.teamId, str(p.userId), `cancel:${job.key}`), str(p.incidentId), str(p.reason));
}

async function runClose(
  ctx: IncidentJobContext,
  slack: AnyClient,
  job: IncidentJobDescriptor,
): Promise<void> {
  const p = job.params;
  const before = await ctx.coordinator.get(str(p.incidentId), job.teamId);
  if (before.status === "closed") return;
  await ctx.coordinator.close(ctxFor(job.teamId, str(p.userId)), str(p.incidentId));
  await refreshControlFrom(ctx, slack, str(p.incidentId), job.teamId);
}

async function runRename(
  ctx: IncidentJobContext,
  slack: AnyClient,
  job: IncidentJobDescriptor,
): Promise<void> {
  const p = job.params;
  await ctx.coordinator.rename(ctxFor(job.teamId, str(p.userId), `rename:${job.key}`), str(p.incidentId), str(p.title));
  await refreshControlFrom(ctx, slack, str(p.incidentId), job.teamId);
}

async function runLink(
  ctx: IncidentJobContext,
  slack: AnyClient,
  job: IncidentJobDescriptor,
): Promise<void> {
  const p = job.params;
  const teamId = job.teamId;
  const userId = str(p.userId);
  const channelId = str(p.channelId);
  const targetId = str(p.targetId);
  try {
    const linked = await ctx.coordinator.linkChannel(
      ctxFor(teamId, userId, `link:${job.key}`),
      targetId,
      channelId,
      str(p.channelName) || channelId,
    );
    const posted = await (slack.chat.postMessage as (a: Record<string, unknown>) => Promise<{ ts?: string }>)({
      channel: channelId,
      text: controlMessageText(linked),
      blocks: buildControlBlocks(linked),
    });
    if (posted.ts) {
      await ctx.coordinator.setControlMessage(linked.id, teamId, posted.ts);
    }
  } catch (error) {
    logger.warn("IncidentJobs", "LinkFailed", {
      reason: error instanceof Error ? error.message : String(error),
    });
    const message = error instanceof Error ? error.message : "";
    await notifyFailure(
      slack,
      channelId || null,
      userId,
      /not found|different workspace/i.test(message)
        ? `I couldn't find incident \`${targetId}\` in this workspace. Check the ID and try again.`
        : error instanceof IncidentAuthorizationError
          ? "You are not permitted to link incidents."
          : error instanceof IncidentChannelConflictError
            ? "This channel is already coordinating another incident. Link from a different channel, or close that incident first."
            : "Could not link the incident. Please try again.",
    );
  }
}

async function runAccept(
  ctx: IncidentJobContext,
  slack: AnyClient,
  job: IncidentJobDescriptor,
): Promise<void> {
  const p = job.params;
  const teamId = job.teamId;
  const userId = str(p.userId);
  const incidentId = str(p.incidentId);
  try {
    await ctx.coordinator.acknowledgeRole(ctxFor(teamId, userId), incidentId, IncidentRole.IncidentCommander);
    await refreshControlFrom(ctx, slack, incidentId, teamId);
  } catch (error) {
    logger.warn("IncidentJobs", "AcceptFailed", {
      incidentId,
      reason: error instanceof Error ? error.message : String(error),
    });
    // The clicking user must hear about the failure (DM control has no
    // channel fallback); the control is refreshed so it never goes stale.
    await refreshControlFrom(ctx, slack, incidentId, teamId);
    const reason = error instanceof Error ? error.message : String(error);
    const text =
      error instanceof IncidentAuthorizationError
        ? "You are not permitted to accept this incident."
        : `Could not accept the incident (${reason}). Please try again.`;
    const incident = await ctx.coordinator.get(incidentId, teamId).catch(() => null);
    await notifyFailure(slack, incident?.channelId ?? null, userId, text);
  }
}

async function refreshControlFrom(
  ctx: IncidentJobContext,
  slack: AnyClient,
  incidentId: string,
  teamId: string,
): Promise<void> {
  try {
    const incident = await ctx.coordinator.get(incidentId, teamId);
    if (!incident.channelId || !incident.controlMessageTs) return;
    await (slack.chat.update as (a: Record<string, unknown>) => Promise<unknown>)({
      channel: incident.channelId,
      ts: incident.controlMessageTs,
      text: controlMessageText(incident),
      blocks: buildControlBlocks(incident),
    });
  } catch (error) {
    logger.warn("IncidentJobs", "ControlRefreshFailed", {
      incidentId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
