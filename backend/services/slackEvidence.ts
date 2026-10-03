/**
 * Slack Evidence - types, errors, normalization (no API calls here).
 *
 * The incident channel is dedicated to the incident, so collection is
 * COMPLETE (no keyword/relevance filtering). NLP/RAG filter later.
 */

export type SlackEvidenceType = "MESSAGE" | "THREAD_MESSAGE";

export interface SlackProvenance {
  readonly channelId: string;
  readonly messageTs: string;
  readonly threadTs: string | null;
  readonly userId: string | null;
  readonly permalink: string | null;
}

export interface SlackMessageAttachment {
  readonly id: string | null;
  readonly name: string | null;
  readonly mimetype: string | null;
  readonly size: number | null;
  readonly url: string | null;
}

/** Raw Slack message shape (history/replies/event payloads). Never persisted raw. */
export interface SlackRawMessage {
  readonly ts: string;
  readonly thread_ts?: string | undefined;
  readonly user?: string | undefined;
  readonly bot_id?: string | undefined;
  readonly text?: string | undefined;
  readonly reply_count?: number | undefined;
  readonly files?: Array<Record<string, unknown>> | undefined;
  readonly attachments?: Array<Record<string, unknown>> | undefined;
}

/** Narrow client surface (real WebClient satisfies this). */
export interface SlackHistoryClient {
  conversations: {
    history(args: {
      channel: string;
      cursor?: string;
      limit?: number;
      oldest?: string;
    }): Promise<{ messages?: SlackRawMessage[]; response_metadata?: { next_cursor?: string } }>;
    replies(args: {
      channel: string;
      ts: string;
      cursor?: string;
      limit?: number;
    }): Promise<{ messages?: SlackRawMessage[]; response_metadata?: { next_cursor?: string } }>;
  };
  chat: {
    getPermalink(args: { channel: string; message_ts: string }): Promise<{ permalink?: string }>;
  };
}

export function slackParentSourceId(teamId: string, channelId: string, messageTs: string): string {
  return `slack:${teamId}:${channelId}:${messageTs}`;
}

export function slackReplySourceId(teamId: string, channelId: string, threadTs: string, messageTs: string): string {
  return `slack:${teamId}:${channelId}:${threadTs}:${messageTs}`;
}

/** Slack ts ("1727….000200") → Date. Returns null on malformed input. */
export function slackTsToDate(ts: string): Date | null {
  const seconds = Number(ts.split(".")[0]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

export type SlackEvidenceErrorCode =
  | "unauthorized"
  | "forbidden"
  | "channel_not_found"
  | "rate_limited"
  | "unavailable";

export class SlackEvidenceError extends Error {
  readonly code: SlackEvidenceErrorCode;
  readonly retryAfterMs: number | undefined;

  constructor(code: SlackEvidenceErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "SlackEvidenceError";
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** Maps Slack API failures to stable codes. Never captures tokens. */
export function toSlackEvidenceError(error: unknown, context: string): SlackEvidenceError {
  if (error instanceof SlackEvidenceError) return error;
  const data = (error as { data?: { error?: unknown } })?.data;
  const raw = typeof data?.error === "string" && data.error.length > 0 ? data.error : "";
  const code = (error as { code?: unknown })?.code;
  let message: string;
  if (error instanceof Error) {
    message = error.message.slice(0, 200);
  } else if (typeof error === "string") {
    message = error.slice(0, 200);
  } else {
    try {
      message = JSON.stringify(error).slice(0, 200);
    } catch {
      message = String(error).slice(0, 200);
    }
  }
  if (raw === "invalid_auth" || raw === "not_authed" || raw === "token_revoked" || raw === "account_inactive")
    return new SlackEvidenceError("unauthorized", `${context}: Slack authorization failed (${raw || "invalid_auth"})`);
  if (raw === "channel_not_found" || raw === "channel_not_exists")
    return new SlackEvidenceError("channel_not_found", `${context}: channel not found`);
  if (raw === "ratelimited" || code === "slack_rate_limited")
    return new SlackEvidenceError("rate_limited", `${context}: Slack rate limited`);
  if (raw === "missing_scope" || raw === "not_in_channel" || raw === "restricted_action")
    return new SlackEvidenceError("forbidden", `${context}: insufficient permission (${raw})`);
  if (/rate/i.test(message) && /limit/i.test(message)) return new SlackEvidenceError("rate_limited", `${context}: ${message}`);
  return new SlackEvidenceError("unavailable", `${context}: ${message || "Slack unavailable"}`);
}

function toAttachmentMeta(files: Array<Record<string, unknown>> | undefined): SlackMessageAttachment[] {
  if (!files) return [];
  return files.map((f) => ({
    id: typeof f["id"] === "string" ? (f["id"] as string) : null,
    name: typeof f["name"] === "string" ? (f["name"] as string) : null,
    mimetype: typeof f["mimetype"] === "string" ? (f["mimetype"] as string) : null,
    size: typeof f["size"] === "number" ? (f["size"] as number) : null,
    url: typeof f["url_private"] === "string" ? (f["url_private"] as string) : null,
  }));
}

export interface NormalizedSlackMessage {
  readonly type: SlackEvidenceType;
  readonly sourceId: string;
  readonly content: string;
  readonly occurredAt: Date | null;
  readonly provenance: SlackProvenance;
  readonly attachmentMeta: SlackMessageAttachment[];
  readonly hasAttachments: boolean;
}

/**
 * Normalizes WITHOUT rewriting: content is the original text verbatim.
 * Bot messages are skipped by the collector (loop prevention), not here.
 */
export function normalizeSlackMessage(params: {
  teamId: string;
  channelId: string;
  message: SlackRawMessage;
  defaultThreadTs?: string | undefined;
  permalink?: string | undefined;
}): NormalizedSlackMessage {
  const { teamId, channelId, message } = params;
  const threadTs = message.thread_ts ?? params.defaultThreadTs ?? null;
  const isReply = threadTs !== null && threadTs !== message.ts;
  return {
    type: isReply ? "THREAD_MESSAGE" : "MESSAGE",
    sourceId:
      isReply && threadTs
        ? slackReplySourceId(teamId, channelId, threadTs, message.ts)
        : slackParentSourceId(teamId, channelId, message.ts),
    content: message.text ?? "",
    occurredAt: slackTsToDate(message.ts),
    provenance: {
      channelId,
      messageTs: message.ts,
      threadTs,
      userId: message.user ?? null,
      permalink: params.permalink ?? null,
    },
    attachmentMeta: toAttachmentMeta(message.files),
    hasAttachments: Boolean((message.files?.length ?? 0) > 0 || (message.attachments?.length ?? 0) > 0),
  };
}
