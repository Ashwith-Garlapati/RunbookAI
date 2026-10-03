/**
 * Slack Evidence Collector - COMPLETE incident-channel collection.
 *
 * The incident channel is dedicated to the incident, so EVERY message and
 * EVERY thread reply is collected with NO keyword/relevance filtering.
 * Bot messages are skipped (loop prevention, not relevance filtering).
 *
 * Collection only; persistence lives in commonEvidenceStore.
 * Client is injected (narrow SlackHistoryClient); production resolves the
 * team client through the existing SlackClientProvider — no second client.
 */

import { EvidenceItem } from "../domains/investigation/EvidenceItem.js";
import { EvidenceSource } from "../domains/investigation/EvidenceSource.js";
import type { InvestigationId } from "../domains/investigation/types.js";
import type { SlackClientProvider } from "../slack/slackClientProvider.js";
import { logger } from "../observability/logger.js";
import {
  normalizeSlackMessage,
  toSlackEvidenceError,
  type NormalizedSlackMessage,
  type SlackHistoryClient,
  type SlackRawMessage,
} from "./slackEvidence.js";

export type CollectionState = "COMPLETE" | "PARTIAL" | "FAILED";

export interface CollectionStatus {
  readonly status: CollectionState;
  readonly collectedCount: number;
  readonly failedThreads: string[];
  readonly errors: string[];
}

export interface ChannelCollection {
  readonly items: EvidenceItem[];
  readonly status: CollectionStatus;
}

interface CollectorDeps {
  readonly clients: SlackClientProvider;
}

const HISTORY_PAGE_SIZE = 200;
const MAX_HISTORY_PAGES = 50;
const MAX_THREAD_PAGES = 20;
/** Permalink lookups run in a bounded pool — never one API call per message in series. */
const PERMALINK_CONCURRENCY = 5;

function isBotMessage(message: SlackRawMessage): boolean {
  return message.bot_id !== undefined && message.bot_id !== null;
}

/** Bounded parallel map preserving input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      results[index] = await fn(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class SlackEvidenceCollector {
  constructor(private readonly _deps: CollectorDeps) {}

  private async _client(teamId: string, override?: SlackHistoryClient): Promise<SlackHistoryClient> {
    if (override) return override;
    const client = await this._deps.clients.forTeam(teamId);
    return client as unknown as SlackHistoryClient;
  }

  private async _fetchPermalink(
    client: SlackHistoryClient,
    channelId: string,
    messageTs: string,
  ): Promise<string | null> {
    const result = await client.chat.getPermalink({ channel: channelId, message_ts: messageTs });
    return result.permalink ?? null;
  }

  private async _readAllPages(
    fetchPage: (cursor?: string) => Promise<{ messages?: SlackRawMessage[]; response_metadata?: { next_cursor?: string } }>,
    maxPages: number,
  ): Promise<SlackRawMessage[]> {
    const out: SlackRawMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await fetchPage(cursor);
      out.push(...(result.messages ?? []));
      const next = result.response_metadata?.next_cursor;
      if (!next) break;
      cursor = next;
    }
    return out;
  }

  private _toItem(params: {
    normalized: NormalizedSlackMessage;
    teamId: string;
    investigationId: InvestigationId;
    incidentId?: string | undefined;
  }): EvidenceItem {
    const { normalized } = params;
    return EvidenceItem.createCanonical({
      investigationId: params.investigationId,
      source: EvidenceSource.Slack,
      type: normalized.type,
      sourceId: normalized.sourceId,
      ...(params.teamId ? { teamId: params.teamId } : {}),
      ...(params.incidentId ? { incidentId: params.incidentId } : {}),
      content: normalized.content,
      searchableText: normalized.content,
      ...(normalized.occurredAt ? { occurredAt: normalized.occurredAt } : {}),
      provenance: { ...normalized.provenance },
      metadata: {
        hasAttachments: normalized.hasAttachments,
        attachments: normalized.attachmentMeta,
      },
    });
  }

  /**
   * Collects the COMPLETE history of the incident channel (identified by
   * incident.channelId — never searched, inferred, or guessed) plus every
   * thread reply. No message-level filtering is applied.
   */
  async collectChannelHistory(params: {
    teamId: string;
    channelId: string;
    investigationId: InvestigationId;
    incidentId?: string | undefined;
    includePermalinks?: boolean | undefined;
    client?: SlackHistoryClient | undefined;
  }): Promise<ChannelCollection> {
    const start = Date.now();
    const includePermalinks = params.includePermalinks ?? true;
    let client: SlackHistoryClient;
    try {
      client = await this._client(params.teamId, params.client);
    } catch (error) {
      const mapped = toSlackEvidenceError(error, `collectChannelHistory ${params.channelId}`);
      return {
        items: [],
        status: { status: "FAILED", collectedCount: 0, failedThreads: [], errors: [mapped.message] },
      };
    }

    let parents: SlackRawMessage[];
    try {
      parents = await this._readAllPages(
        (cursor) =>
          client.conversations.history({
            channel: params.channelId,
            limit: HISTORY_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          }),
        MAX_HISTORY_PAGES,
      );
    } catch (error) {
      const mapped = toSlackEvidenceError(error, `collectChannelHistory ${params.channelId}`);
      logger.warn("SlackEvidence", "HistoryFailed", { channelId: params.channelId, reason: mapped.message, code: mapped.code });
      return {
        items: [],
        status: { status: "FAILED", collectedCount: 0, failedThreads: [], errors: [mapped.message] },
      };
    }

    const entries: Array<{ message: SlackRawMessage; defaultThreadTs?: string }> = [];
    const failedThreads: string[] = [];
    const errors: string[] = [];

    for (const parent of parents) {
      if (isBotMessage(parent)) continue;
      entries.push({ message: parent });

      if ((parent.reply_count ?? 0) > 0) {
        try {
          const thread = await this._readAllPages(
            (cursor) =>
              client.conversations.replies({
                channel: params.channelId,
                ts: parent.ts,
                limit: HISTORY_PAGE_SIZE,
                ...(cursor ? { cursor } : {}),
              }),
            MAX_THREAD_PAGES,
          );
          // replies() echoes the parent as the first entry — skip it (no duplicates).
          for (const reply of thread.slice(1)) {
            if (isBotMessage(reply)) continue;
            entries.push({ message: reply, defaultThreadTs: parent.ts });
          }
        } catch (error) {
          const mapped = toSlackEvidenceError(error, `collectThread ${params.channelId} ${parent.ts}`);
          failedThreads.push(parent.ts);
          errors.push(mapped.message);
        }
      }
    }

    // Permalink lookups run in a bounded pool (not one serial call per
    // message). Failures are reported, never silent: the evidence is kept
    // and the summary lands in errors[].
    let permalinkFailures = 0;
    const permalinks = includePermalinks
      ? await mapWithConcurrency(entries, PERMALINK_CONCURRENCY, async (entry) => {
          try {
            return await this._fetchPermalink(client, params.channelId, entry.message.ts);
          } catch {
            permalinkFailures += 1;
            return null;
          }
        })
      : entries.map(() => null);

    const items: EvidenceItem[] = entries.map((entry, index) => {
      const permalink = permalinks[index] ?? null;
      return this._toItem({
        normalized: normalizeSlackMessage({
          teamId: params.teamId,
          channelId: params.channelId,
          message: entry.message,
          ...(entry.defaultThreadTs ? { defaultThreadTs: entry.defaultThreadTs } : {}),
          ...(permalink ? { permalink } : {}),
        }),
        teamId: params.teamId,
        investigationId: params.investigationId,
        ...(params.incidentId ? { incidentId: params.incidentId } : {}),
      });
    });
    if (permalinkFailures > 0) {
      errors.push(
        `${permalinkFailures} permalink lookup(s) failed; evidence preserved without links`,
      );
    }

    const failed = failedThreads.length > 0;
    logger.info("SlackEvidence", "HistoryCollected", {
      channelId: params.channelId,
      durationMs: Date.now() - start,
      count: items.length,
      status: failed ? "PARTIAL" : "COMPLETE",
    });
    return {
      items,
      status: {
        status: failed ? "PARTIAL" : "COMPLETE",
        collectedCount: items.length,
        failedThreads,
        errors,
      },
    };
  }

  /**
   * Normalizes one live message for the active incident channel.
   * Returns null for bot messages (loop prevention) — never for relevance.
   * Scope filtering (incident channel only) is the caller's job.
   */
  async ingestLiveMessage(params: {
    teamId: string;
    channelId: string;
    message: SlackRawMessage;
    investigationId: InvestigationId;
    incidentId?: string | undefined;
    includePermalinks?: boolean | undefined;
    client?: SlackHistoryClient | undefined;
  }): Promise<EvidenceItem | null> {
    if (isBotMessage(params.message)) return null;
    let permalink: string | null = null;
    if (params.includePermalinks ?? true) {
      try {
        const client = await this._client(params.teamId, params.client);
        permalink = await this._fetchPermalink(client, params.channelId, params.message.ts);
      } catch (error) {
        logger.warn("SlackEvidence", "PermalinkFailed", {
          channelId: params.channelId,
          reason: error instanceof Error ? error.message : String(error),
        });
        permalink = null;
      }
    }
    return this._toItem({
      normalized: normalizeSlackMessage({
        teamId: params.teamId,
        channelId: params.channelId,
        message: params.message,
        ...(permalink ? { permalink } : {}),
      }),
      teamId: params.teamId,
      investigationId: params.investigationId,
      ...(params.incidentId ? { incidentId: params.incidentId } : {}),
    });
  }
}
