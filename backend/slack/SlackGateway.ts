/**
 * Slack Gateway - reliable event processing boundary.
 *
 * Flow: Slack → verify (Bolt signing secret + timestamp replay window) →
 * normalize → idempotency claim (Slack event_id / action trigger id) →
 * ACK fast → background queue → worker (retry w/ exp backoff, 429-aware) →
 * IncidentCoordinator → Slack UI updates.
 *
 * Long-running work NEVER runs inside the Slack request handler.
 * Secrets are never logged (see observability/logger).
 */

import { newCorrelationId, logger } from "../observability/logger.js";
import type { TeamId } from "../domains/incident/types.js";

export interface NormalizedSlackEnvelope {
  readonly teamId: TeamId;
  readonly eventId: string;
  readonly kind: string;
  readonly userId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly threadTs: string | null;
  readonly text: string;
  readonly correlationId: string;
}

export interface IDeliveryDeduper {
  /** Returns true on first delivery, false on duplicate. */
  claimDelivery(teamId: TeamId, eventId: string, kind: string): Promise<boolean>;
}

export interface GatewayJob {
  readonly key: string;
  readonly run: () => Promise<void>;
  /**
   * Serializable form for crash-safe persistence. When a store is attached,
   * the descriptor is written before the first run and replayed on boot via
   * `dispatch`. Jobs without a descriptor stay in-process only.
   */
  readonly durable?: {
    readonly op: string;
    readonly teamId: string;
    readonly params: Record<string, unknown>;
  };
}

export interface GatewayStore {
  save(job: { key: string; op: string; teamId: string; params: Record<string, unknown> }): Promise<"accepted" | "duplicate">;
  complete(key: string): Promise<void>;
  reschedule(key: string, attempts: number, notBefore: Date, error: string): Promise<void>;
  failTerminal(key: string, attempts: number, error: string): Promise<void>;
  claimDue(now: Date, leaseMs: number): Promise<{
    key: string;
    op: string;
    teamId: string;
    params: Record<string, unknown>;
    attempts: number;
  } | null>;
}

export interface GatewayOptions {
  readonly store?: GatewayStore;
  readonly dispatch?: (job: {
    key: string;
    op: string;
    teamId: string;
    params: Record<string, unknown>;
  }) => Promise<void>;
  readonly maxAttempts?: number;
  readonly leaseMs?: number;
}

const MAX_ATTEMPTS = 3;
const LEASE_MS = 5 * 60_000;
const BASE_DELAY_MS = 1000;

function isRateLimit(error: unknown): number | null {
  const err = error as { code?: string; retryAfter?: number; status?: number; data?: { retry_after?: number } };
  const retryAfter =
    err?.retryAfter ?? err?.data?.retry_after ?? (typeof err?.code === "string" && err.code === "slack_rate_limited" ? 5 : null);
  if (err?.status === 429 || retryAfter !== null) return Number(retryAfter ?? 5) * 1000;
  return null;
}

export function computeBackoff(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return retryAfterMs;
  return BASE_DELAY_MS * 2 ** (attempt - 1);
}

/** Slack timestamp replay protection: rejects events older than 5 minutes. */
export function isFreshSlackTimestamp(tsSeconds: number, nowMs = Date.now()): boolean {
  const ageMs = nowMs - tsSeconds * 1000;
  return ageMs >= -30_000 && ageMs <= 5 * 60_000;
}

export function normalizeMention(params: {
  teamId: string;
  eventId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  threadTs?: string | null;
  text: string;
}): NormalizedSlackEnvelope {
  return {
    teamId: params.teamId,
    eventId: params.eventId,
    kind: "app_mention",
    userId: params.userId,
    channelId: params.channelId,
    messageTs: params.messageTs,
    threadTs: params.threadTs ?? null,
    text: params.text.slice(0, 4000),
    correlationId: newCorrelationId(),
  };
}

export class SlackGateway {
  private readonly _queue: Array<{ job: GatewayJob; attempt: number }> = [];
  private _draining = false;
  private readonly _store: GatewayStore | undefined;
  private readonly _dispatch: GatewayOptions["dispatch"] | undefined;
  private readonly _maxAttempts: number;
  private readonly _leaseMs: number;

  constructor(private readonly _deduper: IDeliveryDeduper, opts?: GatewayOptions) {
    this._store = opts?.store;
    this._dispatch = opts?.dispatch;
    this._maxAttempts = opts?.maxAttempts ?? MAX_ATTEMPTS;
    this._leaseMs = opts?.leaseMs ?? LEASE_MS;
  }

  /** Duplicate delivery guard. Returns false when already processed. */
  async acceptDelivery(teamId: TeamId, eventId: string, kind: string): Promise<boolean> {
    if (!eventId) return true;
    const first = await this._deduper.claimDelivery(teamId, eventId, kind);
    if (!first) {
      logger.info("SlackGateway", "DuplicateDeliverySkipped", { teamId, kind });
    }
    return first;
  }

  /**
   * Enqueues background work; the Slack request must ACK immediately after.
   * Durable jobs (with a descriptor + attached store) are persisted BEFORE
   * the first run, so a crash never loses them; boot recovery replays them.
   * A key that already completed is skipped without re-running.
   */
  async enqueue(job: GatewayJob): Promise<void> {
    if (job.durable && this._store) {
      try {
        const saved = await this._store.save({ key: job.key, ...job.durable });
        if (saved === "duplicate") {
          logger.info("SlackGateway", "DurableDuplicateSkipped", { jobKey: job.key });
          return;
        }
      } catch (error) {
        logger.error("SlackGateway", "DurableSaveFailed", {
          jobKey: job.key,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this._queue.push({ job, attempt: 1 });
    void this.drain();
  }

  pendingCount(): number {
    return this._queue.length;
  }

  /**
   * Boot recovery: claims every due persisted job and dispatches it.
   * At-least-once: replayed jobs rely on idempotency keys + state guards in
   * the job implementations to converge without duplicates.
   */
  async recover(): Promise<void> {
    if (!this._store || !this._dispatch) return;
    for (;;) {
      let claimed: Awaited<ReturnType<GatewayStore["claimDue"]>>;
      try {
        claimed = await this._store.claimDue(new Date(), this._leaseMs);
      } catch (error) {
        logger.error("SlackGateway", "RecoverClaimFailed", {
          reason: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (!claimed) return;
      logger.info("SlackGateway", "RecoverReplaying", { jobKey: claimed.key, op: claimed.op });
      try {
        await this._dispatch(claimed);
        await this._store.complete(claimed.key);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const attempts = claimed.attempts + 1;
        try {
          if (attempts < this._maxAttempts) {
            const delay = computeBackoff(attempts, isRateLimit(error));
            await this._store.reschedule(claimed.key, attempts, new Date(Date.now() + delay), reason);
          } else {
            await this._store.failTerminal(claimed.key, attempts, reason);
          }
        } catch (storeError) {
          logger.error("SlackGateway", "RecoverStoreFailed", {
            jobKey: claimed.key,
            reason: storeError instanceof Error ? storeError.message : String(storeError),
          });
        }
        logger.error("SlackGateway", "RecoverJobFailed", { jobKey: claimed.key, attempts, reason });
      }
    }
  }

  private async drain(): Promise<void> {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._queue.length > 0) {
        const item = this._queue.shift();
        if (!item) break;
        await this.runWithRetry(item.job, item.attempt);
      }
    } finally {
      this._draining = false;
    }
  }

  private async runWithRetry(job: GatewayJob, attempt: number): Promise<void> {
    try {
      await job.run();
      if (job.durable && this._store) {
        await this._store.complete(job.key).catch((error: unknown) => {
          logger.error("SlackGateway", "DurableCompleteFailed", {
            jobKey: job.key,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      const retryAfterMs = isRateLimit(error);
      if (attempt < this._maxAttempts) {
        const delay = computeBackoff(attempt, retryAfterMs);
        logger.warn("SlackGateway", "JobRetry", { jobKey: job.key, attempt, delayMs: delay });
        await new Promise((r) => setTimeout(r, delay));
        await this.runWithRetry(job, attempt + 1);
        return;
      }
      if (job.durable && this._store) {
        const reason = error instanceof Error ? error.message : String(error);
        await this._store
          .failTerminal(job.key, attempt, reason)
          .catch(() => undefined);
      }
      logger.error("SlackGateway", "JobFailed", {
        jobKey: job.key,
        attempts: attempt,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
