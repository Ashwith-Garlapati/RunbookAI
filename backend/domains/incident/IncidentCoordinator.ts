/**
 * Incident Domain - Incident Coordinator (sole mutator for incidents).
 *
 * Every Slack handler, modal, action, and REST controller MUST go through
 * here. Responsibilities:
 * - resolve membership → authorize (server-side, never trust Slack alone)
 * - enforce idempotency keys (no duplicate incidents/channels/actions)
 * - mutate the aggregate → persist → publish incident.* events
 *
 * No AI. No investigation logic. Deterministic coordination only.
 */

import type {
  IncidentId,
  TeamId,
  SlackUserId,
  SlackChannelId,
  MessageTs,
  ActionId,
  FollowUpId,
  IdempotencyKey,
} from "./types.js";
import { Incident, type DeclareIncidentParams, type ActionStatus, type FollowUpStatus } from "./Incident.js";
import { IncidentStatus } from "./IncidentStatus.js";
import { IncidentSeverity } from "./IncidentSeverity.js";
import { IncidentRole, MembershipLevel, levelAtLeast } from "./IncidentRoles.js";
import type {
  IIncidentRepository,
  IIdempotencyStore,
  IMembershipResolver,
} from "./IncidentRepository.js";
import { IncidentVersionConflictError } from "./IncidentRepository.js";
import { IncidentBus } from "./IncidentBus.js";
import {
  canPerform,
  canAssignRole,
  IncidentAuthorizationError,
  type IncidentOperation,
} from "./IncidentPermissions.js";
import { logger } from "../../observability/logger.js";

export interface CoordinatorContext {
  readonly teamId: TeamId;
  readonly actor: SlackUserId;
  readonly correlationId: string;
  readonly idempotencyKey?: IdempotencyKey;
}

export class IncidentCoordinator {
  constructor(
    private readonly _repo: IIncidentRepository,
    private readonly _bus: IncidentBus,
    private readonly _idempotency: IIdempotencyStore,
    private readonly _membership: IMembershipResolver,
  ) {}

  get bus(): IncidentBus {
    return this._bus;
  }

  // ---------- declaration ----------

  async declare(params: DeclareIncidentParams & { correlationId: string }): Promise<Incident> {
    const ctx: CoordinatorContext = {
      teamId: params.teamId,
      actor: params.reporterId,
      correlationId: params.correlationId,
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    };
    await this.authorize(ctx, "declare");
    if (params.idempotencyKey) {
      const existing = await this._repo.findByIdempotencyKey(params.teamId, params.idempotencyKey);
      if (existing) {
        logger.info("Coordinator", "DeclareIdempotentHit", {
          correlationId: ctx.correlationId,
          incidentId: existing.id,
        });
        return existing;
      }
      await this._idempotency.claim(params.teamId, params.idempotencyKey);
    }
    try {
      const incident = Incident.declare(params);
      // Provisional commander at declare time: configured default, if provided.
      // Runs on the same object before first persist, so create/assign share
      // one write and one event batch.
      if (params.defaultCommanderId) {
        incident.assignRole(params.reporterId, IncidentRole.IncidentCommander, params.defaultCommanderId);
      }
      await this._repo.create(incident);
      if (params.idempotencyKey && this._repo.linkIdempotencyKey) {
        await this._repo.linkIdempotencyKey(incident.id, params.idempotencyKey);
      }
      await this._bus.publishAll(incident.pullEvents());
      logger.info("Coordinator", "Declared", {
        correlationId: ctx.correlationId,
        incidentId: incident.id,
        teamId: incident.teamId,
        severity: incident.severity,
      });
      return incident;
    } catch (error) {
      if (params.idempotencyKey) {
        await this._idempotency.release(params.teamId, params.idempotencyKey);
      }
      throw error;
    }
  }

  // ---------- generic mutation helper ----------

  private async mutate(
    ctx: CoordinatorContext,
    op: IncidentOperation,
    incidentId: IncidentId,
    fn: (incident: Incident) => unknown,
  ): Promise<Incident> {
    if (ctx.idempotencyKey) {
      const claimed = await this._idempotency.claim(ctx.teamId, `${op}:${ctx.idempotencyKey}`);
      if (!claimed) {
        const current = await this.load(incidentId);
        logger.info("Coordinator", "MutationIdempotentHit", {
          correlationId: ctx.correlationId,
          incidentId,
          op,
        });
        return current;
      }
    }
    const incident = await this.load(incidentId);
    this.ensureTeam(incident.teamId, ctx.teamId);
    const level = await this._membership.resolveLevel(ctx.teamId, ctx.actor, incident);
    if (!canPerform(level, op)) {
      logger.warn("Coordinator", "Unauthorized", {
        correlationId: ctx.correlationId,
        incidentId,
        op,
        userId: ctx.actor,
        level,
      });
      throw new IncidentAuthorizationError(op, level);
    }
    // Optimistic concurrency: at most one retry on a fresh snapshot. The
    // stale aggregate (with its uncommitted events) is discarded, so a
    // retried mutation can never publish phantom timeline entries. If the
    // operation is no longer valid on new state, its own validation throws.
    // Stale validation failures (e.g. a transition that became legal while
    // we held old state) reload once and revalidate instead of failing.
    for (let attempt = 1; ; attempt += 1) {
      const target = attempt === 1 ? incident : await this.load(incidentId);
      if (attempt > 1) this.ensureTeam(target.teamId, ctx.teamId);
      try {
        await fn(target);
      } catch (error) {
        if (isStaleTransition(error) && attempt < 2) {
          logger.info("Coordinator", "StaleValidationRetry", {
            correlationId: ctx.correlationId,
            incidentId,
            op,
          });
          continue;
        }
        throw error;
      }
      try {
        await this._repo.update(target);
        await this._bus.publishAll(target.pullEvents());
        return target;
      } catch (error) {
        if (!(error instanceof IncidentVersionConflictError) || attempt >= 2) throw error;
        logger.info("Coordinator", "VersionConflictRetry", {
          correlationId: ctx.correlationId,
          incidentId,
          op,
          expectedVersion: error.expectedVersion,
          currentVersion: error.currentVersion,
        });
      }
    }
  }

  // ---------- channel ----------

  async attachChannel(
    ctx: CoordinatorContext,
    incidentId: IncidentId,
    channelId: SlackChannelId,
    channelName: string,
    permalink: string | null,
  ): Promise<Incident> {
    return this.mutate(ctx, "declare", incidentId, (i) => i.attachChannel(ctx.actor, channelId, channelName, permalink));
  }

  async setControlMessage(incidentId: IncidentId, teamId: TeamId, ts: MessageTs): Promise<Incident> {
    const incident = await this.load(incidentId);
    this.ensureTeam(incident.teamId, teamId);
    incident.setControlMessage(ts);
    await this._repo.update(incident);
    return incident;
  }

  /**
   * Links an existing incident to a channel (`/inc link`). Same-channel
   * calls are idempotent (returned untouched, no events).
   */
  async linkChannel(
    ctx: CoordinatorContext,
    incidentId: IncidentId,
    channelId: SlackChannelId,
    channelName: string,
  ): Promise<Incident> {
    const current = await this.load(incidentId);
    this.ensureTeam(current.teamId, ctx.teamId);
    if (current.channelId === channelId) {
      return current;
    }
    return this.mutate(ctx, "link_channel", incidentId, (i) =>
      i.relinkChannel(ctx.actor, channelId, channelName),
    );
  }

  // ---------- core fields ----------

  async rename(ctx: CoordinatorContext, incidentId: IncidentId, title: string): Promise<Incident> {
    return this.mutate(ctx, "rename", incidentId, (i) => i.rename(ctx.actor, title));
  }

  async setSeverity(ctx: CoordinatorContext, incidentId: IncidentId, severity: IncidentSeverity): Promise<Incident> {
    return this.mutate(ctx, "change_severity", incidentId, (i) => i.setSeverity(ctx.actor, severity));
  }

  async changeStatus(ctx: CoordinatorContext, incidentId: IncidentId, status: IncidentStatus): Promise<Incident> {
    return this.mutate(ctx, "change_status", incidentId, (i) => i.changeStatus(ctx.actor, status));
  }

  // ---------- roles / participants ----------

  async assignRole(
    ctx: CoordinatorContext,
    incidentId: IncidentId,
    role: IncidentRole,
    assignee: SlackUserId,
  ): Promise<Incident> {
    const incident = await this.load(incidentId);
    this.ensureTeam(incident.teamId, ctx.teamId);
    const level = await this._membership.resolveLevel(ctx.teamId, ctx.actor, incident);
    const occupied = (incident.currentRoles[role] ?? null) !== null;
    if (!canAssignRole(level, role, occupied)) {
      throw new IncidentAuthorizationError("assign_role", level);
    }
    return this.mutate(ctx, "assign_role", incidentId, (i) => i.assignRole(ctx.actor, role, assignee));
  }

  async unassignRole(ctx: CoordinatorContext, incidentId: IncidentId, role: IncidentRole): Promise<Incident> {
    return this.mutate(ctx, "assign_role", incidentId, (i) => i.unassignRole(ctx.actor, role));
  }

  /**
   * Accepts a role assignment (Accept button / acknowledge flow).
   * Allowed for the assignee themselves or commander level and above.
   * Idempotent: already-acknowledged returns the incident untouched.
   */
  async acknowledgeRole(
    ctx: CoordinatorContext,
    incidentId: IncidentId,
    role: IncidentRole,
  ): Promise<Incident> {
    const incident = await this.load(incidentId);
    this.ensureTeam(incident.teamId, ctx.teamId);
    const assignee = incident.currentRoles[role] ?? null;
    if (!assignee) throw new Error(`No assignee for role ${role}`);
    const level = await this._membership.resolveLevel(ctx.teamId, ctx.actor, incident);
    if (ctx.actor !== assignee && !levelAtLeast(level, MembershipLevel.Commander)) {
      throw new IncidentAuthorizationError("acknowledge", level);
    }
    if (incident.assignmentState(role) === "active") {
      return incident;
    }
    incident.acknowledgeRole(ctx.actor, role);
    // Same optimistic-concurrency retry as mutate(): reload on conflict and
    // re-apply against fresh state (still valid here — assignment unchanged).
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this._repo.update(incident);
        await this._bus.publishAll(incident.pullEvents());
        break;
      } catch (error) {
        if (!(error instanceof IncidentVersionConflictError) || attempt >= 2) throw error;
        const fresh = await this.load(incidentId);
        if (fresh.assignmentState(role) === "active") return fresh;
        fresh.acknowledgeRole(ctx.actor, role);
        await this._repo.update(fresh);
        await this._bus.publishAll(fresh.pullEvents());
        return fresh;
      }
    }
    logger.info("Coordinator", "RoleAcknowledged", {
      correlationId: ctx.correlationId,
      incidentId,
      role,
      assignee,
    });
    return incident;
  }

  async addParticipant(
    ctx: CoordinatorContext,
    incidentId: IncidentId,
    userId: SlackUserId,
    source: "invited" | "interacted" = "invited",
  ): Promise<Incident> {
    return this.mutate(ctx, "view", incidentId, (i) => i.ensureParticipant(userId, source));
  }

  // ---------- updates / actions / follow-ups ----------

  async postUpdate(
    ctx: CoordinatorContext,
    incidentId: IncidentId,
    fields: { text: string; nextUpdateInMinutes?: number | null },
  ): Promise<Incident> {
    return this.mutate(ctx, "post_update", incidentId, (i) => i.postUpdate(ctx.actor, fields));
  }

  async createAction(
    ctx: CoordinatorContext,
    incidentId: IncidentId,
    params: { title: string; description?: string; assignee?: SlackUserId | null; priority?: string; dueAt?: Date | null },
  ): Promise<Incident> {
    return this.mutate(ctx, "create_action", incidentId, (i) => i.createAction(ctx.actor, params));
  }

  async updateAction(
    ctx: CoordinatorContext,
    incidentId: IncidentId,
    actionId: ActionId,
    patch: { status?: ActionStatus; assignee?: SlackUserId | null; title?: string; description?: string },
  ): Promise<Incident> {
    return this.mutate(ctx, "update_action", incidentId, (i) => i.updateAction(ctx.actor, actionId, patch));
  }

  async createFollowUp(
    ctx: CoordinatorContext,
    incidentId: IncidentId,
    params: { title: string; description?: string; assignee?: SlackUserId | null; dueAt?: Date | null },
  ): Promise<Incident> {
    return this.mutate(ctx, "create_followup", incidentId, (i) => i.createFollowUp(ctx.actor, params));
  }

  async updateFollowUp(
    ctx: CoordinatorContext,
    incidentId: IncidentId,
    followUpId: FollowUpId,
    patch: { status?: FollowUpStatus },
  ): Promise<Incident> {
    return this.mutate(ctx, "update_followup", incidentId, (i) => i.updateFollowUp(ctx.actor, followUpId, patch));
  }

  // ---------- escalation / handover / refs ----------

  async escalate(ctx: CoordinatorContext, incidentId: IncidentId, toUser: SlackUserId, reason: string): Promise<Incident> {
    return this.mutate(ctx, "escalate", incidentId, (i) => i.escalate(ctx.actor, toUser, reason));
  }

  async handover(ctx: CoordinatorContext, incidentId: IncidentId, newCommander: SlackUserId): Promise<Incident> {
    return this.mutate(ctx, "handover", incidentId, (i) => i.handover(ctx.actor, newCommander));
  }

  async addMessageRef(
    ctx: CoordinatorContext,
    incidentId: IncidentId,
    ref: { channelId: SlackChannelId; messageTs: MessageTs; threadTs: MessageTs | null; author: SlackUserId; text: string; permalink: string | null },
  ): Promise<Incident> {
    return this.mutate(ctx, "add_message_ref", incidentId, (i) => i.addMessageRef(ctx.actor, ref));
  }

  // ---------- resolution lifecycle ----------

  async resolve(
    ctx: CoordinatorContext,
    incidentId: IncidentId,
    packet: { summary: string; affectedService?: string; mitigation?: string },
  ): Promise<Incident> {
    return this.mutate(ctx, "resolve", incidentId, (i) => i.resolve(ctx.actor, packet));
  }

  async cancel(ctx: CoordinatorContext, incidentId: IncidentId, reason: string): Promise<Incident> {
    return this.mutate(ctx, "cancel", incidentId, (i) => i.cancel(ctx.actor, reason));
  }

  async close(ctx: CoordinatorContext, incidentId: IncidentId): Promise<Incident> {
    return this.mutate(ctx, "close", incidentId, (i) => i.close(ctx.actor));
  }

  // ---------- queries ----------

  async get(incidentId: IncidentId, teamId: TeamId): Promise<Incident> {
    const incident = await this.load(incidentId);
    this.ensureTeam(incident.teamId, teamId);
    return incident;
  }

  async findByChannel(teamId: TeamId, channelId: SlackChannelId): Promise<Incident | null> {
    return this._repo.findByTeamAndChannel(teamId, channelId);
  }

  async listOpen(teamId: TeamId): Promise<Incident[]> {
    return this._repo.findOpenByTeam(teamId);
  }

  // ---------- private ----------

  private async load(id: IncidentId): Promise<Incident> {
    const incident = await this._repo.findById(id);
    if (!incident) throw new Error(`Incident not found: ${id}`);
    return incident;
  }

  private ensureTeam(actual: TeamId, expected: TeamId): void {
    if (actual !== expected) throw new Error("Incident belongs to a different workspace");
  }

  private async authorize(ctx: CoordinatorContext, op: IncidentOperation): Promise<void> {
    const level = await this._membership.resolveLevel(ctx.teamId, ctx.actor);
    if (!canPerform(level, op)) throw new IncidentAuthorizationError(op, level);
  }
}

/**
 * Detects an invalid-transition error structurally (by name) so the incident
 * bounded context stays independent of the lifecycle module owning the class.
 */
function isStaleTransition(error: unknown): boolean {
  return error instanceof Error && error.name === "InvalidIncidentTransitionError";
}
