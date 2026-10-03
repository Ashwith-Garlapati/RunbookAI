/**
 * Investigation Context Builder - DERIVED view only.
 *
 * Incident remains the source of truth for incident state; the Evidence
 * Store remains the source of truth for evidence. This builder only
 * combines them into a stable snapshot for future NLP/RAG/engine layers.
 * It never diagnoses, hypothesizes, or calls an LLM.
 */

import type { Incident } from "../domains/incident/Incident.js";
import type { IncidentCoordinator } from "../domains/incident/IncidentCoordinator.js";
import { EvidenceSource } from "../domains/investigation/EvidenceSource.js";
import type { EvidenceItem } from "../domains/investigation/EvidenceItem.js";
import type { IEvidenceRepository } from "../domains/investigation/RepositoryInterfaces.js";

export interface ContextIncident {
  readonly title: string;
  readonly description: string | null;
  readonly severity: string;
  readonly status: string;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface ContextTimelineEntry {
  readonly type: string;
  readonly actor: string;
  readonly at: string;
  readonly summary: string;
}

export interface ContextEvidence {
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly content: string;
  readonly searchableText: string;
  readonly occurredAt: string | null;
  readonly provenance: Record<string, unknown>;
  readonly sourceId: string;
}

export interface InvestigationContext {
  readonly investigationId: string;
  readonly incidentId: string;
  readonly teamId: string;
  readonly incident: ContextIncident;
  readonly timeline: ContextTimelineEntry[];
  readonly symptoms: string[];
  readonly affectedServices: string[];
  readonly endpoints: string[];
  readonly errors: string[];
  readonly repositories: string[];
  readonly participants: string[];
  readonly availableSources: string[];
  readonly evidenceSummary: { readonly slackCount: number; readonly githubCount: number; readonly totalCount: number };
  readonly slackEvidence: ContextEvidence[];
  readonly githubEvidence: ContextEvidence[];
  readonly otherEvidence: ContextEvidence[];
  readonly investigationWindow: { readonly start: string; readonly end: string | null };
  readonly generatedAt: string;
  readonly version: string;
}

export const INVESTIGATION_CONTEXT_VERSION = "1";

/**
 * Deterministic ordering: occurredAt ascending (missing last),
 * then source, then sourceId. Slack parents sort before their replies
 * (earlier ts; shorter sourceId breaks same-second ties).
 */
export function orderEvidence(items: EvidenceItem[]): EvidenceItem[] {
  return [...items].sort((a, b) => {
    const aTime = a.occurredAt ? a.occurredAt.getTime() : Number.POSITIVE_INFINITY;
    const bTime = b.occurredAt ? b.occurredAt.getTime() : Number.POSITIVE_INFINITY;
    if (aTime !== bTime) return aTime - bTime;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    const aKey = a.sourceId ?? a.reference;
    const bKey = b.sourceId ?? b.reference;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
}

function toContextEvidence(item: EvidenceItem): ContextEvidence {
  return {
    id: item.id,
    source: item.source,
    type: item.type,
    content: item.content ?? "",
    searchableText: item.searchableText ?? item.content ?? "",
    occurredAt: item.occurredAt ? item.occurredAt.toISOString() : null,
    provenance: item.provenance ? { ...item.provenance } : {},
    sourceId: item.sourceId ?? item.reference,
  };
}

/** Mechanical extraction (regex over incident text) — not analysis. */
function extractEndpoints(texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    const matches = text.match(/\/[a-zA-Z0-9_\-./{}:]+/g) ?? [];
    for (const m of matches) {
      if (m.length >= 2 && /[a-zA-Z]/.test(m)) found.add(m);
    }
  }
  return [...found].sort();
}

function extractErrors(texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const m of text.match(/\b[45]\d\d(?![0-9])/g) ?? []) found.add(m);
    for (const m of text.match(/\b(?:timeout|timed out|unauthorized|forbidden|refused|denied|exhausted|overload|panic|fatal)\b/gi) ?? [])
      found.add(m.toLowerCase());
  }
  return [...found].sort();
}

export class InvestigationContextBuilder {
  constructor(
    private readonly _coordinator: IncidentCoordinator,
    private readonly _evidence: IEvidenceRepository,
  ) {}

  async buildForIncident(params: {
    teamId: string;
    incidentId: string;
    investigationId?: string | undefined;
  }): Promise<InvestigationContext> {
    const incident: Incident = await this._coordinator.get(params.incidentId, params.teamId);
    const investigationId = params.investigationId ?? incident.investigationId ?? params.incidentId;
    const items = await this._evidence.findByInvestigationId(investigationId);
    return this.build({
      teamId: params.teamId,
      incidentId: incident.id,
      investigationId,
      incident,
      items,
    });
  }

  build(params: {
    teamId: string;
    incidentId: string;
    investigationId: string;
    incident: Incident;
    items: EvidenceItem[];
  }): InvestigationContext {
    const { incident, items } = params;
    const ordered = orderEvidence(items);
    const evidence = ordered.map(toContextEvidence);
    const slackEvidence = evidence.filter((e) => e.source === EvidenceSource.Slack);
    const githubEvidence = evidence.filter((e) => e.source === EvidenceSource.GitHub);
    const otherEvidence = evidence.filter((e) => e.source !== EvidenceSource.Slack && e.source !== EvidenceSource.GitHub);
    const availableSources = [...new Set(evidence.map((e) => e.source))].sort();

    const texts = [
      incident.title,
      incident.description,
      ...incident.updates.map((u) => u.text),
    ].filter((t) => t.length > 0);
    const symptoms = [incident.title, ...(incident.description ? [incident.description] : [])];
    const affectedServices = incident.affectedService ? [incident.affectedService] : [];

    const participants = new Set<string>([incident.reporterId, ...incident.participants.map((p) => p.userId)]);
    for (const item of ordered) {
      const userId = item.provenance?.["userId"];
      if (typeof userId === "string" && userId.length > 0) participants.add(userId);
    }
    const repositories = new Set<string>();
    for (const item of ordered) {
      const repo = item.provenance?.["repository"];
      if (typeof repo === "string" && repo.length > 0) repositories.add(repo);
    }

    const end =
      incident.resolution?.resolvedAt ?? incident.cancelInfo?.at ?? incident.closeInfo?.at ?? null;

    return {
      investigationId: params.investigationId,
      incidentId: params.incidentId,
      teamId: params.teamId,
      incident: {
        title: incident.title,
        description: incident.description.length > 0 ? incident.description : null,
        severity: String(incident.severity),
        status: String(incident.status),
        startedAt: incident.createdAt.toISOString(),
        updatedAt: incident.updatedAt.toISOString(),
      },
      timeline: incident.timeline.map((t) => ({
        type: String(t.type),
        actor: t.actor,
        at: t.at.toISOString(),
        summary: t.summary,
      })),
      symptoms,
      affectedServices,
      endpoints: extractEndpoints(texts),
      errors: extractErrors(texts),
      repositories: [...repositories].sort(),
      participants: [...participants].sort(),
      availableSources,
      evidenceSummary: {
        slackCount: slackEvidence.length,
        githubCount: githubEvidence.length,
        totalCount: evidence.length,
      },
      slackEvidence,
      githubEvidence,
      otherEvidence,
      investigationWindow: {
        start: incident.createdAt.toISOString(),
        end: end ? end.toISOString() : null,
      },
      generatedAt: new Date().toISOString(),
      version: INVESTIGATION_CONTEXT_VERSION,
    };
  }
}
