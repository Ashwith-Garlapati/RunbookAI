/**
 * Observability - structured logger with correlation IDs and secret redaction.
 *
 * All incident-coordination code must log through here, never console.log
 * with raw payloads. Secrets (tokens, URLs with credentials, headers) are
 * redacted before output.
 */

import { randomUUID } from "node:crypto";

const REDACT_KEYS = new Set([
  "token",
  "bot_token",
  "bottoken",
  "authorization",
  "cookie",
  "secret",
  "signing_secret",
  "client_secret",
  "api_key",
  "apikey",
  "response_url",
  "webhook_secret",
  "encryption_key",
  "password",
]);

export function newCorrelationId(): string {
  return randomUUID();
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Redact Slack tokens / bearer values embedded in strings.
    if (/(xox[bap]-|ghp_|Bearer |sk-)/.test(value)) return "[REDACTED]";
    return value.length > 2000 ? `${value.slice(0, 2000)}…[truncated]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LogFields {
  correlationId?: string;
  teamId?: string;
  incidentId?: string;
  userId?: string;
  [key: string]: unknown;
}

function emit(level: "info" | "warn" | "error", section: string, step: string, fields: LogFields = {}): void {
  const safe = redact(fields) as Record<string, unknown>;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    section,
    step,
    ...safe,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const logger = {
  info: (section: string, step: string, fields: LogFields = {}) => emit("info", section, step, fields),
  warn: (section: string, step: string, fields: LogFields = {}) => emit("warn", section, step, fields),
  error: (section: string, step: string, fields: LogFields = {}) => emit("error", section, step, fields),
};
