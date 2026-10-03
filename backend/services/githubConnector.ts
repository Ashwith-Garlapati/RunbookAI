/**
 * GitHub Connector - evidence retrieval ONLY (no LLM, no root-cause claims).
 *
 * Extends the existing GITHUB_TOKEN auth (githubPublisher.getSharedGitHubClient)
 * instead of creating a second client. Accepts an injected `GitHubApi`
 * so unit tests use fakes without a live account.
 */

import { createHash } from "node:crypto";

import { getSharedGitHubClient } from "./githubPublisher.js";
import { GitHubConnectorError, toGitHubError } from "./githubErrors.js";
import {
  DEFAULT_GITHUB_LIMITS,
  repositoryFullName,
  type ChangedFileEvidence,
  type ChangedFileStatus,
  type CheckEvidence,
  type CommentEvidence,
  type CommitEvidence,
  type DiffEvidence,
  type GitHubConnectorLimits,
  type PullRequestEvidence,
  type PullRequestState,
  type RepositoryFileEvidence,
  type RepositoryMetadata,
  type RepositoryRef,
  type RepositoryTree,
  type ReviewEvidence,
  type TreeEntry,
} from "./githubEvidenceTypes.js";
import { logger } from "../observability/logger.js";

/** Narrow API surface used by the connector (real Octokit satisfies this). */
export interface GitHubApi {
  repos: {
    get(args: { owner: string; repo: string }): Promise<{ data: Record<string, unknown> }>;
    getContent(args: { owner: string; repo: string; path: string; ref?: string }): Promise<{ data: unknown }>;
    listCommits(args: Record<string, unknown>): Promise<{ data: Array<Record<string, unknown>> }>;
    getCommit(args: { owner: string; repo: string; ref: string }): Promise<{ data: Record<string, unknown> }>;
    compareCommits(args: { owner: string; repo: string; base: string; head: string }): Promise<{ data: Record<string, unknown> }>;
  };
  git: {
    getTree(args: { owner: string; repo: string; tree_sha: string; recursive?: string }): Promise<{ data: Record<string, unknown> }>;
  };
  pulls: {
    list(args: Record<string, unknown>): Promise<{ data: Array<Record<string, unknown>> }>;
    get(args: { owner: string; repo: string; pull_number: number }): Promise<{ data: Record<string, unknown> }>;
    listCommits(args: Record<string, unknown>): Promise<{ data: Array<Record<string, unknown>> }>;
    listFiles(args: Record<string, unknown>): Promise<{ data: Array<Record<string, unknown>> }>;
    listReviews(args: Record<string, unknown>): Promise<{ data: Array<Record<string, unknown>> }>;
    listReviewComments(args: Record<string, unknown>): Promise<{ data: Array<Record<string, unknown>> }>;
  };
  issues: {
    listComments(args: Record<string, unknown>): Promise<{ data: Array<Record<string, unknown>> }>;
  };
  checks: {
    listForRef(args: Record<string, unknown>): Promise<{ data: Record<string, unknown> }>;
  };
}

export interface CommitQuery {
  branch?: string;
  since?: string;
  until?: string;
  author?: string;
  path?: string;
  perPage?: number;
  maxPages?: number;
}

export interface PullRequestQuery {
  state?: "open" | "closed" | "all";
  base?: string;
  perPage?: number;
  maxPages?: number;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

export function parseRepository(input: string): RepositoryRef {
  const [owner, repo] = input.split("/");
  if (!owner || !repo || input.split("/").length !== 2) {
    throw new GitHubConnectorError("invalid_ref", `Invalid repository "${input}" — expected "owner/repo"`);
  }
  return { owner, repo };
}

function toCommitEvidence(fullName: string, data: Record<string, unknown>): CommitEvidence {
  const commit = (data["commit"] as Record<string, unknown> | undefined) ?? {};
  const authorInfo = (commit["author"] as Record<string, unknown> | undefined) ?? {};
  const committerInfo = (commit["committer"] as Record<string, unknown> | undefined) ?? {};
  const ghAuthor = (data["author"] as Record<string, unknown> | undefined) ?? null;
  const parents = Array.isArray(data["parents"])
    ? (data["parents"] as Array<Record<string, unknown>>).map((p) => String(p["sha"] ?? "")).filter(Boolean)
    : [];
  return {
    sha: String(data["sha"] ?? ""),
    repository: fullName,
    author: str(ghAuthor?.["login"]) ?? str(authorInfo["name"]) ?? str(authorInfo["email"]),
    committer: str(committerInfo["name"]) ?? str(committerInfo["email"]),
    message: String(commit["message"] ?? ""),
    authoredAt: str(authorInfo["date"]),
    committedAt: str(committerInfo["date"]),
    parentShas: parents,
    url: str(data["html_url"]),
  };
}

function toPullRequestEvidence(fullName: string, data: Record<string, unknown>): PullRequestEvidence {
  const user = data["user"] as Record<string, unknown> | undefined;
  const head = (data["head"] as Record<string, unknown> | undefined) ?? {};
  const base = (data["base"] as Record<string, unknown> | undefined) ?? {};
  const mergedAt = str(data["merged_at"]);
  const closedAt = str(data["closed_at"]);
  const rawState = String(data["state"] ?? "open");
  const state: PullRequestState = mergedAt ? "merged" : rawState === "closed" || closedAt ? "closed" : "open";
  return {
    repository: fullName,
    number: num(data["number"], 0),
    title: String(data["title"] ?? ""),
    body: typeof data["body"] === "string" ? (data["body"] as string) : null,
    author: str(user?.["login"]),
    state,
    isDraft: data["draft"] === true,
    sourceBranch: String(head["ref"] ?? ""),
    targetBranch: String(base["ref"] ?? ""),
    createdAt: str(data["created_at"]),
    updatedAt: str(data["updated_at"]),
    closedAt,
    mergedAt,
    mergeCommitSha: str(data["merge_commit_sha"]),
    url: String(data["html_url"] ?? ""),
  };
}

function toChangedFileStatus(raw: unknown): ChangedFileStatus {
  switch (String(raw ?? "")) {
    case "added":
      return "added";
    case "modified":
      return "modified";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    default:
      return "other";
  }
}

/** Bounds a patch to maxBytes; marks truncation instead of silently cutting. */
function boundPatch(patch: string | null, maxBytes: number): { patch: string | null; truncated: boolean } {
  if (patch === null) return { patch: null, truncated: false };
  const bytes = Buffer.byteLength(patch, "utf8");
  if (bytes <= maxBytes) return { patch, truncated: false };
  // Cut on a byte-safe slice; patch stays valid UTF-8 for ASCII diffs.
  let cut = patch.slice(0, maxBytes);
  while (Buffer.byteLength(cut, "utf8") > maxBytes) cut = cut.slice(0, -1);
  return { patch: `${cut}\n…[truncated]`, truncated: true };
}

export class GitHubConnector {
  private readonly _api: GitHubApi;
  private readonly _limits: GitHubConnectorLimits;
  private readonly _cache = new Map<string, { at: number; value: unknown }>();
  private static readonly META_TTL_MS = 60_000;
  /** Branch/tag refs move — bound how long file contents may serve stale. */
  private static readonly FILE_TTL_MS = 60_000;

  constructor(api?: GitHubApi, limits?: Partial<GitHubConnectorLimits>) {
    this._api = api ?? (getSharedGitHubClient() as unknown as GitHubApi);
    this._limits = { ...DEFAULT_GITHUB_LIMITS, ...limits };
  }

  clearCache(): void {
    this._cache.clear();
  }

  private _getCached<T>(key: string, ttlMs?: number): T | undefined {
    const hit = this._cache.get(key);
    if (!hit) return undefined;
    if (ttlMs !== undefined && Date.now() - hit.at > ttlMs) {
      this._cache.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  private _setCached(key: string, value: unknown): void {
    if (this._cache.size > 500) this._cache.clear();
    this._cache.set(key, { at: Date.now(), value });
  }

  private async _timed<T>(operation: string, fields: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      const count = Array.isArray(result) ? result.length : 1;
      logger.info("GitHubConnector", operation, { ...fields, durationMs: Date.now() - start, count });
      return result;
    } catch (error) {
      const mapped = error instanceof GitHubConnectorError ? error : toGitHubError(error, operation);
      logger.warn("GitHubConnector", `${operation}Failed`, {
        ...fields,
        durationMs: Date.now() - start,
        reason: mapped.message,
        code: mapped.code,
      });
      throw mapped;
    }
  }

  private async _paginate(
    fetchPage: (page: number, perPage: number) => Promise<Array<Record<string, unknown>>>,
    perPage: number,
    maxPages: number,
  ): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= maxPages; page++) {
      const items = await fetchPage(page, perPage);
      out.push(...items);
      if (items.length < perPage) break;
      if (out.length >= this._limits.maxFilesPerRequest * maxPages) break;
    }
    return out;
  }

  // ---------- repository ----------

  async getRepositoryMetadata(ref: RepositoryRef): Promise<RepositoryMetadata> {
    const fullName = repositoryFullName(ref);
    const cached = this._getCached<RepositoryMetadata>(`meta:${fullName}`, GitHubConnector.META_TTL_MS);
    if (cached) {
      logger.info("GitHubConnector", "getRepositoryMetadata", { repository: fullName, cache: "hit" });
      return cached;
    }
    return this._timed("getRepositoryMetadata", { repository: fullName, cache: "miss" }, async () => {
      let data: Record<string, unknown>;
      try {
        ({ data } = await this._api.repos.get({ owner: ref.owner, repo: ref.repo }));
      } catch (error) {
        throw toGitHubError(error, `getRepositoryMetadata ${fullName}`);
      }
      const meta: RepositoryMetadata = {
        repositoryId: num(data["id"], 0),
        owner: ref.owner,
        name: ref.repo,
        fullName,
        defaultBranch: String(data["default_branch"] ?? "main"),
        description: typeof data["description"] === "string" ? (data["description"] as string) : null,
        primaryLanguage: str(data["language"]),
        url: String(data["html_url"] ?? `https://github.com/${fullName}`),
        isPrivate: data["private"] === true,
        archived: data["archived"] === true,
        createdAt: str(data["created_at"]),
        updatedAt: str(data["updated_at"]),
      };
      this._setCached(`meta:${fullName}`, meta);
      return meta;
    });
  }

  async getRepositoryTree(ref: RepositoryRef, branchOrSha: string, recursive = true): Promise<RepositoryTree> {
    const fullName = repositoryFullName(ref);
    const key = `tree:${fullName}:${branchOrSha}:${recursive ? "r" : "flat"}`;
    const cached = this._getCached<RepositoryTree>(key);
    if (cached) {
      logger.info("GitHubConnector", "getRepositoryTree", { repository: fullName, ref: branchOrSha, cache: "hit" });
      return cached;
    }
    return this._timed("getRepositoryTree", { repository: fullName, ref: branchOrSha, cache: "miss" }, async () => {
      let data: Record<string, unknown>;
      try {
        ({ data } = await this._api.git.getTree({
          owner: ref.owner,
          repo: ref.repo,
          tree_sha: branchOrSha,
          ...(recursive ? { recursive: "true" } : {}),
        }));
      } catch (error) {
        throw toGitHubError(error, `getRepositoryTree ${fullName}@${branchOrSha}`);
      }
      const rawEntries = asArray(data["tree"]);
      const entries: TreeEntry[] = rawEntries
        .filter((e) => typeof e["path"] === "string")
        .map((e) => {
          const entry: TreeEntry = {
            path: String(e["path"]),
            type: e["type"] === "tree" ? "tree" : "blob",
            sha: String(e["sha"] ?? ""),
            size: typeof e["size"] === "number" ? (e["size"] as number) : null,
          };
          return entry;
        });
      const tree: RepositoryTree = {
        repository: fullName,
        ref: branchOrSha,
        commitSha: str(data["sha"]),
        truncated: data["truncated"] === true,
        entries,
      };
      this._setCached(key, tree);
      return tree;
    });
  }

  // ---------- commits ----------

  async listRecentCommits(ref: RepositoryRef, query: CommitQuery = {}): Promise<CommitEvidence[]> {
    const fullName = repositoryFullName(ref);
    const perPage = query.perPage ?? this._limits.defaultPageSize;
    const maxPages = query.maxPages ?? this._limits.maxPages;
    return this._timed("listRecentCommits", { repository: fullName }, async () => {
      try {
        const items = await this._paginate(
          async (page, per_page) =>
            (
              await this._api.repos.listCommits({
                owner: ref.owner,
                repo: ref.repo,
                ...(query.branch ? { sha: query.branch } : {}),
                ...(query.since ? { since: query.since } : {}),
                ...(query.until ? { until: query.until } : {}),
                ...(query.author ? { author: query.author } : {}),
                ...(query.path ? { path: query.path } : {}),
                page,
                per_page,
              })
            ).data,
          perPage,
          maxPages,
        );
        return items.map((d) => toCommitEvidence(fullName, d));
      } catch (error) {
        throw toGitHubError(error, `listRecentCommits ${fullName}`);
      }
    });
  }

  async getCommit(ref: RepositoryRef, sha: string): Promise<CommitEvidence> {
    const fullName = repositoryFullName(ref);
    const cached = this._getCached<CommitEvidence>(`commit:${fullName}:${sha}`);
    if (cached) {
      logger.info("GitHubConnector", "getCommit", { repository: fullName, sha, cache: "hit" });
      return cached;
    }
    return this._timed("getCommit", { repository: fullName, sha, cache: "miss" }, async () => {
      try {
        const { data } = await this._api.repos.getCommit({ owner: ref.owner, repo: ref.repo, ref: sha });
        const evidence = toCommitEvidence(fullName, data);
        this._setCached(`commit:${fullName}:${sha}`, evidence);
        return evidence;
      } catch (error) {
        throw toGitHubError(error, `getCommit ${fullName}@${sha}`);
      }
    });
  }

  // ---------- pull requests ----------

  async listPullRequests(ref: RepositoryRef, query: PullRequestQuery = {}): Promise<PullRequestEvidence[]> {
    const fullName = repositoryFullName(ref);
    const perPage = query.perPage ?? this._limits.defaultPageSize;
    const maxPages = query.maxPages ?? this._limits.maxPages;
    return this._timed("listPullRequests", { repository: fullName }, async () => {
      try {
        const items = await this._paginate(
          async (page, per_page) =>
            (
              await this._api.pulls.list({
                owner: ref.owner,
                repo: ref.repo,
                state: query.state ?? "all",
                ...(query.base ? { base: query.base } : {}),
                sort: "updated",
                direction: "desc",
                page,
                per_page,
              })
            ).data,
          perPage,
          maxPages,
        );
        return items.map((d) => toPullRequestEvidence(fullName, d));
      } catch (error) {
        throw toGitHubError(error, `listPullRequests ${fullName}`);
      }
    });
  }

  async getPullRequest(ref: RepositoryRef, prNumber: number): Promise<PullRequestEvidence> {
    const fullName = repositoryFullName(ref);
    return this._timed("getPullRequest", { repository: fullName, prNumber }, async () => {
      try {
        const { data } = await this._api.pulls.get({ owner: ref.owner, repo: ref.repo, pull_number: prNumber });
        return toPullRequestEvidence(fullName, data);
      } catch (error) {
        throw toGitHubError(error, `pull ${fullName}#${prNumber}`);
      }
    });
  }

  async listPullRequestCommits(ref: RepositoryRef, prNumber: number): Promise<CommitEvidence[]> {
    const fullName = repositoryFullName(ref);
    return this._timed("listPullRequestCommits", { repository: fullName, prNumber }, async () => {
      try {
        const items = await this._paginate(
          async (page, per_page) =>
            (
              await this._api.pulls.listCommits({
                owner: ref.owner,
                repo: ref.repo,
                pull_number: prNumber,
                page,
                per_page,
              })
            ).data,
          this._limits.defaultPageSize,
          this._limits.maxPages,
        );
        return items.map((d) => toCommitEvidence(fullName, d));
      } catch (error) {
        throw toGitHubError(error, `pull ${fullName}#${prNumber} commits`);
      }
    });
  }

  async listPullRequestFiles(ref: RepositoryRef, prNumber: number): Promise<ChangedFileEvidence[]> {
    const fullName = repositoryFullName(ref);
    const cached = this._getCached<ChangedFileEvidence[]>(`prfiles:${fullName}#${prNumber}`);
    if (cached) {
      logger.info("GitHubConnector", "listPullRequestFiles", { repository: fullName, prNumber, cache: "hit" });
      return cached;
    }
    return this._timed("listPullRequestFiles", { repository: fullName, prNumber, cache: "miss" }, async () => {
      try {
        const items = await this._paginate(
          async (page, per_page) =>
            (
              await this._api.pulls.listFiles({
                owner: ref.owner,
                repo: ref.repo,
                pull_number: prNumber,
                page,
                per_page,
              })
            ).data,
          this._limits.defaultPageSize,
          this._limits.maxPages,
        );
        const files = items.slice(0, this._limits.maxFilesPerRequest).map((f) =>
          this._toChangedFile(fullName, f, prNumber, null),
        );
        this._setCached(`prfiles:${fullName}#${prNumber}`, files);
        return files;
      } catch (error) {
        throw toGitHubError(error, `pull ${fullName}#${prNumber} files`);
      }
    });
  }

  // ---------- diffs ----------

  private _toChangedFile(
    fullName: string,
    raw: Record<string, unknown>,
    prNumber: number | null,
    commitSha: string | null,
  ): ChangedFileEvidence {
    const rawPatch = typeof raw["patch"] === "string" ? (raw["patch"] as string) : null;
    const { patch, truncated } = boundPatch(rawPatch, this._limits.maxDiffBytes);
    return {
      repository: fullName,
      prNumber,
      commitSha,
      path: String(raw["filename"] ?? raw["path"] ?? ""),
      status: toChangedFileStatus(raw["status"]),
      additions: num(raw["additions"], 0),
      deletions: num(raw["deletions"], 0),
      changes: num(raw["changes"], 0),
      previousPath: str(raw["previous_filename"]),
      patch,
      sha: str(raw["sha"]),
      truncated,
    };
  }

  async getCommitDiff(ref: RepositoryRef, sha: string): Promise<DiffEvidence> {
    const fullName = repositoryFullName(ref);
    return this._timed("getCommitDiff", { repository: fullName, sha }, async () => {
      try {
        const { data } = await this._api.repos.getCommit({ owner: ref.owner, repo: ref.repo, ref: sha });
        const rawFiles = asArray(data["files"]).slice(0, this._limits.maxFilesPerRequest);
        const files = rawFiles.map((f) => this._toChangedFile(fullName, f, null, sha));
        return this._assembleDiff(fullName, files, sha, null);
      } catch (error) {
        throw toGitHubError(error, `getCommitDiff ${fullName}@${sha}`);
      }
    });
  }

  async getPullRequestDiff(ref: RepositoryRef, prNumber: number): Promise<DiffEvidence> {
    const files = await this.listPullRequestFiles(ref, prNumber);
    return this._assembleDiff(repositoryFullName(ref), files, null, prNumber);
  }

  private _assembleDiff(
    fullName: string,
    files: ChangedFileEvidence[],
    commitSha: string | null,
    prNumber: number | null,
  ): DiffEvidence {
    let bytes = 0;
    let truncated = false;
    const kept: ChangedFileEvidence[] = [];
    for (const f of files) {
      bytes += f.patch ? Buffer.byteLength(f.patch, "utf8") : 0;
      if (bytes > this._limits.maxPayloadBytes) {
        truncated = true;
        break;
      }
      kept.push(f);
      if (f.truncated) truncated = true;
    }
    return {
      repository: fullName,
      commitSha,
      prNumber,
      files: kept,
      totalAdditions: kept.reduce((n, f) => n + f.additions, 0),
      totalDeletions: kept.reduce((n, f) => n + f.deletions, 0),
      truncated,
    };
  }

  async compareCommits(ref: RepositoryRef, base: string, head: string): Promise<DiffEvidence> {
    const fullName = repositoryFullName(ref);
    return this._timed("compareCommits", { repository: fullName, base, head }, async () => {
      try {
        const { data } = await this._api.repos.compareCommits({ owner: ref.owner, repo: ref.repo, base, head });
        const rawFiles = asArray(data["files"]).slice(0, this._limits.maxFilesPerRequest);
        const files = rawFiles.map((f) => this._toChangedFile(fullName, f, null, String(head)));
        return this._assembleDiff(fullName, files, String(head), null);
      } catch (error) {
        throw toGitHubError(error, `compareCommits ${fullName} ${base}...${head}`);
      }
    });
  }

  // ---------- file contents ----------

  async getFileContents(ref: RepositoryRef, path: string, branchOrRef?: string): Promise<RepositoryFileEvidence> {
    const fullName = repositoryFullName(ref);
    const atRef = branchOrRef ?? "HEAD";
    const key = `file:${fullName}:${path}@${atRef}`;
    // Immutable commit SHAs never change; branch/tag/HEAD refs do — TTL those.
    const immutableRef = branchOrRef !== undefined && /^[0-9a-f]{40}$/i.test(branchOrRef);
    const cached = this._getCached<RepositoryFileEvidence>(
      key,
      immutableRef ? undefined : GitHubConnector.FILE_TTL_MS,
    );
    if (cached) {
      logger.info("GitHubConnector", "getFileContents", { repository: fullName, path, cache: "hit" });
      return cached;
    }
    return this._timed("getFileContents", { repository: fullName, path, cache: "miss" }, async () => {
      let data: unknown;
      try {
        ({ data } = await this._api.repos.getContent({
          owner: ref.owner,
          repo: ref.repo,
          path,
          ...(branchOrRef ? { ref: branchOrRef } : {}),
        }));
      } catch (error) {
        const mapped = toGitHubError(error, `getFileContents ${fullName}:${path}`);
        if (mapped.code === "repo_not_found") {
          throw new GitHubConnectorError("file_not_found", `getFileContents ${fullName}:${path}: not found`, {
            ...(mapped.status !== undefined ? { status: mapped.status } : {}),
          });
        }
        throw mapped;
      }
      if (Array.isArray(data)) {
        throw new GitHubConnectorError("unsupported_file", `getFileContents ${fullName}:${path} is a directory`);
      }
      const file = data as Record<string, unknown>;
      if (file["type"] !== "file") {
        throw new GitHubConnectorError("unsupported_file", `getFileContents ${fullName}:${path} is not a file`);
      }
      const size = num(file["size"], 0);
      const tooLarge = size > this._limits.maxFileBytes;
      const encoding = str(file["encoding"]);
      const base64 = typeof file["content"] === "string" ? (file["content"] as string) : null;
      // Binary heuristic: GitHub omits usable text or reports non-base64 blobs.
      const looksBinary = encoding !== null && encoding !== "base64" && encoding !== "none";
      if (tooLarge || base64 === null || looksBinary) {
        const meta: RepositoryFileEvidence = {
          repository: fullName,
          path,
          ref: atRef,
          // file["sha"] is the blob SHA, not a commit — never label it as one.
          commitSha: null,
          content: null,
          encoding: null,
          size,
          sha: str(file["sha"]),
          url: str(file["html_url"]),
          binary: looksBinary || /\.png|\.jpg|\.jpeg|\.gif|\.zip|\.pdf|\.woff2?$/i.test(path),
          tooLarge,
        };
        return meta;
      }
      let content: string;
      try {
        content = Buffer.from(base64.replace(/\n/g, ""), "base64").toString("utf8");
      } catch {
        throw new GitHubConnectorError("unsupported_file", `getFileContents ${fullName}:${path} could not be decoded`);
      }
      if (content.includes("\0")) {
        return {
          repository: fullName,
          path,
          ref: atRef,
          commitSha: null,
          content: null,
          encoding: null,
          size,
          sha: str(file["sha"]),
          url: str(file["html_url"]),
          binary: true,
          tooLarge: false,
        };
      }
      if (Buffer.byteLength(content, "utf8") > this._limits.maxPayloadBytes) {
        throw new GitHubConnectorError("payload_too_large", `getFileContents ${fullName}:${path} exceeds payload limit`);
      }
      const evidence: RepositoryFileEvidence = {
        repository: fullName,
        path,
        ref: atRef,
        commitSha: null,
        content,
        encoding: "utf8",
        size,
        sha: str(file["sha"]),
        url: str(file["html_url"]),
        binary: false,
        tooLarge: false,
      };
      this._setCached(key, evidence);
      return evidence;
    });
  }

  // ---------- PR validation ----------

  async getPullRequestChecks(ref: RepositoryRef, commitSha: string): Promise<CheckEvidence[]> {
    const fullName = repositoryFullName(ref);
    return this._timed("getPullRequestChecks", { repository: fullName, sha: commitSha }, async () => {
      try {
        const { data } = await this._api.checks.listForRef({ owner: ref.owner, repo: ref.repo, ref: commitSha });
        return asArray(data["check_runs"]).map((c) => ({
          name: String(c["name"] ?? ""),
          status: String(c["status"] ?? ""),
          conclusion: str(c["conclusion"]),
          url: str(c["html_url"]),
        }));
      } catch (error) {
        throw toGitHubError(error, `getPullRequestChecks ${fullName}@${commitSha}`);
      }
    });
  }

  async getPullRequestReviews(ref: RepositoryRef, prNumber: number): Promise<ReviewEvidence[]> {
    const fullName = repositoryFullName(ref);
    return this._timed("getPullRequestReviews", { repository: fullName, prNumber }, async () => {
      try {
        const items = await this._paginate(
          async (page, per_page) =>
            (
              await this._api.pulls.listReviews({
                owner: ref.owner,
                repo: ref.repo,
                pull_number: prNumber,
                page,
                per_page,
              })
            ).data,
          this._limits.defaultPageSize,
          this._limits.maxPages,
        );
        return items.map((r) => {
          const user = r["user"] as Record<string, unknown> | undefined;
          return {
            reviewer: str(user?.["login"]),
            state: String(r["state"] ?? ""),
            submittedAt: str(r["submitted_at"]),
            url: str(r["html_url"]),
          };
        });
      } catch (error) {
        throw toGitHubError(error, `pull ${fullName}#${prNumber} reviews`);
      }
    });
  }

  async getPullRequestComments(ref: RepositoryRef, prNumber: number): Promise<CommentEvidence[]> {
    const fullName = repositoryFullName(ref);
    return this._timed("getPullRequestComments", { repository: fullName, prNumber }, async () => {
      try {
        const [issueComments, reviewComments] = await Promise.all([
          this._paginate(
            async (page, per_page) =>
              (
                await this._api.issues.listComments({
                  owner: ref.owner,
                  repo: ref.repo,
                  issue_number: prNumber,
                  page,
                  per_page,
                })
              ).data,
            this._limits.defaultPageSize,
            this._limits.maxPages,
          ),
          this._paginate(
            async (page, per_page) =>
              (
                await this._api.pulls.listReviewComments({
                  owner: ref.owner,
                  repo: ref.repo,
                  pull_number: prNumber,
                  page,
                  per_page,
                })
              ).data,
            this._limits.defaultPageSize,
            this._limits.maxPages,
          ),
        ]);
        const toComment = (c: Record<string, unknown>): CommentEvidence => {
          const user = c["user"] as Record<string, unknown> | undefined;
          return {
            author: str(user?.["login"]),
            body: String(c["body"] ?? ""),
            createdAt: str(c["created_at"]),
            url: str(c["html_url"]),
          };
        };
        return [...issueComments.map(toComment), ...reviewComments.map(toComment)];
      } catch (error) {
        throw toGitHubError(error, `pull ${fullName}#${prNumber} comments`);
      }
    });
  }
}

/** Stable SHA-256 hash for evidence dedupe (stdlib). */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
