/**
 * GitHub Evidence - normalizer, deduplication ids, deterministic ranking.
 *
 * Pure functions only (no API calls, no LLM). Every record carries
 * provenance so future claims trace back to the GitHub object.
 */

import { createHash } from "node:crypto";

import { hashContent, parseRepository } from "./githubConnector.js";
import type {
  ChangedFileEvidence,
  CheckEvidence,
  CommentEvidence,
  CommitEvidence,
  GitHubEvidenceRecord,
  GitHubProvenance,
  InvestigationGitHubContext,
  PullRequestEvidence,
  RelevantFileCandidate,
  RepositoryFileEvidence,
  RepositoryMetadata,
  ReviewEvidence,
} from "./githubEvidenceTypes.js";

export const GITHUB_EVIDENCE_TYPES = {
  repoMetadata: "github.repo_metadata",
  commit: "github.commit",
  pullRequest: "github.pull_request",
  prCommit: "github.pr_commit",
  prFile: "github.pr_file",
  diff: "github.diff",
  file: "github.file",
  check: "github.check",
  review: "github.review",
  comment: "github.comment",
} as const;

function provenanceFor(fullName: string, partial: Partial<GitHubProvenance>): GitHubProvenance {
  const [owner] = fullName.split("/");
  return {
    owner: owner ?? "",
    repository: fullName,
    prNumber: partial.prNumber ?? null,
    commitSha: partial.commitSha ?? null,
    filePath: partial.filePath ?? null,
    url: partial.url ?? null,
    branchOrRef: partial.branchOrRef ?? null,
  };
}

function baseRecord(params: {
  incidentId: string | null;
  investigationId: string | null;
  type: string;
  content: string;
  searchableText: string;
  occurredAt: string | null;
  provenance: GitHubProvenance;
  metadata: Record<string, unknown>;
  sourceId: string;
}): GitHubEvidenceRecord {
  const hash = createHash("sha256").update(`${params.type}:${params.sourceId}:${params.content}`, "utf8").digest("hex");
  const id = `github:${params.type}:${hash.slice(0, 24)}`;
  return {
    id,
    incidentId: params.incidentId,
    investigationId: params.investigationId,
    source: "GITHUB",
    type: params.type,
    content: params.content,
    searchableText: params.searchableText,
    occurredAt: params.occurredAt,
    provenance: params.provenance,
    metadata: params.metadata,
    sourceId: params.sourceId,
    hash,
    createdAt: new Date().toISOString(),
  };
}

// ---------- stable dedupe ids ----------

export function commitSourceId(repository: string, sha: string): string {
  return `${repository}@${sha}`;
}

export function pullRequestSourceId(repository: string, prNumber: number): string {
  return `${repository}#${prNumber}`;
}

export function fileSnapshotSourceId(repository: string, path: string, sha: string): string {
  return `${repository}:${path}@${sha}`;
}

export function prFileSourceId(repository: string, prNumber: number, path: string): string {
  return `${repository}#${prNumber}:${path}`;
}

// ---------- normalizers (evidence only, never root-cause claims) ----------

export function normalizeRepositoryMetadata(
  meta: RepositoryMetadata,
  ids?: { incidentId?: string; investigationId?: string },
): GitHubEvidenceRecord {
  const provenance = provenanceFor(meta.fullName, { url: meta.url, branchOrRef: meta.defaultBranch });
  const content = `Repository ${meta.fullName}: ${meta.description ?? "no description"} (default branch ${meta.defaultBranch}).`;
  return baseRecord({
    incidentId: ids?.incidentId ?? null,
    investigationId: ids?.investigationId ?? null,
    type: GITHUB_EVIDENCE_TYPES.repoMetadata,
    content,
    searchableText: `${meta.fullName} ${meta.description ?? ""} ${meta.primaryLanguage ?? ""}`.trim(),
    occurredAt: meta.updatedAt,
    provenance,
    metadata: { ...meta },
    sourceId: meta.fullName,
  });
}

export function normalizeCommit(
  commit: CommitEvidence,
  ids?: { incidentId?: string; investigationId?: string; prNumber?: number },
): GitHubEvidenceRecord {
  const provenance = provenanceFor(commit.repository, {
    commitSha: commit.sha,
    url: commit.url,
    ...(ids?.prNumber !== undefined ? { prNumber: ids.prNumber } : {}),
  });
  const content = `Commit ${commit.sha.slice(0, 8)} in ${commit.repository}: ${commit.message.split("\n")[0] ?? ""}`;
  return baseRecord({
    incidentId: ids?.incidentId ?? null,
    investigationId: ids?.investigationId ?? null,
    type: ids?.prNumber !== undefined ? GITHUB_EVIDENCE_TYPES.prCommit : GITHUB_EVIDENCE_TYPES.commit,
    content,
    searchableText: `${commit.message} ${commit.author ?? ""}`,
    occurredAt: commit.committedAt ?? commit.authoredAt,
    provenance,
    metadata: { ...commit },
    sourceId: commitSourceId(commit.repository, commit.sha),
  });
}

export function normalizePullRequest(
  pr: PullRequestEvidence,
  ids?: { incidentId?: string; investigationId?: string },
): GitHubEvidenceRecord {
  const provenance = provenanceFor(pr.repository, { prNumber: pr.number, url: pr.url });
  const content = `PR #${pr.number} in ${pr.repository} modified ${pr.sourceBranch} → ${pr.targetBranch} (state ${pr.state}). Title: ${pr.title}`;
  return baseRecord({
    incidentId: ids?.incidentId ?? null,
    investigationId: ids?.investigationId ?? null,
    type: GITHUB_EVIDENCE_TYPES.pullRequest,
    content,
    searchableText: `${pr.title} ${pr.body ?? ""} ${pr.author ?? ""}`,
    occurredAt: pr.mergedAt ?? pr.closedAt ?? pr.updatedAt,
    provenance,
    metadata: { ...pr },
    sourceId: pullRequestSourceId(pr.repository, pr.number),
  });
}

export function normalizeChangedFile(
  file: ChangedFileEvidence,
  ids?: { incidentId?: string; investigationId?: string },
): GitHubEvidenceRecord {
  const provenance = provenanceFor(file.repository, {
    prNumber: file.prNumber,
    commitSha: file.commitSha,
    filePath: file.path,
  });
  const content = `File ${file.path} ${file.status} in ${file.repository}${file.prNumber ? ` (PR #${file.prNumber})` : ""}: +${file.additions}/-${file.deletions}.`;
  return baseRecord({
    incidentId: ids?.incidentId ?? null,
    investigationId: ids?.investigationId ?? null,
    type: GITHUB_EVIDENCE_TYPES.prFile,
    content,
    searchableText: `${file.path} ${file.previousPath ?? ""} ${file.patch ?? ""}`.slice(0, 4000),
    occurredAt: null,
    provenance,
    metadata: { ...file },
    sourceId:
      file.prNumber !== null && file.prNumber !== undefined
        ? prFileSourceId(file.repository, file.prNumber, file.path)
        : `${file.repository}:${file.path}@${file.commitSha ?? "unknown"}`,
  });
}

export function normalizeRepositoryFile(
  file: RepositoryFileEvidence,
  ids?: { incidentId?: string; investigationId?: string },
): GitHubEvidenceRecord {
  const provenance = provenanceFor(file.repository, {
    filePath: file.path,
    url: file.url,
    branchOrRef: file.ref,
    commitSha: file.commitSha,
  });
  const content =
    file.content !== null
      ? `File ${file.path} in ${file.repository}@${file.ref} (${file.size ?? 0} bytes).`
      : `File ${file.path} in ${file.repository}@${file.ref} metadata only (binary=${file.binary}, tooLarge=${file.tooLarge}).`;
  return baseRecord({
    incidentId: ids?.incidentId ?? null,
    investigationId: ids?.investigationId ?? null,
    type: GITHUB_EVIDENCE_TYPES.file,
    content,
    searchableText: file.content ?? `${file.path}`,
    occurredAt: null,
    provenance,
    metadata: { ...file, content: file.content?.slice(0, 8000) ?? null },
    sourceId: `${file.repository}:${file.path}@${file.ref}`,
  });
}

export function normalizeCheck(
  repository: string,
  commitSha: string,
  check: CheckEvidence,
  ids?: { incidentId?: string; investigationId?: string },
): GitHubEvidenceRecord {
  const provenance = provenanceFor(repository, { commitSha, url: check.url });
  return baseRecord({
    incidentId: ids?.incidentId ?? null,
    investigationId: ids?.investigationId ?? null,
    type: GITHUB_EVIDENCE_TYPES.check,
    content: `Check ${check.name} on ${commitSha.slice(0, 8)}: ${check.status}/${check.conclusion ?? "unknown"}.`,
    searchableText: `${check.name} ${check.status} ${check.conclusion ?? ""}`,
    occurredAt: null,
    provenance,
    metadata: { repository, commitSha, ...check },
    sourceId: `${repository}@${commitSha}:check:${check.name}`,
  });
}

export function normalizeReview(
  repository: string,
  prNumber: number,
  review: ReviewEvidence,
  ids?: { incidentId?: string; investigationId?: string },
): GitHubEvidenceRecord {
  const provenance = provenanceFor(repository, { prNumber, url: review.url });
  return baseRecord({
    incidentId: ids?.incidentId ?? null,
    investigationId: ids?.investigationId ?? null,
    type: GITHUB_EVIDENCE_TYPES.review,
    content: `Review by ${review.reviewer ?? "unknown"} on PR #${prNumber}: ${review.state}.`,
    searchableText: `${review.reviewer ?? ""} ${review.state}`,
    occurredAt: review.submittedAt,
    provenance,
    metadata: { repository, prNumber, ...review },
    sourceId: `${repository}#${prNumber}:review:${review.reviewer ?? "unknown"}:${review.submittedAt ?? "unknown"}`,
  });
}

export function normalizeComment(
  repository: string,
  prNumber: number,
  comment: CommentEvidence,
  ids?: { incidentId?: string; investigationId?: string },
): GitHubEvidenceRecord {
  const provenance = provenanceFor(repository, { prNumber, url: comment.url });
  return baseRecord({
    incidentId: ids?.incidentId ?? null,
    investigationId: ids?.investigationId ?? null,
    type: GITHUB_EVIDENCE_TYPES.comment,
    content: `Comment by ${comment.author ?? "unknown"} on PR #${prNumber}: ${(comment.body ?? "").slice(0, 200)}`,
    searchableText: comment.body ?? "",
    occurredAt: comment.createdAt,
    provenance,
    metadata: { repository, prNumber, ...comment },
    // url/createdAt disambiguate repeats: same author posting the same text
    // twice (e.g. template replies) must not collapse into one ID.
    sourceId: `${repository}#${prNumber}:comment:${hashContent(
      `${comment.author ?? ""}:${comment.body ?? ""}:${comment.url ?? ""}:${comment.createdAt ?? ""}`,
    ).slice(0, 16)}`,
  });
}

// ---------- deterministic relevance ranking (no LLM) ----------

interface ScoredCandidate {
  path: string;
  repository: string;
  score: number;
  reasons: string[];
}

function addScore(entry: ScoredCandidate, delta: number, reason: string): void {
  entry.score = Math.min(1, entry.score + delta);
  entry.reasons.push(reason);
}

/**
 * Ranks file candidates from structured signals only:
 * changed-in-PR/commits, incident terms, mentioned names, import edges.
 */
export function rankRelevantFiles(params: {
  repository: string;
  changedPaths: Array<{ path: string; prNumber?: number; recentCommit?: boolean; committedAt?: string | null }>;
  treePaths?: string[] | undefined;
  context: InvestigationGitHubContext;
  imports?: Array<{ from: string; to: string }>;
}): RelevantFileCandidate[] {
  const terms = [
    ...(params.context.service ? [params.context.service.toLowerCase()] : []),
    ...(params.context.endpoint ? [params.context.endpoint.toLowerCase()] : []),
    ...params.context.errorTerms.map((t) => t.toLowerCase()),
    ...params.context.mentionedFiles.map((t) => t.toLowerCase()),
    ...params.context.mentionedFunctions.map((t) => t.toLowerCase()),
  ].filter(Boolean);
  const mentioned = new Set(params.context.mentionedFiles.map((f) => f.toLowerCase()));
  const importTargets = new Map<string, string[]>();
  for (const edge of params.imports ?? []) {
    const list = importTargets.get(edge.to.toLowerCase()) ?? [];
    list.push(edge.from);
    importTargets.set(edge.to.toLowerCase(), list);
  }

  const byPath = new Map<string, ScoredCandidate>();
  const ensure = (path: string): ScoredCandidate => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const created: ScoredCandidate = { path, repository: params.repository, score: 0, reasons: [] };
    byPath.set(path, created);
    return created;
  };

  for (const changed of params.changedPaths) {
    const entry = ensure(changed.path);
    if (changed.prNumber !== undefined) addScore(entry, 0.4, `changed in PR #${changed.prNumber}`);
    if (changed.recentCommit) addScore(entry, 0.3, "modified near incident window");
  }
  for (const treePath of params.treePaths ?? []) ensure(treePath);

  for (const entry of byPath.values()) {
    const lower = entry.path.toLowerCase();
    for (const term of terms) {
      if (term.length >= 3 && lower.includes(term)) {
        addScore(entry, 0.1, `matches "${term}"`);
        break;
      }
    }
    if (mentioned.has(lower)) addScore(entry, 0.1, "mentioned in incident context");
    const importers = importTargets.get(lower);
    if (importers && importers.length > 0) {
      const first = importers[0] ?? "";
      addScore(entry, 0.1, `imported by ${first}`);
    }
  }

  return [...byPath.values()]
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1))
    .map((c) => ({ path: c.path, repository: c.repository, score: Math.round(c.score * 100) / 100, reasons: c.reasons }));
}

/** Validates "owner/repo" early so callers fail fast on bad input. */
export function requireRepository(input: string): string {
  return parseRepository(input).owner ? input : input;
}
