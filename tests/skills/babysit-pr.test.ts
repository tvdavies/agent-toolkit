import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const root = resolve(import.meta.dir, "../..");
const skillDir = join(root, "skills/general/babysit-pr");
const skillFile = join(skillDir, "SKILL.md");
const waiter = join(skillDir, "scripts/wait-for-pr-change.sh");
let temp = "";
let fakeBin = "";
let prState = "";
let threadState = "";
let commentPages = "";
let reviewPages = "";

function defaultPrState() {
  return {
    number: 7,
    url: "https://github.com/acme/widgets/pull/7",
    state: "OPEN",
    isDraft: false,
    mergedAt: null,
    closedAt: null,
    updatedAt: "2026-01-01T00:00:00Z",
    headRefOid: "abc123",
    headRefName: "fix-widget",
    headRepository: { name: "widgets", nameWithOwner: "acme/widgets" },
    headRepositoryOwner: { login: "acme" },
    isCrossRepository: false,
    baseRefName: "main",
    mergeable: "MERGEABLE",
    mergeStateStatus: "UNSTABLE",
    reviewDecision: "REVIEW_REQUIRED",
    statusCheckRollup: [
      { name: "unit", status: "IN_PROGRESS", conclusion: null, detailsUrl: "https://checks/1", startedAt: null, completedAt: null },
      { name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://checks/2", startedAt: null, completedAt: null },
    ],
    // Deliberately incomplete fields: the watcher must use paginated API endpoints instead.
    reviews: [{ author: { login: "truncated" }, state: "COMMENTED", body: "ignore", submittedAt: "2025-01-01T00:00:00Z" }],
    comments: [{ databaseId: 999, author: { login: "truncated" }, body: "ignore", createdAt: "2025-01-01T00:00:00Z" }],
  };
}

function defaultCommentPages() {
  return [
    [
      { id: 1, node_id: "comment-1", user: { login: "alice", type: "User" }, body: "first", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", html_url: "https://comments/1" },
    ],
    [
      { id: 2, node_id: "comment-2", user: { login: "bob", type: "User" }, body: "second page", created_at: "2026-01-01T01:00:00Z", updated_at: "2026-01-01T01:00:00Z", html_url: "https://comments/2" },
    ],
  ];
}

function defaultReviewPages() {
  return [
    [
      { id: 21, node_id: "review-1", user: { login: "alice", type: "User" }, state: "APPROVED", body: "ok", submitted_at: "2026-01-01T01:00:00Z", commit_id: "abc123", html_url: "https://reviews/1" },
    ],
    [
      { id: 22, node_id: "review-2", user: { login: "bob", type: "User" }, state: "COMMENTED", body: "second page review", submitted_at: "2026-01-01T02:00:00Z", commit_id: "abc123", html_url: "https://reviews/2" },
    ],
  ];
}

function pagesAsJsonStream(pages: unknown[][]) {
  return `${pages.map((page) => JSON.stringify(page)).join("\n")}\n`;
}

function defaultThreadState() {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "thread-2",
                isResolved: false,
                isOutdated: false,
                path: "src/b.ts",
                line: 20,
                originalLine: 20,
                comments: {
                  nodes: [{ databaseId: 12, author: { login: "bob", __typename: "User" }, body: "b", url: "https://threads/12", createdAt: "2026-01-01T01:00:00Z", updatedAt: "2026-01-01T01:00:00Z" }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
              {
                id: "thread-1",
                isResolved: true,
                isOutdated: true,
                path: "src/a.ts",
                line: null,
                originalLine: 10,
                comments: {
                  nodes: [{ databaseId: 11, author: { login: "alice", __typename: "User" }, body: "a", url: "https://threads/11", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  };
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "babysit-pr-test-"));
  fakeBin = join(temp, "bin");
  prState = join(temp, "pr.json");
  threadState = join(temp, "threads.json");
  commentPages = join(temp, "comment-pages.json-stream");
  reviewPages = join(temp, "review-pages.json-stream");
  mkdirSync(fakeBin);
  writeFileSync(prState, `${JSON.stringify(defaultPrState())}\n`);
  writeFileSync(threadState, `${JSON.stringify(defaultThreadState())}\n`);
  writeFileSync(commentPages, pagesAsJsonStream(defaultCommentPages()));
  writeFileSync(reviewPages, pagesAsJsonStream(defaultReviewPages()));
  const gh = join(fakeBin, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-} \${2:-}" in
  "repo view") printf '%s\\n' 'acme/widgets' ;;
  "pr view") cat "$FAKE_PR_STATE" ;;
  "api graphql") cat "$FAKE_THREAD_STATE" ;;
  "api --paginate")
    case "$*" in
      *"/issues/7/comments"*) cat "$FAKE_COMMENT_PAGES" ;;
      *"/pulls/7/reviews"*) cat "$FAKE_REVIEW_PAGES" ;;
      *) echo "unexpected paginated gh invocation: $*" >&2; exit 2 ;;
    esac ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
});

afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
});

function runWaiter(args: string[]) {
  return spawnSync("bash", [waiter, ...args], {
    cwd: temp,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      FAKE_PR_STATE: prState,
      FAKE_THREAD_STATE: threadState,
      FAKE_COMMENT_PAGES: commentPages,
      FAKE_REVIEW_PAGES: reviewPages,
    },
  });
}

function snapshot() {
  const result = runWaiter(["snapshot", "#7", "--repo", "acme/widgets"]);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("babysit-pr skill", () => {
  it("replaces the approval-gated skill with an explicit autonomous identity", () => {
    const source = readFileSync(skillFile, "utf8");
    const end = source.indexOf("\n---\n", 4);
    const frontmatter = YAML.parse(source.slice(4, end));

    expect(frontmatter.name).toBe("babysit-pr");
    expect(frontmatter["disable-model-invocation"]).toBe(true);
    expect(frontmatter.description.length).toBeLessThan(1024);
    expect(frontmatter.description).toContain("Use only when the user explicitly asks");
    expect(frontmatter.description).toContain("named PR or the unambiguous current PR");
    for (const trigger of ["babysit PR", "watch this PR", "monitor this PR", "keep this PR moving", "address PR feedback", "handle review comments", "fix PR feedback", "unblock this PR"]) {
      expect(frontmatter.description).toContain(trigger);
    }
    expect(source).toContain("Work autonomously");
    expect(source).toContain("do not present a plan");
    expect(source).not.toContain("Run this plan?");
    expect(source).not.toContain("user approves");
    const retiredSkill = join(root, "skills/general", ["address", "pr", "feedback"].join("-"));
    expect(existsSync(retiredSkill)).toBe(false);
  });

  it("requires shared readiness, human writing, dedicated worktrees, and no merge", () => {
    const source = readFileSync(skillFile, "utf8");
    expect(source).toContain("../_shared/pr-readiness/PROTOCOL.md");
    expect(source).toContain("Load the installed `worktrees` skill by name");
    expect(source).toContain("load the installed `writing-for-humans` skill by name");
    expect(source).toContain("worktree_list");
    expect(source).toContain("worktree_adopt");
    expect(source).toContain("worktree_new");
    expect(source).toContain("The current adoption helper may return the primary checkout");
    expect(source).toContain("base` set to that exact `headRefOid`");
    expect(source).toContain("git fetch origin pull/PR_NUMBER/head");
    expect(source).toContain("HEAD:PR_HEAD_BRANCH");
    expect(source).toContain("Re-fetch the remote PR head SHA immediately before every push");
    expect(source).toContain("READY TO MERGE");
    expect(source).toContain("MERGED");
    expect(source).toContain("Never merge the pull request");
  });

  it("uses the blocking watcher rather than agent sleep turns", () => {
    const source = readFileSync(skillFile, "utf8");
    expect(source).toContain("wait-for-pr-change.sh\" snapshot");
    expect(source).toContain("wait-for-pr-change.sh\" wait");
    expect(source).toContain("Inspect the baseline file itself as the authoritative final state");
    expect(source).toContain('snapshot PR_NUMBER --repo OWNER/REPO > "$TEMP_BASELINE"');
    expect(source).toContain("jq -e");
    expect(source).toContain('mv "$TEMP_BASELINE" "$BASELINE"');
    expect(source).not.toContain('| tee "$TEMP_BASELINE"');
    expect(source).toContain("Do not replace this watcher with repeated agent `sleep` turns");
    expect(statSync(waiter).mode & 0o111).not.toBe(0);
    const help = spawnSync("bash", [waiter, "--help"], { encoding: "utf8" });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("wait-for-pr-change.sh snapshot PR");
  });
});

describe("wait-for-pr-change.sh", () => {
  it("rejects PR zero as non-positive", () => {
    const result = runWaiter(["snapshot", "0", "--repo", "acme/widgets"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PR must be a positive integer");
  });

  it("creates a canonical snapshot independent of API array ordering", () => {
    const first = snapshot();
    const parsed = JSON.parse(first);
    expect(parsed.repository).toBe("acme/widgets");
    expect(parsed.pr.number).toBe(7);
    expect(parsed.pr.statusCheckRollup.map((check: { name: string }) => check.name)).toEqual(["lint", "unit"]);
    expect(parsed.pr.comments.map((comment: { databaseId: number }) => comment.databaseId)).toEqual([1, 2]);
    expect(parsed.pr.reviews.map((review: { databaseId: number }) => review.databaseId)).toEqual([21, 22]);
    expect(parsed.reviewThreads.map((thread: { id: string }) => thread.id)).toEqual(["thread-1", "thread-2"]);

    const reordered = defaultPrState();
    reordered.statusCheckRollup.reverse();
    writeFileSync(prState, `${JSON.stringify(reordered)}\n`);
    writeFileSync(commentPages, pagesAsJsonStream(defaultCommentPages().reverse()));
    writeFileSync(reviewPages, pagesAsJsonStream(defaultReviewPages().reverse()));
    const reorderedThreads = defaultThreadState();
    reorderedThreads.data.repository.pullRequest.reviewThreads.nodes.reverse();
    writeFileSync(threadState, `${JSON.stringify(reorderedThreads)}\n`);
    expect(snapshot()).toBe(first);
  });

  it("includes later pages of top-level comments and submitted reviews in change detection", () => {
    const first = snapshot();
    const comments = defaultCommentPages();
    comments[1]![0]!.body = "changed on second comment page";
    writeFileSync(commentPages, pagesAsJsonStream(comments));
    const reviews = defaultReviewPages();
    reviews[1]![0]!.body = "changed on second review page";
    writeFileSync(reviewPages, pagesAsJsonStream(reviews));

    const second = snapshot();
    expect(second).not.toBe(first);
    const parsed = JSON.parse(second);
    expect(parsed.pr.comments.find((comment: { databaseId: number }) => comment.databaseId === 2).body).toBe("changed on second comment page");
    expect(parsed.pr.reviews.find((review: { databaseId: number }) => review.databaseId === 22).body).toBe("changed on second review page");
  });

  it("detects an immediate change and atomically updates the baseline", () => {
    const baseline = join(temp, "baseline.json");
    writeFileSync(baseline, `${snapshot()}\n`);
    const changed = defaultPrState();
    changed.headRefOid = "def456";
    changed.updatedAt = "2026-01-01T02:00:00Z";
    writeFileSync(prState, `${JSON.stringify(changed)}\n`);

    const result = runWaiter(["wait", "7", "--repo=acme/widgets", `--baseline=${baseline}`, "--interval=1", "--timeout=3"]);
    expect(result.status, result.stderr).toBe(0);
    const event = JSON.parse(result.stdout);
    expect(event.event).toBe("changed");
    expect(event.oldHash).not.toBe(event.newHash);
    expect(event.snapshot.pr.headRefOid).toBe("def456");
    expect(JSON.parse(readFileSync(baseline, "utf8")).pr.headRefOid).toBe("def456");
  });

  it("returns a structured timeout without changing an equal baseline", () => {
    const baseline = join(temp, "baseline.json");
    const initial = snapshot();
    writeFileSync(baseline, `${initial}\n`);

    const result = runWaiter(["wait", "7", "--repo", "acme/widgets", "--baseline", baseline, "--interval", "1", "--timeout", "1"]);
    expect(result.status, result.stderr).toBe(0);
    const event = JSON.parse(result.stdout);
    expect(event.event).toBe("timeout");
    expect(event.repository).toBe("acme/widgets");
    expect(event.pr).toBe(7);
    expect(JSON.parse(readFileSync(baseline, "utf8"))).toEqual(JSON.parse(initial));
  });

  it("rejects a baseline captured for another PR", () => {
    const baseline = join(temp, "baseline.json");
    const wrong = JSON.parse(snapshot());
    wrong.pr.number = 8;
    writeFileSync(baseline, `${JSON.stringify(wrong)}\n`);

    const result = runWaiter(["wait", "7", "--repo", "acme/widgets", "--baseline", baseline, "--interval", "1", "--timeout", "1"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("baseline belongs to a different repository or PR");
  });
});
