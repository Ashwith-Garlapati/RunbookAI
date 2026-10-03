/**
 * GitHub - structured connector error diagnostics.
 *
 * Mirrors slackErrors.ts conventions: stable codes + safe fields only.
 * Tokens/headers are never captured — only status codes and safe messages.
 */

export type GitHubErrorCode =
  | "auth_failed"
  | "forbidden"
  | "repo_not_found"
  | "file_not_found"
  | "pr_not_found"
  | "rate_limited"
  | "unavailable"
  | "unsupported_file"
  | "payload_too_large"
  | "invalid_ref";

export class GitHubConnectorError extends Error {
  readonly code: GitHubErrorCode;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(code: GitHubErrorCode, message: string, opts?: { status?: number; retryAfterMs?: number }) {
    super(message);
    this.name = "GitHubConnectorError";
    this.code = code;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

interface Statusful {
  status?: unknown;
  response?: { status?: unknown; headers?: Record<string, unknown> };
  message?: unknown;
}

function readStatus(error: unknown): number | undefined {
  const e = error as Statusful;
  const direct = typeof e?.status === "number" ? e.status : undefined;
  if (direct !== undefined) return direct;
  const nested = (e?.response as { status?: unknown } | undefined)?.status;
  return typeof nested === "number" ? nested : undefined;
}

function readHeaders(error: unknown): Record<string, unknown> | undefined {
  return (error as { response?: { headers?: Record<string, unknown> } })?.response?.headers;
}

function headerValue(headers: Record<string, unknown>, name: string): unknown {
  const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function toNumber(value: unknown): number {
  return typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
}

function readRetryAfterMs(error: unknown): number | undefined {
  const headers = readHeaders(error);
  const raw = headers ? (headerValue(headers, "retry-after") as string | number | undefined) : undefined;
  const seconds = raw !== undefined ? toNumber(raw) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return (seconds as number) * 1000;
  return undefined;
}

/**
 * GitHub primary rate limiting answers 403 (not 429) with
 * x-ratelimit-remaining: 0. The wait is x-ratelimit-reset (epoch seconds).
 */
function readRateLimitResetMs(error: unknown): number | undefined {
  const headers = readHeaders(error);
  if (!headers) return undefined;
  const remaining = toNumber(headerValue(headers, "x-ratelimit-remaining"));
  const reset = toNumber(headerValue(headers, "x-ratelimit-reset"));
  if (remaining !== 0 || !Number.isFinite(reset)) return undefined;
  return Math.max(0, (reset as number) * 1000 - Date.now());
}

function safeMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    // Strip anything resembling a token from upstream messages.
    return error.message
      .replace(/ghp_[A-Za-z0-9]+/g, "[REDACTED]")
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .slice(0, 300);
  }
  return fallback;
}

/** Maps an Octokit/request failure to a stable connector error. Never throws. */
export function toGitHubError(error: unknown, context: string): GitHubConnectorError {
  if (error instanceof GitHubConnectorError) return error;
  const status = readStatus(error);
  const rateLimitResetMs = readRateLimitResetMs(error);
  const retryAfterMs = readRetryAfterMs(error) ?? rateLimitResetMs;
  const message = safeMessage(error, "GitHub request failed");
  // 403 without a rate-limit signal is a permission problem, not a limit.
  const looksLikeRateLimit =
    status === 429 ||
    rateLimitResetMs !== undefined ||
    (status === 403 && /rate limit|secondary rate|abuse/i.test(message));

  if (status === 401) return new GitHubConnectorError("auth_failed", `${context}: authentication failed`, { status });
  if (looksLikeRateLimit)
    return new GitHubConnectorError("rate_limited", `${context}: rate limited${retryAfterMs ? ` (retry after ${retryAfterMs}ms)` : ""}`, {
      ...(status !== undefined ? { status } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  if (status === 403) return new GitHubConnectorError("forbidden", `${context}: insufficient permission`, { status });
  if (status === 404) {
    if (/pull/i.test(context)) return new GitHubConnectorError("pr_not_found", `${context}: not found`, { status });
    return new GitHubConnectorError("repo_not_found", `${context}: not found`, { status });
  }
  if (status === 422) return new GitHubConnectorError("invalid_ref", `${context}: invalid ref — ${message}`, { status });
  if (status !== undefined && status >= 500)
    return new GitHubConnectorError("unavailable", `${context}: GitHub unavailable — ${message}`, { status });
  return new GitHubConnectorError("unavailable", `${context}: ${message}`, {
    ...(status !== undefined ? { status } : {}),
  });
}
