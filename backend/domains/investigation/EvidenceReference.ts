/**
 * Investigation Domain - Evidence Reference Value Object
 *
 * A lightweight reference to an evidence item, stored on the Investigation aggregate.
 * The Investigation does not own the full evidence data — it only holds references.
 * This keeps the aggregate root focused and avoids bloating the persistence model.
 */

import type { EvidenceId } from "./types.js";

export interface EvidenceReference {
  readonly evidenceId: EvidenceId;
  readonly label: string;
  readonly url?: string;
  readonly addedAt: Date;
}
