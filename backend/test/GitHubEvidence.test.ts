import { describe, it, expect, vi } from "vitest";

import { GitHubConnector, hashContent, parseRepository, type GitHubApi } from "../services/githubConnector.js";
import { GitHubConnectorError } from "../services/githubErrors.js";
import {
  commitSourceId,
  fileSnapshotSourceId,
  normalizeChangedFile,
  normalizeComment,
  normalizeCommit,
  normalizePullRequest,
  normalizeRepositoryFile,
  normalizeRepositoryMetadata,
  prFileSourceId,
  pullRequestSourceId,
  rankRelevantFiles,
} from "../services/githubEvidence.js";
import { GitHubEvidenceStore } from "../services/githubEvidenceStore.js";
import { collectGitHubEvidence } from "../services/githubInvestigationFlow.js";
import type { IEvidenceRepository } from "../domains/investigation/RepositoryInterfaces.js";
import type { CommitEvidence } from "../services/githubEvidenceTypes.js";

const REF = { owner: "company", repo: "payments-service" };
const FULL = "company/payments-service";

function commitPayload(sha: string, message = "fix: auth check"): Record<string, unknown> {
  return {
    sha,
    html_url: `https://github.com/${FULL}/commit/${sha}`,
    commit: {
      message,
      author: { name: "dev", email: "dev@x.test", date: "2026-09-30T14:21:00Z" },
      committer: { name: "dev", email: "dev@x.test", date: "2026-09-30T14:21:00Z" },
    },
    author: { login: "dev" },
    parents: [{ sha: "parent1" }],
  };
}

function prPayload(n: number, merged = true): Record<string, unknown> {
  return {
    number: n,
    title: "Fix checkout auth",
    body: "fixes 500s",
    user: { login: "dev" },
    state: merged ? "closed" : "open",
    draft: false,
    head: { ref: "fix/auth" },
    base: { ref: "main" },
    created_at: "2026-09-30T14:00:00Z",
    updated_at: "2026-09-30T14:22:00Z",
    closed_at: merged ? "2026-09-30T14:22:00Z" : null,
    merged_at: merged ? "2026-09-30T14:21:00Z" : null,
    merge_commit_sha: merged ? "abc123" : null,
    html_url: `https://github.com/${FULL}/pull/${n}`,
  };
}

function apiStub(overrides: Partial<GitHubApi> = {}): GitHubApi {
  return {
    repos: {
      get: async () => ({
        data: {
          id: 1,
          default_branch: "main",
          description: "payments",
          language: "TypeScript",
          html_url: `https://github.com/${FULL}`,
          private: true,
          archived: false,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-09-30T14:00:00Z",
        },
      }),
      getContent: async () => ({
        data: {
          type: "file",
          encoding: "base64",
          size: 11,
          sha: "filesha",
          html_url: `https://github.com/${FULL}/blob/main/src/a.ts`,
          content: Buffer.from("hello world").toString("base64"),
        },
      }),
      listCommits: async () => ({ data: [commitPayload("abc123")] }),
      getCommit: async () => ({ data: { ...commitPayload("abc123"), files: [] } }),
      compareCommits: async () => ({ data: { files: [] } }),
    },
    git: {
      getTree: async () => ({
        data: {
          sha: "treesha",
          truncated: false,
          tree: [
            { path: "src", type: "tree", sha: "t1" },
            { path: "src/auth/validateToken.ts", type: "blob", sha: "b1", size: 100 },
          ],
        },
      }),
    },
    pulls: {
      list: async () => ({ data: [prPayload(482)] }),
      get: async () => ({ data: prPayload(482) }),
      listCommits: async () => ({ data: [commitPayload("abc123")] }),
      listFiles: async () => ({
        data: [
          {
            filename: "src/auth/validateToken.ts",
            status: "modified",
            additions: 10,
            deletions: 2,
            changes: 12,
            sha: "f1",
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ],
      }),
      listReviews: async () => ({
        data: [{ user: { login: "rev" }, state: "APPROVED", submitted_at: "2026-09-30T14:20:00Z", html_url: "http://x" }],
      }),
      listReviewComments: async () => ({ data: [] }),
    },
    issues: {
      listComments: async () => ({
        data: [{ user: { login: "dev" }, body: "lgtm", created_at: "2026-09-30T14:19:00Z", html_url: "http://y" }],
      }),
    },
    checks: {
      listForRef: async () => ({
        data: { check_runs: [{ name: "ci", status: "completed", conclusion: "success", html_url: "http://z" }] },
      }),
    },
    ...overrides,
  };
}

function statusError(status: number, message = "boom"): Error {
  return Object.assign(new Error(message), { status });
}

describe("GitHub evidence retrieval", () => {
  it("retrieves + normalizes repository metadata with provenance", async () => {
    const c = new GitHubConnector(apiStub());
    const meta = await c.getRepositoryMetadata(REF);
    expect(meta.fullName).toBe(FULL);
    expect(meta.defaultBranch).toBe("main");
    const record = normalizeRepositoryMetadata(meta, { incidentId: "inc-1", investigationId: "inv-1" });
    expect(record.source).toBe("GITHUB");
    expect(record.provenance.repository).toBe(FULL);
    expect(record.sourceId).toBe(FULL);
    expect(record.searchableText).toContain(FULL);
  });

  it("retrieves tree structure without file contents", async () => {
    const c = new GitHubConnector(apiStub());
    const tree = await c.getRepositoryTree(REF, "main");
    expect(tree.entries.some((e) => e.type === "tree" && e.path === "src")).toBe(true);
    expect(tree.entries.some((e) => e.type === "blob")).toBe(true);
  });

  it("retrieves a single commit and recent commits in a window", async () => {
    const listCommits = vi.fn(async () => ({ data: [commitPayload("abc123")] }));
    const c = new GitHubConnector(apiStub({ repos: { ...apiStub().repos, listCommits } }));
    const single = await c.getCommit(REF, "abc123");
    expect(single.sha).toBe("abc123");
    expect(single.parentShas).toEqual(["parent1"]);
    const recent = await c.listRecentCommits(REF, { since: "2026-09-30T14:00:00Z", until: "2026-09-30T15:00:00Z" });
    expect(recent).toHaveLength(1);
    expect(listCommits).toHaveBeenCalled();
    const args = listCommits.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args["since"]).toBe("2026-09-30T14:00:00Z");
  });

  it("retrieves PRs and detects merged state", async () => {
    const c = new GitHubConnector(apiStub());
    const prs = await c.listPullRequests(REF, { state: "all" });
    expect(prs[0]?.state).toBe("merged");
    const one = await c.getPullRequest(REF, 482);
    const record = normalizePullRequest(one, { investigationId: "inv-1" });
    expect(record.sourceId).toBe(pullRequestSourceId(FULL, 482));
    expect(record.provenance.prNumber).toBe(482);
  });

  it("retrieves PR commits preserving the repo→PR→commit relationship", async () => {
    const c = new GitHubConnector(apiStub());
    const commits = await c.listPullRequestCommits(REF, 482);
    const record = normalizeCommit(commits[0] as CommitEvidence, {
      investigationId: "inv-1",
      prNumber: 482,
    });
    expect(record.sourceId).toBe(commitSourceId(FULL, "abc123"));
    expect(record.provenance.commitSha).toBe("abc123");
    expect(record.provenance.prNumber).toBe(482);
  });

  it("retrieves changed files incl. renamed/binary without assuming patches", async () => {
    const c = new GitHubConnector(
      apiStub({
        pulls: {
          ...apiStub().pulls,
          listFiles: async () => ({
            data: [
              { filename: "new.ts", status: "added", additions: 5, deletions: 0, changes: 5, sha: "s1", patch: "patch" },
              { filename: "old.ts", status: "removed", additions: 0, deletions: 3, changes: 3, sha: "s2" },
              { filename: "bin.png", status: "added", additions: 0, deletions: 0, changes: 0, sha: "s3" },
              { filename: "n.ts", status: "renamed", additions: 1, deletions: 1, changes: 2, sha: "s4", previous_filename: "o.ts", patch: "p" },
            ],
          }),
        },
      }),
    );
    const files = await c.listPullRequestFiles(REF, 1);
    expect(files).toHaveLength(4);
    expect(files.find((f) => f.path === "bin.png")?.patch).toBeNull();
    expect(files.find((f) => f.path === "n.ts")?.previousPath).toBe("o.ts");
    const record = normalizeChangedFile(files[0] as (typeof files)[number], { investigationId: "inv-1" });
    expect(record.sourceId).toBe(prFileSourceId(FULL, 1, "new.ts"));
  });

  it("bounds commit/PR diffs and flags truncation", async () => {
    const big = "x".repeat(10_000);
    const c = new GitHubConnector(apiStub(), { maxDiffBytes: 100, maxPayloadBytes: 200 });
    const diff = await c.getCommitDiff(REF, "abc123").catch(() => null);
    expect(diff).toBeDefined();
    const c2 = new GitHubConnector(
      apiStub({
        repos: {
          ...apiStub().repos,
          getCommit: async () => ({
            data: { ...commitPayload("abc123"), files: [{ filename: "big.ts", status: "modified", additions: 1, deletions: 1, changes: 2, sha: "s", patch: big }] },
          }),
        },
      }),
      { maxDiffBytes: 100, maxPayloadBytes: 50 },
    );
    const d2 = await c2.getCommitDiff(REF, "abc123");
    expect(d2.truncated).toBe(true);
    const pr = new GitHubConnector(apiStub());
    const prDiff = await pr.getPullRequestDiff(REF, 482);
    expect(prDiff.totalAdditions).toBe(10);
  });

  it("retrieves file contents and marks binary/directory safely", async () => {
    const c = new GitHubConnector(apiStub());
    const file = await c.getFileContents(REF, "src/a.ts", "main");
    expect(file.content).toBe("hello world");
    const dir = new GitHubConnector(apiStub({ repos: { ...apiStub().repos, getContent: async () => ({ data: [] }) } }));
    await expect(dir.getFileContents(REF, "src", "main")).rejects.toMatchObject({ code: "unsupported_file" });
    const nul = new GitHubConnector(
      apiStub({
        repos: {
          ...apiStub().repos,
          getContent: async () => ({
            data: { type: "file", encoding: "base64", size: 8, sha: "s", content: Buffer.from("a\0b").toString("base64") },
          }),
        },
      }),
    );
    const binary = await nul.getFileContents(REF, "a.bin", "main");
    expect(binary.binary).toBe(true);
    expect(binary.content).toBeNull();
  });

  it("keeps commitSha null on metadata-only paths (blob SHA is not a commit)", async () => {
    const nul = new GitHubConnector(
      apiStub({
        repos: {
          ...apiStub().repos,
          getContent: async () => ({
            data: { type: "file", encoding: "base64", size: 8, sha: "blobsha", content: Buffer.from("a\0b").toString("base64") },
          }),
        },
      }),
    );
    const binary = await nul.getFileContents(REF, "a.bin", "main");
    expect(binary.commitSha).toBeNull();
    expect(binary.sha).toBe("blobsha");
    const big = new GitHubConnector(
      apiStub({
        repos: {
          ...apiStub().repos,
          getContent: async () => ({ data: { type: "file", encoding: "base64", size: 999_999, sha: "blobsha", content: "eA==" } }),
        },
      }),
      { maxFileBytes: 10 },
    );
    const meta = await big.getFileContents(REF, "big.ts", "main");
    expect(meta.commitSha).toBeNull();
    expect(meta.sha).toBe("blobsha");
  });

  it("expires branch-ref file cache but keeps commit-SHA entries", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-30T15:00:00Z"));
      let calls = 0;
      const counting = apiStub({
        repos: {
          ...apiStub().repos,
          getContent: async () => {
            calls += 1;
            return {
              data: {
                type: "file",
                encoding: "base64",
                size: 11,
                sha: "filesha",
                content: Buffer.from("hello world").toString("base64"),
              },
            };
          },
        },
      });
      const c = new GitHubConnector(counting);
      await c.getFileContents(REF, "src/a.ts", "main");
      await c.getFileContents(REF, "src/a.ts", "main");
      expect(calls).toBe(1);
      vi.setSystemTime(new Date("2026-09-30T15:01:01Z"));
      await c.getFileContents(REF, "src/a.ts", "main");
      expect(calls).toBe(2);
      const sha = "a".repeat(40);
      await c.getFileContents(REF, "src/a.ts", sha);
      await c.getFileContents(REF, "src/a.ts", sha);
      vi.setSystemTime(new Date("2026-09-30T16:00:00Z"));
      await c.getFileContents(REF, "src/a.ts", sha);
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects oversized files and invalid repositories", async () => {
    const c = new GitHubConnector(
      apiStub({
        repos: {
          ...apiStub().repos,
          getContent: async () => ({ data: { type: "file", encoding: "base64", size: 999_999, sha: "s", content: "eA==" } }),
        },
      }),
      { maxFileBytes: 10 },
    );
    const meta = await c.getFileContents(REF, "big.ts", "main");
    expect(meta.tooLarge).toBe(true);
    expect(meta.content).toBeNull();
    expect(() => parseRepository("nope")).toThrowError(GitHubConnectorError);
  });

  it("ranks relevant files deterministically with reasons", () => {
    const a = rankRelevantFiles({
      repository: FULL,
      changedPaths: [{ path: "src/auth/validateToken.ts", prNumber: 482, recentCommit: true }],
      treePaths: ["src/auth/validateToken.ts", "README.md"],
      context: {
        repository: FULL,
        incidentStart: "2026-09-30T14:32:00Z",
        incidentEnd: null,
        service: "payments-service",
        endpoint: "/checkout",
        errorTerms: ["500", "authorization"],
        mentionedFiles: [],
        mentionedFunctions: ["validateToken"],
      },
      imports: [{ from: "src/checkout/service.ts", to: "src/auth/validateToken.ts" }],
    });
    expect(a[0]?.path).toBe("src/auth/validateToken.ts");
    expect(a[0]?.reasons.join(" ")).toMatch(/PR #482/);
    // Deterministic: same input, same order.
    const b = rankRelevantFiles({
      repository: FULL,
      changedPaths: [{ path: "src/auth/validateToken.ts", prNumber: 482, recentCommit: true }],
      treePaths: ["src/auth/validateToken.ts", "README.md"],
      context: {
        repository: FULL,
        incidentStart: "2026-09-30T14:32:00Z",
        incidentEnd: null,
        service: "payments-service",
        endpoint: "/checkout",
        errorTerms: ["500", "authorization"],
        mentionedFiles: [],
        mentionedFunctions: ["validateToken"],
      },
      imports: [{ from: "src/checkout/service.ts", to: "src/auth/validateToken.ts" }],
    });
    expect(b).toEqual(a);
  });

  it("deduplicates commits/PRs/files deterministically", async () => {
    const created: unknown[] = [];
    const repo: IEvidenceRepository = {
      create: async (e) => {
        created.push(e);
      },
      findById: async () => null,
      findByInvestigationId: async () => [],
    };
    const store = new GitHubEvidenceStore(repo);
    const commit: CommitEvidence = {
      sha: "abc123",
      repository: FULL,
      author: "dev",
      committer: "dev",
      message: "fix: auth check",
      authoredAt: "2026-09-30T14:21:00Z",
      committedAt: "2026-09-30T14:21:00Z",
      parentShas: ["parent1"],
      url: `https://github.com/${FULL}/commit/abc123`,
    };
    const normalized = normalizeCommit(commit, {
      investigationId: "inv-1",
    });
    const r1 = await store.saveAll("inv-1", [normalized, normalized]);
    expect(r1).toEqual({ stored: 1, skipped: 1 });
    expect(fileSnapshotSourceId(FULL, "a.ts", "abc123")).toBe(`${FULL}:a.ts@abc123`);
    expect(hashContent("x")).toHaveLength(64);
  });

  it("paginates multi-page commit lists", async () => {
    const listCommits = vi.fn(async (args: Record<string, unknown>) => ({
      data: args["page"] === 1 ? [commitPayload("a"), commitPayload("b")] : [],
    }));
    const c = new GitHubConnector(apiStub({ repos: { ...apiStub().repos, listCommits } }));
    const commits = await c.listRecentCommits(REF, { perPage: 2, maxPages: 3 });
    expect(commits).toHaveLength(2);
    expect(listCommits.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("maps auth/rate-limit/missing errors to stable codes", async () => {
    const failing = (status: number, headers?: Record<string, unknown>) => {
      const err = Object.assign(statusError(status), { response: { status, headers } });
      return new GitHubConnector(
        apiStub({
          repos: {
            ...apiStub().repos,
            get: async () => {
              throw err;
            },
          },
          pulls: {
            ...apiStub().pulls,
            get: async () => {
              throw err;
            },
          },
        }),
      );
    };
    await expect(failing(401).getRepositoryMetadata(REF)).rejects.toMatchObject({ code: "auth_failed" });
    await expect(failing(429, { "retry-after": "2" }).getRepositoryMetadata(REF)).rejects.toMatchObject({ code: "rate_limited" });
    const resetAt = Math.floor(Date.now() / 1000) + 120;
    await expect(
      failing(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) }).getRepositoryMetadata(REF),
    ).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: expect.any(Number) });
    await expect(failing(403).getRepositoryMetadata(REF)).rejects.toMatchObject({ code: "forbidden" });
    await expect(failing(403, { "x-ratelimit-remaining": "10" }).getRepositoryMetadata(REF)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(failing(404).getRepositoryMetadata(REF)).rejects.toMatchObject({ code: "repo_not_found" });
    await expect(failing(404).getPullRequest(REF, 999)).rejects.toMatchObject({ code: "pr_not_found" });
    const missingFile = new GitHubConnector(
      apiStub({ repos: { ...apiStub().repos, getContent: async () => { throw statusError(404); } } }),
    );
    await expect(missingFile.getFileContents(REF, "nope.ts", "main")).rejects.toMatchObject({ code: "file_not_found" });
  });

  it("gives repeated identical comments distinct ids", async () => {
    const first = normalizeComment(FULL, 482, {
      author: "dev",
      body: "approve",
      createdAt: "2026-09-30T14:19:00Z",
      url: "https://github.com/company/payments-service/pull/482#issuecomment-1",
    });
    const second = normalizeComment(FULL, 482, {
      author: "dev",
      body: "approve",
      createdAt: "2026-09-30T14:20:00Z",
      url: "https://github.com/company/payments-service/pull/482#issuecomment-2",
    });
    expect(first.sourceId).not.toBe(second.sourceId);
    expect(first.id).not.toBe(second.id);
    expect(first.provenance.prNumber).toBe(482);
  });

  it("filters PRs by instant across mixed timestamp offsets", async () => {
    const inWindow = { ...prPayload(1), merged_at: "2026-09-30T16:00:00+02:00", closed_at: "2026-09-30T16:00:00+02:00", updated_at: "2026-09-30T16:00:00+02:00" };
    const beforeWindow = { ...prPayload(2), merged_at: "2026-09-30T13:00:00Z", closed_at: "2026-09-30T13:00:00Z", updated_at: "2026-09-30T13:00:00Z" };
    const c = new GitHubConnector(
      apiStub({ pulls: { ...apiStub().pulls, list: async () => ({ data: [inWindow, beforeWindow] }) } }),
    );
    const { records } = await collectGitHubEvidence(
      c,
      {
        repository: FULL,
        incidentStart: "2026-09-30T14:00:00Z",
        incidentEnd: "2026-09-30T15:00:00Z",
        service: "payments-service",
        endpoint: "/checkout",
        errorTerms: [],
        mentionedFiles: [],
        mentionedFunctions: [],
      },
      { branch: "main", maxRelevantFiles: 0 },
    );
    const prs = records.filter((r) => r.type === "github.pull_request");
    expect(prs.map((r) => r.sourceId)).toContain(`${FULL}#1`);
    expect(prs.map((r) => r.sourceId)).not.toContain(`${FULL}#2`);
  });

  it("never claims root cause and keeps provenance on every record", async () => {
    const c = new GitHubConnector(apiStub());
    const { records, candidates } = await collectGitHubEvidence(
      c,
      {
        repository: FULL,
        incidentStart: "2026-09-30T14:00:00Z",
        incidentEnd: "2026-09-30T15:00:00Z",
        service: "payments-service",
        endpoint: "/checkout",
        errorTerms: ["500"],
        mentionedFiles: [],
        mentionedFunctions: [],
      },
      { branch: "main", maxRelevantFiles: 1, includeValidation: true },
    );
    expect(records.length).toBeGreaterThan(5);
    for (const r of records) {
      expect(r.provenance.repository).toBe(FULL);
      expect(r.content.toLowerCase()).not.toContain("root cause");
    }
    expect(candidates[0]?.path).toBe("src/auth/validateToken.ts");
  });
});
