import { createHash, randomUUID } from "node:crypto";

import type { EvidenceId, InvestigationId } from "./types.js";
import type { EvidenceSource } from "./EvidenceSource.js";
import type { Evidence, EvidenceProvenance } from "./Evidence.js";

export interface CanonicalEvidenceParams {
  readonly investigationId: InvestigationId;
  readonly source: EvidenceSource;
  readonly type: string;
  readonly sourceId: string;
  readonly teamId?: string | undefined;
  readonly incidentId?: string | undefined;
  readonly title?: string | undefined;
  readonly content?: string | undefined;
  readonly searchableText?: string | undefined;
  readonly occurredAt?: Date | undefined;
  readonly provenance?: EvidenceProvenance | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly collectedAt?: Date | undefined;
}

/** Stable SHA-256 over source+type+sourceId+content for cross-run dedupe. */
export function hashEvidenceParts(source: string, type: string, sourceId: string, content: string): string {
  return createHash("sha256").update(`${source}:${type}:${sourceId}:${content}`, "utf8").digest("hex");
}

export class EvidenceItem implements Evidence {
  readonly id: EvidenceId;
  readonly investigationId: InvestigationId;
  readonly source: EvidenceSource;
  readonly type: string;
  readonly reference: string;
  readonly collectedAt: Date;
  readonly metadata: Record<string, unknown>;
  readonly teamId: string | undefined;
  readonly incidentId: string | undefined;
  readonly title: string | undefined;
  readonly content: string | undefined;
  readonly searchableText: string | undefined;
  readonly occurredAt: Date | undefined;
  readonly provenance: EvidenceProvenance | undefined;
  readonly sourceId: string | undefined;
  readonly hash: string | undefined;

  /** collectedAt doubles as createdAt (no separate persisted field). */
  get createdAt(): Date {
    return this.collectedAt;
  }

  private constructor(props: Evidence) {
    this.id = props.id;
    this.investigationId = props.investigationId;
    this.source = props.source;
    this.type = props.type;
    this.reference = props.reference;
    this.collectedAt = props.collectedAt;
    this.metadata = { ...props.metadata };
    this.teamId = props.teamId;
    this.incidentId = props.incidentId;
    this.title = props.title;
    this.content = props.content;
    this.searchableText = props.searchableText;
    this.occurredAt = props.occurredAt;
    this.provenance = props.provenance ? { ...props.provenance } : undefined;
    this.sourceId = props.sourceId;
    this.hash = props.hash;
  }

  static create(params: {
    investigationId: InvestigationId;
    source: EvidenceSource;
    type: string;
    reference: string;
    metadata?: Record<string, unknown>;
  }): EvidenceItem {
    return new EvidenceItem({
      id: randomUUID() as EvidenceId,
      investigationId: params.investigationId,
      source: params.source,
      type: params.type,
      reference: params.reference,
      collectedAt: new Date(),
      metadata: params.metadata ?? {},
    });
  }

  /**
   * Canonical factory for all sources. `reference` is set to `sourceId`
   * so legacy readers (reference-only) keep working unchanged. The id
   * mixes in the investigationId so identical evidence in different
   * investigations gets distinct document IDs; `hash` stays the pure
   * content hash used for deduplication.
   */
  static createCanonical(params: CanonicalEvidenceParams): EvidenceItem {
    const content = params.content ?? "";
    const hash = hashEvidenceParts(params.source, params.type, params.sourceId, content);
    const id = createHash("sha256").update(`${params.investigationId}:${hash}`, "utf8").digest("hex");
    return new EvidenceItem({
      id: `ev_${id.slice(0, 24)}` as EvidenceId,
      investigationId: params.investigationId,
      source: params.source,
      type: params.type,
      reference: params.sourceId,
      collectedAt: params.collectedAt ?? new Date(),
      metadata: params.metadata ? { ...params.metadata } : {},
      ...(params.teamId ? { teamId: params.teamId } : {}),
      ...(params.incidentId ? { incidentId: params.incidentId } : {}),
      ...(params.title ? { title: params.title } : {}),
      content,
      searchableText: params.searchableText ?? content,
      ...(params.occurredAt ? { occurredAt: params.occurredAt } : {}),
      ...(params.provenance ? { provenance: { ...params.provenance } } : {}),
      sourceId: params.sourceId,
      hash,
    });
  }

  static reconstitute(props: Evidence): EvidenceItem {
    return new EvidenceItem(props);
  }
}
