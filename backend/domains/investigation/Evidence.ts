/**
 * Investigation Domain - Evidence Interfaces (Placeholder)
 *
 * Defines the contracts for evidence that will be collected during an investigation.
 * These are interfaces only — actual evidence collectors are not yet implemented.
 *
 * The Investigation aggregate stores evidence as references (EvidenceReference).
 * These interfaces define the shape of evidence data that will be populated
 * by future collector integrations (Slack, GitHub, etc.).
 */

import type { EvidenceId, InvestigationId } from "./types.js";
import type { EvidenceSource } from "./EvidenceSource.js";

/** Source-specific provenance. Never reduced to a plain string summary. */
export type EvidenceProvenance = Record<string, unknown>;

/** Where an extracted entity came from: raw text, structured provenance, or investigation context. */
export type EnrichmentOrigin = "text" | "provenance" | "context";

export interface EnrichmentSpan {
  readonly start: number;
  readonly end: number;
}

export type EnrichmentEntityType =
  | "SERVICE"
  | "ENDPOINT"
  | "HTTP_METHOD"
  | "HTTP_STATUS"
  | "ERROR"
  | "FUNCTION"
  | "CLASS"
  | "FILE"
  | "REPOSITORY"
  | "COMMIT"
  | "PULL_REQUEST"
  | "DEPLOYMENT"
  | "INCIDENT"
  | "INFRA";

export interface ExtractedEntity {
  readonly value: string;
  readonly type: EnrichmentEntityType;
  readonly source: EnrichmentOrigin;
  readonly span?: EnrichmentSpan | undefined;
  /** True when the value also appears in the known investigation context. */
  readonly contextMatched?: boolean | undefined;
}

export type EnrichmentErrorKind =
  | "HTTP_STATUS"
  | "TIMEOUT"
  | "CONNECTION"
  | "DATABASE"
  | "EXCEPTION"
  | "ERROR_CODE";

export interface ExtractedError {
  readonly value: string;
  readonly kind: EnrichmentErrorKind;
  readonly technology?: string | undefined;
  readonly span?: EnrichmentSpan | undefined;
}

export type EnrichmentEventType =
  | "DEPLOYMENT"
  | "ROLLBACK"
  | "RESTART"
  | "FAILURE"
  | "RECOVERY"
  | "OUTAGE"
  | "CONFIG_CHANGE"
  | "MIGRATION"
  | "SCALING"
  | "ALERT"
  | "MITIGATION";

export interface ExtractedEvent {
  readonly type: EnrichmentEventType;
  readonly target?: string | undefined;
  readonly span?: EnrichmentSpan | undefined;
}

/**
 * Explicit, non-causal relationships only (temporal or associative).
 * This layer NEVER emits caused-by claims.
 */
export type EnrichmentRelation = "PRECEDES" | "ASSOCIATED_WITH_REDUCTION_IN" | "MODIFIES" | "AUTHORED_BY" | "MENTIONS";

export interface ExtractedRelationship {
  readonly from: string;
  readonly relation: EnrichmentRelation;
  readonly to: string;
}

/**
 * Deterministic NLP enrichment payload. Every list is deduplicated
 * (first-seen order); raw evidence is always preserved alongside it.
 */
export interface EvidenceEnrichment {
  readonly version: string;
  readonly entities: ExtractedEntity[];
  readonly services: string[];
  readonly endpoints: string[];
  readonly httpMethods: string[];
  readonly errors: ExtractedError[];
  readonly functions: string[];
  readonly classes: string[];
  readonly files: string[];
  readonly repositories: string[];
  readonly commits: string[];
  readonly pullRequests: number[];
  readonly deployments: Array<{ readonly reference: string | null; readonly label: string }>;
  readonly events: ExtractedEvent[];
  readonly relationships: ExtractedRelationship[];
  readonly keywords: string[];
  readonly classification: { readonly sourceType: string; readonly semantic: string[] };
  readonly processedAt: string;
}

/**
 * Canonical evidence contract shared by ALL investigation sources
 * (SLACK, GITHUB today; DATADOG/SENTRY/PAGERDUTY/KUBERNETES/AWS later).
 *
 * New canonical fields are OPTIONAL so rows persisted before this
 * milestone (reference + metadata only) still reconstitute unchanged.
 * `reference` remains the stable deduplication key and equals `sourceId`
 * for every item created through the canonical factories.
 */
export interface Evidence {
  readonly id: EvidenceId;
  readonly investigationId: InvestigationId;
  readonly source: EvidenceSource;
  readonly type: string;
  readonly reference: string;
  readonly collectedAt: Date;
  readonly metadata: Record<string, unknown>;
  readonly teamId?: string | undefined;
  readonly incidentId?: string | undefined;
  readonly title?: string | undefined;
  readonly content?: string | undefined;
  readonly searchableText?: string | undefined;
  readonly occurredAt?: Date | undefined;
  readonly provenance?: EvidenceProvenance | undefined;
  readonly sourceId?: string | undefined;
  readonly hash?: string | undefined;
  /**
   * Deterministic NLP enrichment (entities, errors, events, keywords,
   * classification). Derived metadata only — raw content/provenance are
   * never rewritten. Recomputed from scratch on every enrichment run,
   * so re-running never duplicates entities.
   */
  readonly enrichment?: EvidenceEnrichment | undefined;
}

/**
 * Metadata about how evidence was collected.
 * Used for audit trails and reproducibility.
 */
export interface EvidenceMetadata {
  readonly collectedBy: string;
  readonly collectionMethod: string;
  readonly rawPayload?: Record<string, unknown>;
  readonly tags?: string[];
}
