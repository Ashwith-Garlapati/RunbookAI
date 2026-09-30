/**
 * Infrastructure - Mongo-backed incident repository + idempotency store.
 */

import { randomUUID } from "node:crypto";

import { IncidentModel } from "../models/Incident.model.js";
import { SlackProcessedEventModel } from "../models/IncidentOps.model.js";
import { Incident } from "../domains/incident/Incident.js";
import type {
  IIncidentRepository,
  IIdempotencyStore,
} from "../domains/incident/IncidentRepository.js";
import { IncidentVersionConflictError } from "../domains/incident/IncidentRepository.js";
import type {
  IncidentId,
  TeamId,
  SlackChannelId,
  IdempotencyKey,
} from "../domains/incident/types.js";
import { IncidentStatus } from "../domains/incident/IncidentStatus.js";

const OPEN_STATUSES = [
  IncidentStatus.Detected,
  IncidentStatus.Investigating,
  IncidentStatus.Identified,
  IncidentStatus.Mitigating,
  IncidentStatus.Monitoring,
];

function toDocument(incident: Incident): Record<string, unknown> {  const props = incident.toProps();
  return {
    _id: props.id,
    teamId: props.teamId,
    organizationId: props.organizationId,
    title: props.title,
    description: props.description,
    incidentType: props.incidentType,
    affectedService: props.affectedService,
    severity: props.severity,
    status: props.status,
    channelId: props.channelId,
    channelName: props.channelName,
    channelPermalink: props.channelPermalink,
    originChannelId: props.originChannelId,
    originMessageTs: props.originMessageTs,
    controlMessageTs: props.controlMessageTs,
    reporterId: props.reporterId,
    currentRoles: props.currentRoles,
    roleHistory: props.roleHistory,
    participants: props.participants,
    updates: props.updates,
    actions: props.actions,
    followUps: props.followUps,
    escalations: props.escalations,
    messageRefs: props.messageRefs,
    timeline: props.timeline,
    activity: props.activity,
    transitions: props.transitions,
    severityHistory: props.severityHistory,
    resolution: props.resolution,
    cancelInfo: props.cancelInfo,
    closeInfo: props.closeInfo,
    nextUpdateAt: props.nextUpdateAt,
    nextUpdateFor: props.nextUpdateFor,
    investigationId: props.investigationId,
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
    version: props.version,
  };
}

/** Maps stored updates; legacy 4-field rows are composed into text. */
function toUpdate(raw: unknown): Incident["updates"][number] {
  const u = (raw ?? {}) as Record<string, unknown>;
  const text =
    typeof u.text === "string" && u.text.length > 0
      ? u.text
      : [u.situation, u.changed, u.impact, u.nextStep]
          .filter((v): v is string => typeof v === "string" && v.length > 0)
          .join("\n");
  return {
    id: String(u.id ?? ""),
    author: String(u.author ?? ""),
    at: u.at instanceof Date ? u.at : new Date(String(u.at ?? Date.now())),
    text,
  };
}

/**
 * Dual-read for the pre-rename `incident_lead` key: rows written before the
 * Incident Commander rename load with the canonical key. Writes always use
 * the new value, so old rows heal on first update. No migration needed.
 */
function normalizeRoles(raw: unknown): Incident["currentRoles"] {
  const roles = ((raw ?? {}) as Record<string, string | null>);
  if (roles.incident_lead !== undefined && roles.incident_commander === undefined) {
    const { incident_lead: legacy, ...rest } = roles;
    return { ...rest, incident_commander: legacy } as Incident["currentRoles"];
  }
  return roles as Incident["currentRoles"];
}

function normalizeHistoryRole<T>(entry: T): T {
  const rec = (entry ?? {}) as Record<string, unknown>;
  if (rec.role === "incident_lead") {
    return { ...rec, role: "incident_commander" } as T;
  }
  return entry;
}

function toDomain(doc: Record<string, unknown>): Incident {
  const d = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return Incident.reconstitute({
    id: String(doc._id),
    teamId: String(doc.teamId),
    organizationId: (doc.organizationId as string | undefined) ?? undefined,
    title: String(doc.title ?? ""),
    description: String(doc.description ?? ""),
    incidentType: String(doc.incidentType ?? "operational"),
    affectedService: String(doc.affectedService ?? ""),
    severity: doc.severity as Incident["severity"],
    status: doc.status as Incident["status"],
    channelId: (doc.channelId as SlackChannelId | null) ?? null,
    channelName: (doc.channelName as string | null) ?? null,
    channelPermalink: (doc.channelPermalink as string | null) ?? null,
    originChannelId: (doc.originChannelId as SlackChannelId | null) ?? null,
    originMessageTs: (doc.originMessageTs as string | null) ?? null,
    controlMessageTs: (doc.controlMessageTs as string | null) ?? null,
    reporterId: String(doc.reporterId ?? ""),
    currentRoles: normalizeRoles(doc.currentRoles),
    roleHistory: arr<Record<string, unknown>>(doc.roleHistory).map(normalizeHistoryRole) as unknown as Incident["roleHistory"],
    participants: arr(doc.participants),
    updates: arr(doc.updates).map(toUpdate),
    actions: arr(doc.actions),
    followUps: arr(doc.followUps),
    escalations: arr(doc.escalations),
    messageRefs: arr(doc.messageRefs),
    timeline: arr(doc.timeline),
    activity: arr(doc.activity),
    transitions: arr(doc.transitions),
    severityHistory: arr(doc.severityHistory),
    resolution: (doc.resolution as Incident["resolution"]) ?? null,
    cancelInfo: (doc.cancelInfo as Incident["cancelInfo"]) ?? null,
    closeInfo: (doc.closeInfo as Incident["closeInfo"]) ?? null,
    nextUpdateAt: doc.nextUpdateAt ? d(doc.nextUpdateAt) : null,
    nextUpdateFor: (doc.nextUpdateFor as string | null) ?? null,
    investigationId: (doc.investigationId as string | null) ?? null,
    createdAt: d(doc.createdAt),
    updatedAt: d(doc.updatedAt),
    version: typeof doc.version === "number" ? doc.version : 1,
  });
}

export class MongoIncidentRepository implements IIncidentRepository {
  async create(incident: Incident): Promise<Incident> {
    const doc = new IncidentModel({ ...toDocument(incident) });
    await doc.save();
    return incident;
  }

  async update(incident: Incident): Promise<Incident> {
    const expected = incident.version;
    // Legacy rows predate versioning: match either the expected version or
    // its absence (one-time bootstrap; every write stamps a version after).
    const updated = await IncidentModel.findOneAndUpdate(
      {
        _id: incident.id,
        $or: [{ version: expected }, { version: { $exists: false } }],
      },
      { $set: { ...toDocument(incident), version: expected + 1 } },
      { new: true },
    ).lean();
    if (!updated) {
      const current = await IncidentModel.findById(incident.id).select("version").lean();
      const currentVersion =
        current && typeof (current as { version?: unknown }).version === "number"
          ? (current as { version: number }).version
          : null;
      throw new IncidentVersionConflictError(incident.id, expected, currentVersion);
    }
    incident.version = expected + 1;
    return incident;
  }

  async findById(id: IncidentId): Promise<Incident | null> {
    const doc = await IncidentModel.findById(id).lean();
    return doc ? toDomain(doc as Record<string, unknown>) : null;
  }

  async findByTeamAndChannel(teamId: TeamId, channelId: SlackChannelId): Promise<Incident | null> {
    const doc = await IncidentModel.findOne({ teamId, channelId }).lean();
    return doc ? toDomain(doc as Record<string, unknown>) : null;
  }

  async findByIdempotencyKey(teamId: TeamId, key: IdempotencyKey): Promise<Incident | null> {
    const doc = await IncidentModel.findOne({ teamId, idempotencyKey: key }).lean();
    return doc ? toDomain(doc as Record<string, unknown>) : null;
  }

  async findOpenByTeam(teamId: TeamId): Promise<Incident[]> {
    const docs = await IncidentModel.find({ teamId, status: { $in: OPEN_STATUSES } })
      .sort({ createdAt: -1 })
      .lean();
    return docs.map((d) => toDomain(d as Record<string, unknown>));
  }

  async listByTeam(teamId: TeamId, limit = 50): Promise<Incident[]> {
    const docs = await IncidentModel.find({ teamId }).sort({ createdAt: -1 }).limit(limit).lean();
    return docs.map((d) => toDomain(d as Record<string, unknown>));
  }

  /** Stores the declare idempotency key on the incident for findByIdempotencyKey. */
  async linkIdempotencyKey(incidentId: IncidentId, key: IdempotencyKey): Promise<void> {
    await IncidentModel.findByIdAndUpdate(incidentId, { $set: { idempotencyKey: key } });
  }
}

export class MongoIdempotencyStore implements IIdempotencyStore {
  async claim(teamId: TeamId, key: IdempotencyKey, ttlSeconds?: number): Promise<boolean> {
    void ttlSeconds;
    try {
      await SlackProcessedEventModel.create({
        _id: randomUUID(),
        teamId,
        eventId: key,
        kind: "mutation",
        createdAt: new Date(),
      });
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && /duplicate key/i.test(error.message)) return false;
      throw error;
    }
  }

  async release(teamId: TeamId, key: IdempotencyKey): Promise<void> {
    await SlackProcessedEventModel.deleteOne({ teamId, eventId: key });
  }

  /** Claims a raw Slack delivery (event_id / action trigger). False = duplicate. */
  async claimDelivery(teamId: TeamId, eventId: string, kind: string): Promise<boolean> {
    try {
      await SlackProcessedEventModel.create({
        _id: randomUUID(),
        teamId,
        eventId,
        kind,
        createdAt: new Date(),
      });
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && /duplicate key/i.test(error.message)) return false;
      throw error;
    }
  }
}
