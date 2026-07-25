/**
 * Investigation Domain - Investigation Repository Interface
 *
 * Defines the persistence contract for Investigation aggregates.
 * Implementations must handle serialization/deserialization without
 * leaking infrastructure details into the domain layer.
 *
 * The repository works with aggregate root instances, not raw data.
 * No MongoDB, SQL, or any other storage technology should be referenced here.
 */

import type { InvestigationId } from "./types.js";
import type { InvestigationStatus } from "./InvestigationStatus.js";
import type { Investigation } from "./Investigation.js";

export interface IInvestigationRepository {
  /** Persists a new investigation. */
  create(investigation: Investigation): Promise<Investigation>;

  /** Updates an existing investigation. */
  update(investigation: Investigation): Promise<Investigation>;

  /** Retrieves an investigation by its ID, or null if not found. */
  findById(id: InvestigationId): Promise<Investigation | null>;

  /** Retrieves all investigations with the given status. */
  findByStatus(status: InvestigationStatus): Promise<Investigation[]>;

  /** Retrieves all active investigations (not completed or archived). */
  findActive(): Promise<Investigation[]>;

  /** Retrieves all completed investigations. */
  findCompleted(): Promise<Investigation[]>;

  /** Permanently removes an investigation. */
  delete(id: InvestigationId): Promise<void>;
}
