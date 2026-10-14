/**
 * Evidence Enrichment - deterministic NLP over raw EvidenceItems.
 *
 * Pure regex/parser extraction, no LLM, no training, no Python service.
 * Raw content/provenance are never rewritten; enrichment is recomputed
 * from scratch on every run (idempotent) and persisted via the existing
 * IEvidenceRepository. Relationships are temporal/associative only —
 * this layer NEVER emits causal claims.
 */

import { EvidenceSource } from "../domains/investigation/EvidenceSource.js";
import type { EvidenceItem } from "../domains/investigation/EvidenceItem.js";
import type {
  EnrichmentEntityType,
  EnrichmentErrorKind,
  EnrichmentEventType,
  EvidenceEnrichment,
  ExtractedEntity,
  ExtractedError,
  ExtractedEvent,
  ExtractedRelationship,
} from "../domains/investigation/Evidence.js";
import type { IEvidenceRepository } from "../domains/investigation/RepositoryInterfaces.js";
import type { InvestigationId } from "../domains/investigation/types.js";
import { logger } from "../observability/logger.js";

export const ENRICHMENT_VERSION = "1";
const MAX_KEYWORDS = 50;

export interface EnrichmentContextInput {
  readonly services?: string[] | undefined;
  readonly repositories?: string[] | undefined;
  readonly endpoints?: string[] | undefined;
}

const INFRA_NOUNS = new Set([
  "redis", "postgres", "postgresql", "mysql", "mongo", "mongodb", "cassandra", "dynamodb",
  "sqlite", "kafka", "rabbitmq", "memcached", "elasticsearch", "nginx", "haproxy", "envoy",
  "consul", "vault", "kubernetes", "k8s", "docker", "aws", "gcp", "azure", "cloudwatch",
  "datadog", "sentry", "pagerduty", "prometheus", "grafana", "terraform", "jenkins",
  "dns", "tcp", "tls", "ssl", "grpc",
]);

const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "def", "class",
  "import", "require", "new", "typeof", "await", "yield",
]);

const STOPWORDS = new Set(
  "the,a,an,is,are,was,were,be,been,being,to,of,in,on,for,with,and,or,at,by,from,as,it,its,this,that,these,those,we,you,they,he,she,our,your,their,my,me,us,have,has,had,do,does,did,will,would,can,could,should,may,not,no,yes,if,then,than,so,but,also,just,now,here,there,when,where,what,which,who,how,why,all,any,more,most,some,such,only,very,into,over,after,before,up,down,out,about,between,during,while,per,via,etc,vs,am,pm,st,nd,rd,th".split(","),
);

/** Leading words that are determiners, not service names ("the service" is not a service). */
const SERVICE_NAME_DENY = new Set([
  "the", "a", "an", "this", "that", "these", "those", "our", "your", "their",
  "my", "its", "each", "every", "any", "some", "no", "other", "another", "same",
  "such", "what", "which",
]);

/** Hyphenated tokens made only of common English words are phrases, not services. */
const HYPHEN_COMMON_WORDS = new Set([
  "well", "known", "follow", "up", "end", "to", "upto", "up-to", "date", "by",
  "step", "one", "two", "first", "second", "high", "low", "long", "short",
  "real", "time", "on", "off", "in", "out", "over", "under", "again", "back",
]);

const CLASS_SUFFIXES = new Set([
  "service", "handler", "controller", "manager", "factory", "builder",
  "repository", "provider", "client", "exception", "error", "config",
  "helper", "util", "utils", "middleware", "interceptor", "listener",
]);

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

interface TextHit {
  value: string;
  full: string;
  start: number;
  end: number;
}

function findAll(text: string, pattern: RegExp): TextHit[] {
  const out: TextHit[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (const m of text.matchAll(re)) {
    const full = m[0] ?? "";
    const value = m[1] !== undefined ? String(m[1]) : full;
    const start = (m.index ?? 0) + (m[1] !== undefined ? full.indexOf(value) : 0);
    out.push({ value, full, start, end: start + value.length });
  }
  return out;
}

function pushEntity(
  entities: ExtractedEntity[],
  seen: Set<string>,
  value: string,
  type: EnrichmentEntityType,
  source: ExtractedEntity["source"],
  span?: { start: number; end: number },
): void {
  const key = `${type}:${value.toLowerCase()}`;
  if (seen.has(key) || !value) return;
  seen.add(key);
  entities.push({ value, type, source, ...(span ? { span: { start: span.start, end: span.end } } : {}) });
}

function toSpan(hit: { start: number; end: number }): { start: number; end: number } {
  return { start: hit.start, end: hit.end };
}

/** True when the text just before `start` ends with the given pattern. */
function precededBy(text: string, start: number, pattern: RegExp): boolean {
  return pattern.test(text.slice(Math.max(0, start - 8), start));
}

// ---------- text extractors ----------

function extractHttpStatuses(text: string, entities: ExtractedEntity[], seen: Set<string>, errors: ExtractedError[]): void {
  for (const hit of findAll(text, /\b([45]\d\d)s?\b/g)) {
    // PR numbers (#482) and incident IDs (INC-142) are identifiers, not statuses.
    if (precededBy(text, hit.start, /(?:PR\s*)?#\s*$/i) || precededBy(text, hit.start, /INC-\s*$/i)) continue;
    const code = hit.value.replace(/s$/, "");
    pushEntity(entities, seen, code, "HTTP_STATUS", "text", hit);
    errors.push({ value: `HTTP ${code}`, kind: "HTTP_STATUS", span: toSpan(hit) });
  }
}

function extractErrors(text: string, entities: ExtractedEntity[], seen: Set<string>, errors: ExtractedError[]): void {
  extractHttpStatuses(text, entities, seen, errors);
  for (const hit of findAll(text, /\b(timeouts?|tim(?:ed|ing)\s*out)\b/gi)) {
    pushEntity(entities, seen, "timeout", "ERROR", "text", hit);
    errors.push({ value: "timeout", kind: "TIMEOUT", span: toSpan(hit) });
  }
  for (const hit of findAll(text, /\b(E[A-Z]{3,}(?:_[A-Z]+)?|ECONN[A-Z]*|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/g)) {
    pushEntity(entities, seen, hit.value, "ERROR", "text", hit);
    errors.push({ value: hit.value, kind: hit.value.startsWith("ECONN") ? "CONNECTION" : "ERROR_CODE", span: toSpan(hit) });
  }
  const conn = /connection\s+(?:refused|reset|timed?\s*out|failed|closed)(?:\s+to\s+[a-z][\w-]*)?/gi;
  for (const hit of findAll(text, conn)) {
    const tech = /to\s+([a-z][\w-]*)\s*$/i.exec(hit.value)?.[1]?.toLowerCase();
    pushEntity(entities, seen, hit.value.toLowerCase(), "ERROR", "text", hit);
    errors.push({ value: hit.value.toLowerCase(), kind: "CONNECTION", ...(tech ? { technology: tech } : {}), span: toSpan(hit) });
  }
  for (const hit of findAll(text, /\b([A-Za-z_][\w.]*(?:Exception|Timeout|Failure))\b/g)) {
    if (hit.value.length <= 5 && !hit.value.includes(".")) continue;
    pushEntity(entities, seen, hit.value, "ERROR", "text", hit);
    errors.push({ value: hit.value, kind: "EXCEPTION", span: toSpan(hit) });
  }
  for (const hit of findAll(text, /\b(deadlock|slow query|replication lag|disk full|out of memory|OOM)\b/gi)) {
    const tech = /\b(postgres(?:ql)?|mysql|mongo(?:db)?|redis)\b/i.exec(text.slice(Math.max(0, hit.start - 60), hit.end + 40))?.[1]?.toLowerCase();
    pushEntity(entities, seen, hit.value.toLowerCase(), "ERROR", "text", hit);
    errors.push({ value: hit.value.toLowerCase(), kind: "DATABASE", ...(tech ? { technology: tech } : {}), span: toSpan(hit) });
  }
  if (/traceback\s*\(most recent call last\)|^\s*at\s+\S+\s*\(/im.test(text)) {
    errors.push({ value: "stack trace", kind: "EXCEPTION" });
  }
  for (const hit of findAll(text, /\b(?:error\s*code\s*[:#]?\s*|[A-Z]{2,10}[-_])(\d{2,6}|0x[0-9a-fA-F]+)\b|\b(0x[0-9a-fA-F]+)\b/g)) {
    // Incident IDs (INC-142) share the PREFIX-1234 shape — not error codes.
    if (/^INC-\d+$/i.test(hit.full)) continue;
    pushEntity(entities, seen, hit.value, "ERROR", "text", hit);
    errors.push({ value: hit.value, kind: "ERROR_CODE", span: toSpan(hit) });
  }
}

function extractServices(text: string, entities: ExtractedEntity[], seen: Set<string>, services: Set<string>): void {
  for (const hit of findAll(text, /\b([a-z0-9]+(?:-[a-z0-9]+)+)\b/g)) {
    const value = hit.value.toLowerCase();
    const parts = value.split("-");
    // Phrases built only from common English words ("well-known") are not services.
    if (parts.length > 0 && parts.every((p) => HYPHEN_COMMON_WORDS.has(p))) continue;
    pushEntity(entities, seen, value, "SERVICE", "text", hit);
    services.add(value);
  }
  for (const hit of findAll(text, /\b([A-Za-z][\w-]*)\s+service\b/gi)) {
    const raw = hit.value.replace(/\s+service$/i, "").toLowerCase();
    // Determiners are not service names ("the service" names nothing).
    if (SERVICE_NAME_DENY.has(raw) || STOPWORDS.has(raw)) continue;
    const value = `${raw}-service`;
    pushEntity(entities, seen, value, "SERVICE", "text", hit);
    services.add(value);
  }
  for (const hit of findAll(text, /\b([A-Za-z][\w-]*)\s+API\b/g)) {
    const raw = hit.value.replace(/\s+API$/, "").toLowerCase();
    // Determiners are not service names ("an API" names nothing).
    if (SERVICE_NAME_DENY.has(raw) || STOPWORDS.has(raw)) continue;
    const value = `${raw}-api`;
    pushEntity(entities, seen, value, "SERVICE", "text", hit);
    services.add(value);
  }
  for (const word of uniq((text.toLowerCase().match(/\b[a-z][a-z0-9_-]*\b/g) ?? []))) {
    if (INFRA_NOUNS.has(word)) pushEntity(entities, seen, word, "INFRA", "text");
  }
}

function extractEndpoints(text: string, entities: ExtractedEntity[], seen: Set<string>, endpoints: Set<string>): void {
  for (const hit of findAll(text, /(?:^|[\s("'])(\/[a-zA-Z0-9_\-{}.][a-zA-Z0-9_\-{}/.:]*)/g)) {
    const value = hit.value;
    if (!/[a-zA-Z]/.test(value)) continue;
    pushEntity(entities, seen, value, "ENDPOINT", "text", hit);
    endpoints.add(value);
  }
  for (const hit of findAll(text, /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) {
    pushEntity(entities, seen, hit.value, "HTTP_METHOD", "text", hit);
  }
}

function extractCodeEntities(text: string, entities: ExtractedEntity[], seen: Set<string>, out: { functions: Set<string>; classes: Set<string>; files: Set<string> }): void {
  for (const hit of findAll(text, /\b([A-Za-z_]\w*)\(\)/g)) {
    if (CALL_KEYWORDS.has(hit.value)) continue;
    pushEntity(entities, seen, hit.value, "FUNCTION", "text", hit);
    out.functions.add(hit.value);
  }
  for (const hit of findAll(text, /\b((?:[A-Za-z_]\w*)\.(?:[A-Za-z_]\w*))\s*\(/g)) {
    const full = hit.value;
    if (CALL_KEYWORDS.has(full.split(".")[0] as string)) continue;
    pushEntity(entities, seen, full, "FUNCTION", "text", hit);
    out.functions.add(full);
  }
  for (const hit of findAll(text, /\b([A-Z][A-Za-z0-9]+)\b/g)) {
    // All-caps abbreviations (PR, INC, API) are not classes.
    if (/^[A-Z0-9]+$/.test(hit.value)) continue;
    // Bare Titlecase words ("Meeting", "Checkout", "See") are prose, not classes.
    // A class signal needs an interior hump (PaymentService) or a component suffix.
    const hasHump = /[a-z][A-Z]/.test(hit.value);
    const suffixMatch = /([A-Z][a-z]+)$/.exec(hit.value)?.[1]?.toLowerCase();
    if (!hasHump && (!suffixMatch || !CLASS_SUFFIXES.has(suffixMatch))) continue;
    pushEntity(entities, seen, hit.value, "CLASS", "text", hit);
    out.classes.add(hit.value);
  }
  for (const hit of findAll(text, /(?:^|[\s("'`])((?:[\w.\-]+|\{[^{}]+\})\/[\w.\-/{}]+?\.[a-zA-Z0-9]{1,5})\b/g)) {
    pushEntity(entities, seen, hit.value, "FILE", "text", hit);
    out.files.add(hit.value);
  }
  for (const hit of findAll(text, /\b([\w-]+\.(?:ts|tsx|js|jsx|py|go|java|rb|yaml|yml|json|toml|md|sql|sh))\b/g)) {
    pushEntity(entities, seen, hit.value, "FILE", "text", hit);
    out.files.add(hit.value);
  }
}

function extractReposCommits(text: string, entities: ExtractedEntity[], seen: Set<string>, out: { repositories: Set<string>; commits: Set<string>; pullRequests: Set<number> }): void {
  const deny = new Set(["and", "or", "the", "for", "with", "from", "w", "a", "of", "to", "in", "on"]);
  for (const hit of findAll(text, /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/g)) {
    const [owner, name] = hit.value.split("/");
    if (!owner || !name || owner.length < 3 || name.length < 3) continue;
    if (deny.has(owner.toLowerCase()) || deny.has(name.toLowerCase())) continue;
    pushEntity(entities, seen, hit.value, "REPOSITORY", "text", hit);
    out.repositories.add(hit.value);
  }
  for (const hit of findAll(text, /\b([0-9a-f]{7,40})\b/g)) {
    // Genuine SHAs mix digits and hex letters; plain decimal numbers are not commits.
    if (!/\d/.test(hit.value) || !/[a-f]/.test(hit.value)) continue;
    pushEntity(entities, seen, hit.value, "COMMIT", "text", hit);
    out.commits.add(hit.value);
  }
  for (const hit of findAll(text, /(?:^|\s)#(\d{1,6})\b|\bPR\s+#?(\d{1,6})|\bpull\s+request\s+#?(\d{1,6})/gi)) {
    const n = Number(hit.value.replace(/\D/g, ""));
    if (!Number.isFinite(n)) continue;
    const label = `#${n}`;
    const key = `PULL_REQUEST:${label}`;
    if (!seen.has(key)) {
      seen.add(key);
      entities.push({ value: label, type: "PULL_REQUEST", source: "text", span: { start: hit.start, end: hit.end } });
    }
    out.pullRequests.add(n);
  }
  for (const hit of findAll(text, /\bINC-(?:\d+)\b/gi)) {
    pushEntity(entities, seen, hit.value.toUpperCase(), "INCIDENT", "text", hit);
  }
}

interface DeploymentRef {
  reference: string | null;
  label: string;
}

function extractDeployments(text: string, entities: ExtractedEntity[], seen: Set<string>, out: DeploymentRef[]): void {
  const seenLabels = new Set(out.map((d) => d.label));
  const push = (reference: string | null, label: string, hit: { start: number; end: number }): void => {
    pushEntity(entities, seen, label, "DEPLOYMENT", "text", hit);
    // Same deployment mentioned twice is one deployment (no duplicate entities).
    if (!seenLabels.has(label)) {
      seenLabels.add(label);
      out.push({ reference, label });
    }
  };
  for (const hit of findAll(text, /\bdeployment\s+#?(?:\d+)\b|\bdeploy\s+#?(?:\d+)\b/gi)) {
    const n = /(\d+)\s*$/.exec(hit.value)?.[1] ?? "";
    push(n || null, `deployment ${n}`, hit);
  }
  for (const hit of findAll(text, /\brollback(?:\s+deployment)?\s+#?(?:\d+)\b/gi)) {
    const n = /(\d+)\s*$/.exec(hit.value)?.[1] ?? "";
    push(n || null, `rollback ${n}`, hit);
  }
}

const EVENT_PATTERNS: Array<{ type: ExtractedEvent["type"]; pattern: RegExp }> = [
  { type: "ROLLBACK", pattern: /\broll(?:ing)?\s*backs?\b|\brevert(?:ed|ing)?\b/i },
  { type: "DEPLOYMENT", pattern: /\bdeploys?\b|\bdeploy(?:ed|ing|ment)\b|\bship(?:ped|ping)?\b|\brelease(?:d)?\b/i },
  { type: "RESTART", pattern: /\brestart(?:ed|ing|s)?\b|\breboot(?:ed|ing)?\b/i },
  { type: "OUTAGE", pattern: /\boutage\b/i },
  // Bare "down" alone is not a failure signal ("scroll down"). It counts only
  // as a service-state predicate ("service is down", "API was down").
  { type: "FAILURE", pattern: /\bfail(?:ure|ed|ing|s)?\b|\b5\d\ds?\b|\bbroken\b|(?:\b(?:is|are|was|were|be|been|being|went|go|goes|going|gone|remains?|stays?|staying|service|api|server|site|app|cluster|system|db)\s+down\b)/i },
  { type: "RECOVERY", pattern: /\brecover(?:ed|ing|y)?\b|\bresolv(?:ed|ing)?\b|\bfix(?:ed|ing|es)?\b|\beasing\b|\bdropping\b/i },
  { type: "CONFIG_CHANGE", pattern: /\bconfig(?:uration)?(?:\s+change)?\b|\bfeature flag\b|\bflag flip\b/i },
  { type: "MIGRATION", pattern: /\bmigrat\w*\b/i },
  { type: "SCALING", pattern: /\bscal\w*\b|\bautoscal\w*\b/i },
  { type: "ALERT", pattern: /\balert(?:ed|ing|s)?\b|\bpaged?\b|\bpaging\b/i },
  { type: "MITIGATION", pattern: /\bmitigat\w*\b|\bworkaround\b/i },
];

function extractEvents(
  text: string,
  deployments: DeploymentRef[],
): Array<{ type: ExtractedEvent["type"]; target?: string; span: { start: number; end: number } }> {
  const events: Array<{ type: ExtractedEvent["type"]; target?: string; span: { start: number; end: number } }> = [];
  const deploymentTarget = deployments[0]?.label;
  for (const { type, pattern } of EVENT_PATTERNS) {
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const m of text.matchAll(global)) {
      const span = { start: m.index ?? 0, end: (m.index ?? 0) + (m[0] ?? "").length };
      if (type === "DEPLOYMENT" || type === "ROLLBACK") {
        events.push({ type, ...(deploymentTarget ? { target: deploymentTarget } : {}), span });
      } else {
        events.push({ type, span });
      }
    }
  }
  return events;
}

function extractRelationships(
  text: string,
  errors: ExtractedError[],
  deployments: DeploymentRef[],
): ExtractedRelationship[] {
  const relationships: ExtractedRelationship[] = [];
  const seen = new Set<string>();
  const add = (from: string, relation: ExtractedRelationship["relation"], to: string): void => {
    const key = `${from}|${relation}|${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    relationships.push({ from, relation, to });
  };
  const firstError = errors[0]?.value;
  // "X after deployment N" — temporal precedence, never causal.
  const afterDeployment = /\bafter\s+(deployment\s+#?\d+|rollback(?:\s+#?\d+)?)/i.exec(text);
  if (afterDeployment?.[1] && firstError) {
    add(afterDeployment[1].replace(/\s+/g, " ").trim(), "PRECEDES", firstError);
  }
  // "rollback ... reduced/dropping errors" — association with improvement.
  if (/\brollback\b/i.test(text) && /\breduc\w*|\bdrop\w*|\brecover\w*|\bresolv\w*|\beasing\b|\bimprov\w*|\bfix\w*\b/i.test(text) && firstError) {
    add("rollback", "ASSOCIATED_WITH_REDUCTION_IN", firstError);
  }
  return relationships;
}

function extractKeywords(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9_#/.][a-z0-9_#/.\-]*/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const clean = token.replace(/^[#/.]+|[/.]+$/g, "");
    if (clean.length < 2 || STOPWORDS.has(clean) || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

// ---------- classification ----------

const GITHUB_TYPE_MAP: Record<string, string> = {
  "github.pull_request": "PULL_REQUEST",
  "github.commit": "COMMIT",
  "github.pr_commit": "COMMIT",
  "github.pr_file": "CODE_CHANGE",
  "github.diff": "CODE_CHANGE",
  "github.file": "FILE",
  "github.check": "CHECK",
  "github.review": "REVIEW",
  "github.comment": "COMMENT",
  "github.repo_metadata": "STATUS_UPDATE",
};

function classify(text: string, source: string, type: string, events: ExtractedEvent["type"][], hasErrors: boolean): { sourceType: string; semantic: string[] } {
  const semantic = new Set<string>();
  if (source === EvidenceSource.Slack) {
    semantic.add(type === "THREAD_MESSAGE" ? "THREAD_MESSAGE" : "MESSAGE");
    if (/\?/.test(text)) semantic.add("QUESTION");
    if (/(^|\s)(update|status)[:\s]/i.test(text)) semantic.add("STATUS_UPDATE");
  } else if (source === EvidenceSource.GitHub) {
    semantic.add(GITHUB_TYPE_MAP[type] ?? "CHANGE_REFERENCE");
  } else {
    semantic.add("OBSERVATION");
  }
  if (hasErrors) semantic.add("ERROR");
  const eventTags: Record<string, string> = {
    DEPLOYMENT: "DEPLOYMENT",
    ROLLBACK: "ROLLBACK",
    MITIGATION: "MITIGATION",
    RECOVERY: "RECOVERY",
    FAILURE: "SYMPTOM",
    OUTAGE: "SYMPTOM",
    RESTART: "CHANGE_REFERENCE",
    CONFIG_CHANGE: "CHANGE_REFERENCE",
    MIGRATION: "CHANGE_REFERENCE",
    SCALING: "CHANGE_REFERENCE",
    ALERT: "SYMPTOM",
  };
  for (const event of events) {
    const tag = eventTags[event];
    if (tag) semantic.add(tag);
  }
  if (/(returning|getting|seeing|experiencing)\s+\d{3}|latency|timing out/i.test(text)) semantic.add("SYMPTOM");
  if (semantic.size === 1) semantic.add("OBSERVATION");
  return { sourceType: source === EvidenceSource.Slack ? (type === "THREAD_MESSAGE" ? "THREAD_MESSAGE" : "MESSAGE") : (GITHUB_TYPE_MAP[type] ?? type), semantic: [...semantic] };
}

// ---------- structured GitHub reuse ----------

function applyGitHubProvenance(
  provenance: Record<string, unknown> | undefined,
  entities: ExtractedEntity[],
  seen: Set<string>,
  out: {
    repositories: Set<string>;
    commits: Set<string>;
    pullRequests: Set<number>;
    files: Set<string>;
    relationships: ExtractedRelationship[];
  },
): void {
  if (!provenance) return;
  const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
  const repository = str(provenance["repository"]);
  if (repository) {
    pushEntity(entities, seen, repository, "REPOSITORY", "provenance");
    out.repositories.add(repository);
  }
  const prNumber = provenance["prNumber"];
  if (typeof prNumber === "number" && Number.isFinite(prNumber)) {
    pushEntity(entities, seen, `#${prNumber}`, "PULL_REQUEST", "provenance");
    out.pullRequests.add(prNumber);
  }
  const commitSha = str(provenance["commitSha"]);
  if (commitSha) {
    pushEntity(entities, seen, commitSha, "COMMIT", "provenance");
    out.commits.add(commitSha);
  }
  const filePath = str(provenance["filePath"]);
  if (filePath) {
    pushEntity(entities, seen, filePath, "FILE", "provenance");
    out.files.add(filePath);
    if (typeof prNumber === "number" && Number.isFinite(prNumber)) {
      out.relationships.push({ from: `PR #${prNumber}`, relation: "MODIFIES", to: filePath });
    }
  }
}

// ---------- main entry ----------

export function enrichEvidence(
  item: Pick<EvidenceItem, "source" | "type" | "content" | "searchableText" | "provenance">,
  context?: EnrichmentContextInput,
): EvidenceEnrichment {
  const text = item.content ?? item.searchableText ?? "";
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();
  const errors: ExtractedError[] = [];
  const services = new Set<string>();
  const endpoints = new Set<string>();
  const functions = new Set<string>();
  const classes = new Set<string>();
  const files = new Set<string>();
  const repositories = new Set<string>();
  const commits = new Set<string>();
  const pullRequests = new Set<number>();
  const deployments: DeploymentRef[] = [];
  const relationships: ExtractedRelationship[] = [];

  extractErrors(text, entities, seen, errors);
  extractServices(text, entities, seen, services);
  extractEndpoints(text, entities, seen, endpoints);
  extractCodeEntities(text, entities, seen, { functions, classes, files });
  extractReposCommits(text, entities, seen, { repositories, commits, pullRequests });
  extractDeployments(text, entities, seen, deployments);
  const events = extractEvents(text, deployments);
  relationships.push(...extractRelationships(text, errors, deployments));
  applyGitHubProvenance(item.provenance as Record<string, unknown> | undefined, entities, seen, {
    repositories,
    commits,
    pullRequests,
    files,
    relationships,
  });

  // Context annotation only — context values never create entities.
  if (context) {
    const known = new Set([
      ...(context.services ?? []).map((s) => `service:${s.toLowerCase()}`),
      ...(context.repositories ?? []).map((s) => `repository:${s.toLowerCase()}`),
      ...(context.endpoints ?? []).map((s) => `endpoint:${s.toLowerCase()}`),
    ]);
    const typeField: Record<string, string> = { SERVICE: "service", REPOSITORY: "repository", ENDPOINT: "endpoint" };
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i] as ExtractedEntity;
      const field = typeField[entity.type];
      if (field && known.has(`${field}:${entity.value.toLowerCase()}`)) {
        entities[i] = { ...entity, contextMatched: true };
      }
    }
  }

  const eventTypes = events.map((e) => e.type);
  const classification = classify(text, item.source, item.type, eventTypes, errors.length > 0);

  return {
    version: ENRICHMENT_VERSION,
    entities,
    services: [...services].sort(),
    endpoints: [...endpoints].sort(),
    httpMethods: entities.filter((e) => e.type === "HTTP_METHOD").map((e) => e.value),
    errors,
    functions: [...functions].sort(),
    classes: [...classes].sort(),
    files: [...files].sort(),
    repositories: [...repositories].sort(),
    commits: [...commits].sort(),
    pullRequests: [...pullRequests].sort((a, b) => a - b),
    deployments,
    events: events.map((e) => ({ type: e.type, ...(e.target ? { target: e.target } : {}), span: e.span })),
    relationships,
    keywords: extractKeywords(text),
    classification,
    processedAt: new Date().toISOString(),
  };
}

export class EvidenceEnrichmentService {
  enrichOne(item: EvidenceItem, context?: EnrichmentContextInput): EvidenceItem {
    return item.withEnrichment(enrichEvidence(item, context));
  }

  enrichMany(
    items: EvidenceItem[],
    context?: EnrichmentContextInput,
  ): { items: EvidenceItem[]; failed: Array<{ id: string; reason: string }> } {
    const enriched: EvidenceItem[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    for (const item of items) {
      try {
        enriched.push(item.withEnrichment(enrichEvidence(item, context)));
      } catch (error) {
        failed.push({ id: item.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { items: enriched, failed };
  }

  async enrichInvestigation(
    repository: IEvidenceRepository,
    investigationId: InvestigationId,
    context?: EnrichmentContextInput,
  ): Promise<{ enriched: number; failed: number }> {
    const items = await repository.findByInvestigationId(investigationId);
    let enriched = 0;
    let failed = 0;
    for (const item of items) {
      try {
        const updated = await repository.update(item.withEnrichment(enrichEvidence(item, context)));
        if (updated) {
          enriched += 1;
        } else {
          failed += 1;
          logger.warn("EvidenceEnrichment", "ItemMissing", { evidenceId: item.id });
        }
      } catch (error) {
        failed += 1;
        logger.warn("EvidenceEnrichment", "ItemFailed", {
          evidenceId: item.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.info("EvidenceEnrichment", "InvestigationEnriched", { investigationId, enriched, failed });
    return { enriched, failed };
  }
}
