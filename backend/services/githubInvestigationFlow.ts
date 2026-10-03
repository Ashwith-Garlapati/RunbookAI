/**
 * GitHub Investigation Flow - reusable evidence-collection pipeline.
 *
 * Incident Context → commits → PRs → PR commits → changed files →
 * rank candidates → file contents → (checks/reviews/comments) → records.
 *
 * Each step is a separate exported helper so the future Investigation
 * Planner can call them individually. This module never claims root cause.
 */

import { GitHubConnector, parseRepository } from "./githubConnector.js";
import {
  normalizeChangedFile,
  normalizeCheck,
  normalizeComment,
  normalizeCommit,
  normalizePullRequest,
  normalizeRepositoryFile,
  normalizeRepositoryMetadata,
  normalizeReview,
  rankRelevantFiles,
} from "./githubEvidence.js";
import type {
  GitHubEvidenceRecord,
  InvestigationGitHubContext,
  RelevantFileCandidate,
} from "./githubEvidenceTypes.js";

export interface GitHubCollectionOptions {
  incidentId?: string;
  investigationId?: string;
  branch?: string;
  maxRelevantFiles?: number;
  includeValidation?: boolean;
}

export interface GitHubCollectionResult {
  records: GitHubEvidenceRecord[];
  candidates: RelevantFileCandidate[];
}

function windowFor(context: InvestigationGitHubContext): { since?: string; until?: string } {
  return {
    ...(context.incidentStart ? { since: context.incidentStart } : {}),
    ...(context.incidentEnd ? { until: context.incidentEnd } : {}),
  };
}

export async function collectRecentCommitEvidence(
  connector: GitHubConnector,
  context: InvestigationGitHubContext,
  options: GitHubCollectionOptions = {},
): Promise<GitHubEvidenceRecord[]> {
  const ref = parseRepository(context.repository);
  const window = windowFor(context);
  const commits = await connector.listRecentCommits(ref, {
    ...(options.branch ? { branch: options.branch } : {}),
    ...(window.since ? { since: window.since } : {}),
    ...(window.until ? { until: window.until } : {}),
  });
  return commits.map((c) =>
    normalizeCommit(c, {
      ...(options.incidentId ? { incidentId: options.incidentId } : {}),
      ...(options.investigationId ? { investigationId: options.investigationId } : {}),
    }),
  );
}

export async function collectGitHubEvidence(
  connector: GitHubConnector,
  context: InvestigationGitHubContext,
  options: GitHubCollectionOptions = {},
): Promise<GitHubCollectionResult> {
  const ref = parseRepository(context.repository);
  const ids = {
    ...(options.incidentId ? { incidentId: options.incidentId } : {}),
    ...(options.investigationId ? { investigationId: options.investigationId } : {}),
  };
  const records: GitHubEvidenceRecord[] = [];

  const metadata = await connector.getRepositoryMetadata(ref);
  records.push(normalizeRepositoryMetadata(metadata, ids));

  const window = windowFor(context);
  const commits = await connector.listRecentCommits(ref, {
    ...(options.branch ? { branch: options.branch } : {}),
    ...(window.since ? { since: window.since } : {}),
    ...(window.until ? { until: window.until } : {}),
  });
  records.push(...commits.map((c) => normalizeCommit(c, ids)));

  const prs = await connector.listPullRequests(ref, {
    ...(options.branch ? { base: options.branch } : {}),
  });
  // Narrow to PRs touching the incident window when timestamps exist.
  // Compared as instants (not strings) so mixed offsets sort correctly.
  // Unparseable stamps stay included, like missing ones.
  const relevantPrs = prs.filter((pr) => {
    if (!window.since && !window.until) return true;
    const stamp = pr.mergedAt ?? pr.closedAt ?? pr.updatedAt;
    if (!stamp) return true;
    const stampMs = Date.parse(stamp);
    if (window.since) {
      const sinceMs = Date.parse(window.since);
      if (!Number.isNaN(sinceMs) && !Number.isNaN(stampMs) && stampMs < sinceMs) return false;
    }
    if (window.until) {
      const untilMs = Date.parse(window.until);
      if (!Number.isNaN(untilMs) && !Number.isNaN(stampMs) && stampMs > untilMs) return false;
    }
    return true;
  });
  records.push(...relevantPrs.map((pr) => normalizePullRequest(pr, ids)));

  const changedPaths: Array<{ path: string; prNumber?: number; recentCommit?: boolean }> = [];
  for (const pr of relevantPrs.slice(0, 10)) {
    const prCommits = await connector.listPullRequestCommits(ref, pr.number);
    records.push(...prCommits.map((c) => normalizeCommit(c, { ...ids, prNumber: pr.number })));
    const files = await connector.listPullRequestFiles(ref, pr.number);
    records.push(...files.map((f) => normalizeChangedFile(f, ids)));
    for (const f of files) {
      changedPaths.push({ path: f.path, prNumber: pr.number, recentCommit: true });
    }
    if (options.includeValidation && pr.mergeCommitSha) {
      const [checks, reviews, comments] = await Promise.all([
        connector.getPullRequestChecks(ref, pr.mergeCommitSha),
        connector.getPullRequestReviews(ref, pr.number),
        connector.getPullRequestComments(ref, pr.number),
      ]);
      records.push(...checks.map((c) => normalizeCheck(context.repository, pr.mergeCommitSha as string, c, ids)));
      records.push(...reviews.map((r) => normalizeReview(context.repository, pr.number, r, ids)));
      records.push(...comments.map((c) => normalizeComment(context.repository, pr.number, c, ids)));
    }
  }

  const tree = await connector.getRepositoryTree(ref, options.branch ?? metadata.defaultBranch).catch(() => null);
  const candidates = rankRelevantFiles({
    repository: context.repository,
    changedPaths,
    treePaths: tree?.entries.filter((e) => e.type === "blob").map((e) => e.path).slice(0, 2000),
    context,
  });

  const top = candidates.slice(0, options.maxRelevantFiles ?? 5);
  for (const candidate of top) {
    const file = await connector
      .getFileContents(ref, candidate.path, options.branch ?? metadata.defaultBranch)
      .catch(() => null);
    if (file) records.push(normalizeRepositoryFile(file, ids));
  }

  return { records, candidates };
}
