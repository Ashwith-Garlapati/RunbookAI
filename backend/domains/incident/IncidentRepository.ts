/**
 * Incident Domain - Persistence + membership contracts.
 *
 * Infrastructure depends on these, never the reverse.
 */

import type { Incident } from "./Incident.js";
import type { IncidentId, TeamId, SlackChannelId, SlackUserId, IdempotencyKey } from "./types.js";
import { MembershipLevel, IncidentRole } from "./IncidentRoles.js";

export interface IIncidentRepository {
  create(incident: Incident): Promise<Incident>;
  update(incident: Incident): Promise<Incident>;
  findById(id: IncidentId): Promise<Incident | null>;
  findByTeamAndChannel(teamId: TeamId, channelId: SlackChannelId): Promise<Incident | null>;
  findByIdempotencyKey(teamId: TeamId, key: IdempotencyKey): Promise<Incident | null>;
  findOpenByTeam(teamId: TeamId): Promise<Incident[]>;
  listByTeam(teamId: TeamId, limit?: number): Promise<Incident[]>;
  /** Optional: links a declare idempotency key for findByIdempotencyKey. */
  linkIdempotencyKey?(incidentId: IncidentId, key: IdempotencyKey): Promise<void>;
}

/** Idempotency record for Slack deliveries and mutating UI actions. */
export interface IIdempotencyStore {
  /**
   * Atomically claims a key. Returns true when this caller owns the key
   * (first delivery), false when it was already claimed (duplicate).
   */
  claim(teamId: TeamId, key: IdempotencyKey, ttlSeconds?: number): Promise<boolean>;
  release(teamId: TeamId, key: IdempotencyKey): Promise<void>;
}

export interface IMembershipResolver {
  resolveLevel(teamId: TeamId, slackUserId: SlackUserId, incident?: Incident): Promise<MembershipLevel>;
}

/**
 * Default resolver: env-configured owners/admins win, the incident's
 * current commander acts as commander for that incident, everyone else
 * is a member. Teams can inject their own resolver (HRIS/IdP backed).
 */
export class DefaultMembershipResolver implements IMembershipResolver {
  private readonly _owners: Set<string>;
  private readonly _admins: Set<string>;

  constructor(owners: string[] = [], admins: string[] = []) {
    this._owners = new Set(owners);
    this._admins = new Set(admins);
  }

  async resolveLevel(teamId: TeamId, slackUserId: SlackUserId, incident?: Incident): Promise<MembershipLevel> {
    const key = `${teamId}:${slackUserId}`;
    if (this._owners.has(key) || this._owners.has(slackUserId)) return MembershipLevel.Owner;
    if (this._admins.has(key) || this._admins.has(slackUserId)) return MembershipLevel.Admin;
    if (incident) {
      if (incident.currentRoles[IncidentRole.IncidentLead] === slackUserId) {
        return MembershipLevel.Commander;
      }
      if (incident.participants.some((p) => p.userId === slackUserId)) {
        return MembershipLevel.Responder;
      }
    }
    return MembershipLevel.Member;
  }
}
