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
