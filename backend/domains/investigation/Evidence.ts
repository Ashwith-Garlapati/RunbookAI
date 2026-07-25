/**
 * Investigation Domain - Evidence Interfaces (Placeholder)
 *
 * Defines the contracts for evidence that will be collected during an investigation.
 * These are interfaces only — actual evidence collectors are not yet implemented.
 *
 * The Investigation aggregate stores evidence as references (EvidenceReference).
 * These interfaces define the shape of evidence data that will be populated
 * by future collector integrations (Slack, GitHub, SigNoz, etc.).
 */

import type { EvidenceId, InvestigationId } from "./types.js";
import type { EvidenceSource } from "./EvidenceSource.js";

/**
 * Represents a single piece of evidence collected during an investigation.
 * Future collectors will populate instances of this interface.
 */
export interface Evidence {
  readonly id: EvidenceId;
  readonly investigationId: InvestigationId;
  readonly source: EvidenceSource;
  readonly type: string;
  readonly reference: string;
  readonly collectedAt: Date;
  readonly metadata: Record<string, unknown>;
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
