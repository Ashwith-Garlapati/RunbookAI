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

  /**
   * Retrieves all investigations triggered from the given Slack channel,
   * most recent first. Used to link @RunbookAI mentions to existing
   * investigations in the same conversation.
   */
  findBySlackChannel(channelId: string): Promise<Investigation[]>;

  /**
   * Retrieves REUSABLE investigations (not Resolved / Completed / Archived)
   * associated with an exact Slack thread (teamId + channelId + threadTs),
   * most recent first. threadTs is "" for non-thread messages.
   */
  findReusableBySlackThread(
    teamId: string,
    channelId: string,
    threadTs: string,
  ): Promise<Investigation[]>;

  /**
   * Retrieves REUSABLE investigations associated with a Slack channel
   * (teamId + channelId), regardless of thread, most recent first.
   */
  findReusableBySlackChannel(teamId: string, channelId: string): Promise<Investigation[]>;

  /**
   * Retrieves REUSABLE investigations created by the same user within the
   * given team after a cut-off time, most recent first. Used for the
   * "same user within 30 minutes" association fallback.
   */
  findByReusableSlackUser(params: {
    teamId: string;
    createdBy: string;
    createdAfter: Date;
  }): Promise<Investigation[]>;

  /** Retrieves all completed investigations. */
  findCompleted(): Promise<Investigation[]>;

  /** Permanently removes an investigation. */
  delete(id: InvestigationId): Promise<void>;
}
