/**
 * Infrastructure - Mongo-backed durable job store.
 *
 * Lease-based claiming: workers atomically move one due job to `inflight`
 * with a lease expiry, so crashed workers' jobs become reclaimable without
 * a separate watchdog. `_id` uniqueness makes enqueue idempotent: a job key
 * that already reached `done` is never re-run.
 */

import { IncidentJobModel, type IncidentJobStatus } from "../models/IncidentOps.model.js";

export interface DurableDescriptor {
  readonly key: string;
  readonly op: string;
  readonly teamId: string;
  readonly params: Record<string, unknown>;
}

export interface ClaimedJob extends DurableDescriptor {
  attempts: number;
}

export interface IJobStore {
  /** Persists a job; returns "duplicate" when the key already completed. */
  save(job: DurableDescriptor): Promise<"accepted" | "duplicate">;
  complete(key: string): Promise<void>;
  reschedule(key: string, attempts: number, notBefore: Date, error: string): Promise<void>;
  failTerminal(key: string, attempts: number, error: string): Promise<void>;
  /** Atomically claims the oldest due job (pending, or inflight past lease). */
  claimDue(now: Date, leaseMs: number): Promise<ClaimedJob | null>;
}

export class MongoJobStore implements IJobStore {
  async save(job: DurableDescriptor): Promise<"accepted" | "duplicate"> {
    const existing = await IncidentJobModel.findById(job.key).lean();
    if (existing && (existing.status as IncidentJobStatus) === "done") {
      return "duplicate";
    }
    await IncidentJobModel.findByIdAndUpdate(
      job.key,
      {
        $set: {
          teamId: job.teamId,
          op: job.op,
          params: job.params,
          status: "inflight" satisfies IncidentJobStatus,
          leaseExpires: new Date(Date.now() + 5 * 60_000),
        },
        $setOnInsert: { attempts: 0, notBefore: new Date(), createdAt: new Date() },
      },
      { upsert: true },
    );
    return "accepted";
  }

  async complete(key: string): Promise<void> {
    await IncidentJobModel.findByIdAndUpdate(key, { $set: { status: "done" as IncidentJobStatus } });
  }

  async reschedule(key: string, attempts: number, notBefore: Date, error: string): Promise<void> {
    await IncidentJobModel.findByIdAndUpdate(key, {
      $set: {
        status: "pending" as IncidentJobStatus,
        attempts,
        notBefore,
        leaseExpires: null,
        error,
      },
    });
  }

  async failTerminal(key: string, attempts: number, error: string): Promise<void> {
    await IncidentJobModel.findByIdAndUpdate(key, {
      $set: { status: "failed" as IncidentJobStatus, attempts, error },
    });
  }

  async claimDue(now: Date, leaseMs: number): Promise<ClaimedJob | null> {
    const doc = await IncidentJobModel.findOneAndUpdate(
      {
        $or: [
          { status: "pending" as IncidentJobStatus, notBefore: { $lte: now } },
          { status: "inflight" as IncidentJobStatus, leaseExpires: { $lte: now } },
        ],
      },
      {
        $set: {
          status: "inflight" as IncidentJobStatus,
          leaseExpires: new Date(now.getTime() + leaseMs),
        },
      },
      { sort: { createdAt: 1 }, new: true },
    ).lean();
    if (!doc) return null;
    return {
      key: String(doc._id),
      op: String(doc.op),
      teamId: String(doc.teamId),
      params: (doc.params ?? {}) as Record<string, unknown>,
      attempts: Number(doc.attempts ?? 0),
    };
  }
}
