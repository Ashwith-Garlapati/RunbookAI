/**
 * Slack - structured API error diagnostics.
 *
 * Every incident-coordination Slack call logs failures with the ACTUAL Slack
 * error code (e.g. not_in_channel, channel_not_found, ratelimited) plus
 * safe routing fields. Tokens/secrets are never logged — only codes and IDs.
 */

export interface SlackErrorInfo {
  readonly method: string;
  readonly teamId?: string;
  readonly channelId?: string;
  readonly operation?: string;
  readonly slackError: string;
  readonly retryAfterMs?: number;
  readonly [key: string]: string | number | undefined;
}

/** Extracts the stable Slack error code (`data.error`) without secrets. */
export function slackErrorCode(error: unknown): string {
  const data = (error as { data?: { error?: unknown } })?.data;
  if (data && typeof data.error === "string" && data.error.length > 0) return data.error;
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 200);
  return "unknown";
}

/** Extracts `Retry-After` (seconds→ms) for ratelimited responses, if present. */
export function slackRetryAfterMs(error: unknown): number | undefined {
  const headers = (error as { headers?: Record<string, unknown> })?.headers;
  const raw = headers?.["retry-after"] ?? (error as { retryAfter?: unknown })?.retryAfter;
  const seconds = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const data = (error as { data?: { retry_after?: unknown } })?.data;
  if (typeof data?.retry_after === "number" && Number.isFinite(data.retry_after)) {
    return data.retry_after * 1000;
  }
  return undefined;
}

export function describeSlackError(
  method: string,
  error: unknown,
  extra?: { teamId?: string; channelId?: string; operation?: string },
): SlackErrorInfo {
  const info: SlackErrorInfo = {
    method,
    slackError: slackErrorCode(error),
    ...(extra?.teamId ? { teamId: extra.teamId } : {}),
    ...(extra?.channelId ? { channelId: extra.channelId } : {}),
    ...(extra?.operation ? { operation: extra.operation } : {}),
  };
  const retryAfterMs = slackRetryAfterMs(error);
  return retryAfterMs !== undefined ? { ...info, retryAfterMs } : info;
}
