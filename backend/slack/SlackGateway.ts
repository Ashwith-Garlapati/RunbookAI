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
}

const MAX_ATTEMPTS = 3;
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

  constructor(private readonly _deduper: IDeliveryDeduper) {}

  /** Duplicate delivery guard. Returns false when already processed. */
  async acceptDelivery(teamId: TeamId, eventId: string, kind: string): Promise<boolean> {
    if (!eventId) return true;
    const first = await this._deduper.claimDelivery(teamId, eventId, kind);
    if (!first) {
      logger.info("SlackGateway", "DuplicateDeliverySkipped", { teamId, kind });
    }
    return first;
  }

  /** Enqueues background work; the Slack request must ACK immediately after. */
  enqueue(job: GatewayJob): void {
    this._queue.push({ job, attempt: 1 });
    void this.drain();
  }

  pendingCount(): number {
    return this._queue.length;
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
    } catch (error) {
      const retryAfterMs = isRateLimit(error);
      if (attempt < MAX_ATTEMPTS) {
        const delay = computeBackoff(attempt, retryAfterMs);
        logger.warn("SlackGateway", "JobRetry", { jobKey: job.key, attempt, delayMs: delay });
        await new Promise((r) => setTimeout(r, delay));
        await this.runWithRetry(job, attempt + 1);
        return;
      }
      logger.error("SlackGateway", "JobFailed", {
        jobKey: job.key,
        attempts: attempt,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
