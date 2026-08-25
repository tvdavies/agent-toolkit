import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");
const sharedDir = join(root, "skills/general/_shared/pr-readiness");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

function runFakeBlockerFetch() {
  const dir = mkdtempSync(join(tmpdir(), "pr-readiness-test-"));
  tempDirs.push(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "repo view --json owner,name")
    printf '%s\\n' '{"owner":{"login":"acme"},"name":"repo"}' ;;
  "pr view 7 --json number,title,headRefName,baseRefName,mergeable,mergeStateStatus,isDraft,url")
    printf '%s\\n' '{"number":7,"title":"Fix","headRefName":"fix","baseRefName":"main","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","isDraft":false,"url":"https://example.test/7"}' ;;
  "pr checks 7 --json name,state,link,workflow")
    printf '%s\\n' '[{"name":"unit","state":"FAILURE","link":"https://example.test/run/1","workflow":"ci"},{"name":"build","state":"PENDING","link":"https://example.test/run/2","workflow":"ci"}]'
    exit 1 ;;
  "pr view 7 --json reviews")
    printf '%s\\n' '{"reviews":[{"author":{"login":"alice"},"state":"CHANGES_REQUESTED","body":"old","submittedAt":"2026-01-01T00:00:00Z"},{"author":{"login":"alice"},"state":"APPROVED","body":"fixed","submittedAt":"2026-01-02T00:00:00Z"},{"author":{"login":"bob"},"state":"APPROVED","body":"old approval","submittedAt":"2026-01-01T00:00:00Z"},{"author":{"login":"bob"},"state":"CHANGES_REQUESTED","body":"new blocker","submittedAt":"2026-01-03T00:00:00Z"}]}' ;;
  api\\ graphql*)
    printf '%s\\n' '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}' ;;
  *)
    echo "unexpected gh invocation: $*" >&2
    exit 2 ;;
esac
`,
  );
  chmodSync(gh, 0o755);

  return spawnSync(
    "bash",
    [join(sharedDir, "scripts/fetch-pr-blockers.sh"), "7"],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    },
  );
}

describe("shared PR readiness protocol", () => {
  it("defines one canonical blocker and readiness contract", () => {
    const protocol = readFileSync(join(sharedDir, "PROTOCOL.md"), "utf8");

    expect(protocol).toContain("Authoritative state");
    expect(protocol).toContain("Never resolve a thread before its fix is pushed");
    expect(protocol).toContain("Bot author");
    expect(protocol).toContain("Ready-to-merge criteria");
    expect(protocol).toContain("The absence of failing checks or unresolved threads alone is never enough");
    expect(protocol).toContain("three no-progress cycles");
    expect(protocol).toContain("dedicated non-primary managed worktree");
    expect(protocol).toContain("Never treat the primary checkout as the PR worktree");
    expect(protocol).toContain("wait-for-pr-change.sh");
    expect(protocol).toContain("ready to merge or already merged");
    expect(protocol).not.toContain("drive-pr");
    expect(protocol).not.toContain("daemon");
  });

  it("is consumed by the retained autonomous control policies", () => {
    const babysit = read("skills/general/babysit-pr/SKILL.md");
    const start = read("skills/general/start-ticket/SKILL.md");

    expect(babysit).toContain("../_shared/pr-readiness/PROTOCOL.md");
    expect(babysit).toContain("Work autonomously");
    expect(start).toContain("../_shared/pr-readiness/PROTOCOL.md");
    expect(start).toContain("autonomous and bounded");
  });

  it("keeps canonical readiness scripts executable without successor wrappers", () => {
    for (const name of ["fetch-pr-blockers.sh", "reply-and-resolve.sh"]) {
      const shared = join(sharedDir, "scripts", name);
      expect(statSync(shared).mode & 0o111).not.toBe(0);
    }
    const retiredSkill = join("skills/general", ["address", "pr", "feedback"].join("-"), "SKILL.md");
    expect(() => read(retiredSkill)).toThrow();
  });

  it("keeps only each reviewer's latest state and preserves non-zero check JSON", () => {
    const result = runFakeBlockerFetch();

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.reviews).toEqual([
      {
        author: "bob",
        state: "CHANGES_REQUESTED",
        body: "new blocker",
        submittedAt: "2026-01-03T00:00:00Z",
      },
    ]);
    expect(payload.checks.map((check: { name: string }) => check.name)).toEqual(["unit"]);
    expect(payload.pending.map((check: { name: string }) => check.name)).toEqual(["build"]);
  });
});
