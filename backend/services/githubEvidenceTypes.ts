/**
 * GitHub Evidence - normalized internal representations.
 *
 * Raw Octokit responses are NEVER passed to the investigation engine.
 * The connector returns these shapes; the normalizer wraps them into
 * GitHubEvidenceRecord (with provenance) for the Evidence Store.
 */

export interface RepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export function repositoryFullName(ref: RepositoryRef): string {
  return `${ref.owner}/${ref.repo}`;
}

export interface RepositoryMetadata {
  readonly repositoryId: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly description: string | null;
  readonly primaryLanguage: string | null;
  readonly url: string;
  readonly isPrivate: boolean;
  readonly archived: boolean;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export type TreeEntryType = "blob" | "tree";

export interface TreeEntry {
  readonly path: string;
  readonly type: TreeEntryType;
  readonly sha: string;
  readonly size: number | null;
}

export interface RepositoryTree {
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: string | null;
  readonly truncated: boolean;
  readonly entries: TreeEntry[];
}

export interface CommitEvidence {
  readonly sha: string;
  readonly repository: string;
  readonly author: string | null;
  readonly committer: string | null;
  readonly message: string;
  readonly authoredAt: string | null;
  readonly committedAt: string | null;
  readonly parentShas: string[];
  readonly url: string | null;
}

export type PullRequestState = "open" | "closed" | "merged";

export interface PullRequestEvidence {
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly author: string | null;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly closedAt: string | null;
  readonly mergedAt: string | null;
  readonly mergeCommitSha: string | null;
  readonly url: string;
}

export type ChangedFileStatus = "added" | "modified" | "removed" | "renamed" | "other";

export interface ChangedFileEvidence {
  readonly repository: string;
  readonly prNumber: number | null;
  readonly commitSha: string | null;
  readonly path: string;
  readonly status: ChangedFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly previousPath: string | null;
  /** Patch text when GitHub returned one; null for binary / patch-less files. */
  readonly patch: string | null;
  readonly sha: string | null;
  readonly truncated: boolean;
}

export interface DiffEvidence {
  readonly repository: string;
  readonly commitSha: string | null;
  readonly prNumber: number | null;
  readonly files: ChangedFileEvidence[];
  readonly totalAdditions: number;
  readonly totalDeletions: number;
  readonly truncated: boolean;
}

export interface RepositoryFileEvidence {
  readonly repository: string;
  readonly path: string;
  readonly ref: string;
  readonly commitSha: string | null;
  /** Decoded text; null when binary/unsupported/too-large (metadata only). */
  readonly content: string | null;
  readonly encoding: "utf8" | null;
  readonly size: number | null;
  readonly sha: string | null;
  readonly url: string | null;
  readonly binary: boolean;
  readonly tooLarge: boolean;
}

export interface CheckEvidence {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string | null;
}

export interface ReviewEvidence {
  readonly reviewer: string | null;
  readonly state: string;
  readonly submittedAt: string | null;
  readonly url: string | null;
}

export interface CommentEvidence {
  readonly author: string | null;
  readonly body: string;
  readonly createdAt: string | null;
  readonly url: string | null;
}

export interface InvestigationGitHubContext {
  readonly repository: string;
  readonly incidentStart: string | null;
  readonly incidentEnd: string | null;
  readonly service: string | null;
  readonly endpoint: string | null;
  readonly errorTerms: string[];
  readonly mentionedFiles: string[];
  readonly mentionedFunctions: string[];
}

export interface RelevantFileCandidate {
  readonly path: string;
  readonly repository: string;
  readonly score: number;
  readonly reasons: string[];
}

/** Provenance carried on every evidence record for future claim tracing. */
export interface GitHubProvenance {
  readonly owner: string;
  readonly repository: string;
  readonly prNumber: number | null;
  readonly commitSha: string | null;
  readonly filePath: string | null;
  readonly url: string | null;
  readonly branchOrRef: string | null;
}

/** Normalized evidence record — the only shape the future engine consumes. */
export interface GitHubEvidenceRecord {
  readonly id: string;
  readonly incidentId: string | null;
  readonly investigationId: string | null;
  readonly source: "GITHUB";
  readonly type: string;
  readonly content: string;
  /** Searchable text for the future RAG index. */
  readonly searchableText: string;
  readonly occurredAt: string | null;
  readonly provenance: GitHubProvenance;
  readonly metadata: Record<string, unknown>;
  readonly sourceId: string;
  readonly hash: string;
  readonly createdAt: string;
}

export interface GitHubConnectorLimits {
  readonly maxDiffBytes: number;
  readonly maxFilesPerRequest: number;
  readonly maxFileBytes: number;
  readonly maxPayloadBytes: number;
  readonly defaultPageSize: number;
  readonly maxPages: number;
}

export const DEFAULT_GITHUB_LIMITS: GitHubConnectorLimits = {
  maxDiffBytes: 256 * 1024,
  maxFilesPerRequest: 100,
  maxFileBytes: 256 * 1024,
  maxPayloadBytes: 1024 * 1024,
  defaultPageSize: 100,
  maxPages: 10,
};
