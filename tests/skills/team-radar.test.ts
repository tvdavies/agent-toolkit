import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const skill = path.join(root, "skills/lleverage/team-radar");
const scripts = path.join(skill, "scripts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "team-radar-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function node(script: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("node", [path.join(scripts, script), ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: dir, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("team-radar window", () => {
  const windowAt = (now: string, extra: string[] = []) =>
    JSON.parse(node("gather.mjs", ["--print-window", "--now", now, "--state", path.join(dir, "state.json"), ...extra]).stdout);

  test("a Monday run reaches back to Friday, other days to the previous 24 hours", () => {
    expect(windowAt("2026-11-02T10:30:00Z").since).toBe("2026-10-30T10:30:00.000Z");
    expect(windowAt("2026-11-03T10:30:00Z").since).toBe("2026-11-02T10:30:00.000Z");
    expect(windowAt("2026-11-01T10:30:00Z").since).toBe("2026-10-30T10:30:00.000Z");
  });

  test("the last recorded run wins unless it is over a week old, and --since beats both", () => {
    writeFileSync(path.join(dir, "state.json"), JSON.stringify({ lastRun: "2026-10-31T08:00:00Z" }));
    expect(windowAt("2026-11-03T10:30:00Z")).toMatchObject({ since: "2026-10-31T08:00:00.000Z", basis: "since last recorded run" });
    expect(windowAt("2026-11-20T10:30:00Z").since).toBe("2026-11-19T10:30:00.000Z");
    expect(windowAt("2026-11-03T10:30:00Z", ["--since", "2026-10-29T00:00:00Z"]).since).toBe("2026-10-29T00:00:00.000Z");
  });
});

// Fakes for gh and linear-cli: answer by matching the arguments.
const pr = (number: number, login: string, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Change ${number}`,
  url: `https://github.com/lleverage-ai/lleverage/pull/${number}`,
  author: { login, is_bot: false, name: login },
  state: "OPEN",
  isDraft: false,
  createdAt: "2026-11-02T12:00:00Z",
  updatedAt: "2026-11-02T15:00:00Z",
  mergedAt: null,
  closedAt: null,
  headRefName: `branch-${number}`,
  baseRefName: "main",
  body: "",
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  files: [],
  labels: [],
  reviewDecision: "",
  ...extra,
});
const ghFixtures = {
  repos: [
    { name: "lleverage-ai/lleverage", archived: false, pushed_at: "2026-11-03T09:00:00Z", default_branch: "main" },
    { name: "lleverage-ai/jeffs-brain", archived: false, pushed_at: "2026-11-03T09:00:00Z", default_branch: "main" },
    { name: "lleverage-ai/old", archived: false, pushed_at: "2026-09-01T09:00:00Z", default_branch: "main" },
  ],
  prsAll: [
    pr(101, "alice", { title: "LLE-500 add widgets owner columns", files: [{ path: "packages/db/migrations/0042_widgets.sql" }, { path: "apps/app/src/widgets.ts" }], body: "Adds owner_kind.\nFixes LLE-500" }),
    pr(102, "bob", { state: "MERGED", mergedAt: "2026-11-02T16:00:00Z", title: "Drop widgets project column", headRefName: "bob/widgets", files: [{ path: "packages/db/migrations/0042_widgets.sql" }] }),
    pr(103, "tvdavies", { title: "LLE-9 Tom's tidy-up", files: [{ path: "apps/app/src/other.ts" }] }),
    pr(104, "dependabot[bot]", { author: { login: "app/dependabot", is_bot: true } }),
  ],
  graphql: {
    data: {
      repository: {
        refs: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            { name: "main", target: { committedDate: "2026-11-03T08:00:00Z", messageHeadline: "m", author: { name: "x", user: { login: "x" } } }, associatedPullRequests: { totalCount: 0 } },
            { name: "carol/lle-600-secret-rewrite", target: { committedDate: "2026-11-02T20:00:00Z", messageHeadline: "rewrite auth", author: { name: "Carol", user: { login: "carol" } } }, associatedPullRequests: { totalCount: 0 } },
            { name: "branch-101", target: { committedDate: "2026-11-02T20:00:00Z", messageHeadline: "x", author: { name: "Alice", user: { login: "alice" } } }, associatedPullRequests: { totalCount: 1 } },
            { name: "old-branch", target: { committedDate: "2026-10-01T20:00:00Z", messageHeadline: "x", author: { name: "Dan", user: { login: "dan" } } }, associatedPullRequests: { totalCount: 0 } },
          ],
        },
      },
    },
  },
  compare: { ahead: 3, behind: 1, files: ["apps/app/src/auth/session.ts"], commits: ["rewrite auth", "more"] },
};
const issue = (identifier: string, extra: Record<string, unknown> = {}) => ({
  identifier,
  title: `Issue ${identifier}`,
  url: `https://linear.app/lleverage/issue/${identifier}/slug`,
  priority: 3,
  priorityLabel: "Medium",
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-11-02T12:00:00Z",
  team: { key: "LLE" },
  state: { name: "In Progress", type: "started" },
  assignee: { name: "Alice" },
  creator: { name: "Alice" },
  project: null,
  cycle: null,
  description: `Description of ${identifier}`,
  labels: { nodes: [] },
  history: { nodes: [] },
  comments: { nodes: [] },
  attachments: { nodes: [] },
  relations: { nodes: [] },
  ...extra,
});
const linearFixtures = {
  teams: { data: { teams: { nodes: [{ key: "LLE", name: "Lleverage" }] } } },
  issues: {
    data: {
      issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          issue("LLE-700", { createdAt: "2026-11-02T11:00:00Z", title: "Widgets: store project on each widget", assignee: { name: "Bob" }, creator: { name: "Bob" } }),
          issue("LLE-703", { createdAt: "2026-11-02T11:30:00Z", title: "Drop the widgets project column", assignee: { name: "Dan" }, creator: { name: "Dan" } }),
          issue("LLE-701", { history: { nodes: [{ createdAt: "2026-11-02T13:00:00Z", actor: { name: "Alice" }, botActor: null, fromState: { name: "To Do" }, toState: { name: "Done" } }] } }),
          issue("LLE-702", { comments: { nodes: [{ createdAt: "2026-11-02T14:00:00Z", body: "We agreed to drop the project column.", url: "https://linear.app/c/1", user: { name: "Bob" }, botActor: null }] } }),
        ],
      },
    },
  },
  linked: { data: { i0: issue("LLE-500", { title: "Widgets owner model" }) } },
};

function installFakes() {
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(dir, "gh.json"), JSON.stringify(ghFixtures));
  writeFileSync(path.join(dir, "linear.json"), JSON.stringify(linearFixtures));
  writeFileSync(path.join(dir, "calls.log"), "");
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const f = JSON.parse(fs.readFileSync(process.env.FAKE_DIR + "/gh.json", "utf8"));
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DIR + "/calls.log", "gh " + a.join(" ") + "\\n");
const s = a.join(" ");
if (s.startsWith("api orgs/")) console.log(f.repos.map((r) => JSON.stringify(r)).join("\\n"));
else if (s.startsWith("pr list") && s.includes("--state all")) console.log(JSON.stringify(s.includes("lleverage-ai/lleverage") ? f.prsAll : []));
else if (s.startsWith("pr list")) console.log("[]");
else if (s.startsWith("api graphql")) console.log(JSON.stringify(f.graphql));
else if (s.includes("/compare/")) console.log(JSON.stringify(f.compare));
else { console.error("unexpected gh " + s); process.exit(1); }
`,
  );
  writeFileSync(
    path.join(bin, "linear-cli"),
    `#!/usr/bin/env node
const fs = require("fs");
const f = JSON.parse(fs.readFileSync(process.env.FAKE_DIR + "/linear.json", "utf8"));
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DIR + "/calls.log", "linear-cli " + a.join(" ").replace(/\\s+/g, " ") + "\\n");
const q = a[2] || "";
if (q.includes("teams{")) console.log(JSON.stringify(f.teams));
else if (q.includes("issues(")) console.log(JSON.stringify(f.issues));
else if (q.includes("i0: issue")) console.log(JSON.stringify(f.linked));
else { console.error("unexpected linear " + q); process.exit(1); }
`,
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  chmodSync(path.join(bin, "linear-cli"), 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: dir };
}

describe("team-radar gather", () => {
  test("builds a digest with overlap, duplicate and no-ticket hints and keeps Tom's work to one line", () => {
    const env = installFakes();
    const out = path.join(dir, "out");
    const r = node("gather.mjs", ["--since", "2026-11-02T09:00:00Z", "--now", "2026-11-03T09:00:00Z", "--out", out, "--state", path.join(dir, "state.json")], env);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ repos: 1, prs: 3, branches: 1, linearIssues: 3, gaps: [] });
    const digest = readFileSync(path.join(out, "digest.md"), "utf8");

    // Alice's open PR and Bob's merged PR share a migration file.
    expect(digest).toMatch(/pull\/101 \(alice, OPEN\) ⇄ https:\/\/github\.com\/lleverage-ai\/lleverage\/pull\/102 \(bob, MERGED\) \[migration\]/);
    // Dan's new ticket reads like Bob's merged PR.
    expect(digest).toMatch(/## Hint: similar titles[\s\S]*pull\/102 \(bob\) "Drop widgets project column" ⇄ LLE-703 \(Dan\)/);
    // Bob's merged PR has no ticket.
    expect(digest).toMatch(/## Hint: others' PRs with no Linear ID[\s\S]*pull\/102 \(bob, MERGED\)/);
    // A branch with no PR, its ticket from the name and its compare.
    expect(digest).toContain("tree/carol/lle-600-secret-rewrite carol");
    expect(digest).toContain("3 ahead/1 behind");
    expect(digest).not.toContain("old-branch");
    expect(digest).not.toContain("tree/branch-101");
    // Tom's PR is one line in its own section; bots and brain repos are gone.
    expect(digest).toMatch(/## Tom's PRs[\s\S]*pull\/103 "LLE-9 Tom's tidy-up"/);
    expect(digest).not.toContain("pull/104");
    expect(digest).not.toContain("jeffs-brain");
    // Linear: a new issue and a comment stay, a plain status move is dropped.
    expect(digest).toContain("LLE-700");
    expect(digest).toContain("We agreed to drop the project column.");
    expect(digest).not.toContain("LLE-701");
    // The issue a PR links to is fetched for scope checks.
    expect(digest).toMatch(/## Issues linked from others' PRs[\s\S]*LLE-500/);

    const shown = node("show.mjs", ["--data", path.join(out, "data.json"), "lleverage-ai/lleverage#101", "LLE-702"]);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain("packages/db/migrations/0042_widgets.sql");
    expect(shown.stdout).toContain("Adds owner_kind.");
    expect(shown.stdout).toContain("We agreed to drop the project column.");

    // Read-only: no mutating gh or Linear calls.
    const calls = readFileSync(path.join(dir, "calls.log"), "utf8");
    expect(calls).not.toMatch(/mutation|pr (comment|review|merge|edit|close)|issues (create|update)|--method (POST|PATCH|DELETE)|-X (POST|PATCH|DELETE)/);
  });

  test("the digest drops noise: PR-own-ticket pairs, broad branches and long unticketed runs", async () => {
    const { renderDigest } = await import(path.join(scripts, "digest.mjs"));
    const base = { repo: "lleverage-ai/lleverage", self: false, additions: 1, deletions: 1, areas: [], labels: [], updatedAt: "2026-11-02T10:00:00Z" };
    const mk = (n: number, author: string, extra: Record<string, unknown> = {}) => ({
      ...base, number: n, ref: `lleverage-ai/lleverage#${n}`, url: `https://github.com/lleverage-ai/lleverage/pull/${n}`, author, state: "OPEN", title: `Change ${n}`, files: [], linear: [], ...extra,
    });
    const many = Array.from({ length: 100 }, (_, i) => `apps/app/src/f${i}.ts`);
    const prs = [
      mk(1, "gabe", { title: "LLE-1: Entity service types API with unique groups", linear: ["LLE-1"], files: ["apps/app/src/f1.ts"] }),
      mk(2, "badr", { title: "Staging twin", linear: ["LLE-2"], files: many }),
      ...[10, 11, 12, 13, 14, 15].map((n) => mk(n, "lorenzo", { repo: "lleverage-ai/website", url: `https://github.com/lleverage-ai/website/pull/${n}`, state: "MERGED" })),
    ];
    const issues = [{
      identifier: "LLE-1", title: "Entity service types API with unique groups", state: { name: "In Progress" }, priority: 3, priorityLabel: "Medium",
      assignee: { name: "gabriel@lleverage.ai" }, creator: { name: "gabriel@lleverage.ai" }, attachments: [],
      activity: { events: [{ at: "2026-11-02T09:00:00Z", who: "gabriel@lleverage.ai", what: "created" }], comments: [] },
    }];
    const digest = renderDigest({
      window: { since: "a", until: "b", basis: "test" }, gaps: [],
      github: { scanned: ["lleverage-ai/lleverage"], repos: [{ repo: "lleverage-ai/lleverage", prs, openPrs: [], branches: [] }] },
      linear: { keys: ["LLE"], teamsScanned: ["LLE"], issues, linked: [] },
    });
    const section = (name: string) => digest.split(`## ${name}`)[1].split("\n## ")[0];
    // Gabe's PR and the ticket it names are one piece of work, not duplicates.
    expect(section("Hint: similar titles")).not.toContain("LLE-1 ");
    // A 100-file PR is named once, not paired with every file it carries.
    expect(section("Hint: unshipped work")).toMatch(/Left out \(100\+ files, too broad to compare\): lleverage-ai\/lleverage#2 \(badr\)/);
    expect(section("Hint: unshipped work")).not.toContain("pull/1 ");
    // Six unticketed website PRs by one person collapse to two and a count.
    expect(section("Hint: others' PRs with no Linear ID")).toContain("…and 4 more by lorenzo in lleverage-ai/website");
  });

  test("a failing source is reported as a gap and exits 4", () => {
    const env = installFakes();
    writeFileSync(path.join(dir, "bin", "linear-cli"), "#!/usr/bin/env bash\necho 'auth failed' >&2\nexit 1\n");
    const r = node("gather.mjs", ["--since", "2026-11-02T09:00:00Z", "--now", "2026-11-03T09:00:00Z", "--out", path.join(dir, "out"), "--skip", "branches"], env);
    expect(r.status).toBe(4);
    expect(JSON.parse(r.stdout).gaps.join(" ")).toContain("Linear");
    expect(readFileSync(path.join(dir, "out", "digest.md"), "utf8")).toMatch(/## Not reached\n\n- Linear/);
  }, 30_000);
});

const finding = (extra: Record<string, unknown> = {}) => ({
  type: "conflict",
  title: "Two migrations reshape widgets",
  priority: "High",
  confidence: "high",
  who: ["Alice", "Bob"],
  what: "PR 101 adds owner_kind while 102 dropped the project column, see LLE-500.",
  why: "The second migration fails.",
  action: "Ask Alice to rebase.",
  subjects: ["https://github.com/lleverage-ai/lleverage/pull/101", "https://github.com/lleverage-ai/lleverage/pull/102"],
  evidence: [{ label: "PR", url: "https://github.com/lleverage-ai/lleverage/pull/101" }],
  ...extra,
});

describe("team-radar findings", () => {
  const write = (findings: unknown[], gaps: string[] = []) => {
    const file = path.join(dir, `findings-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify({ window: { since: "2026-11-02T09:00:00Z", until: "2026-11-03T09:00:00Z" }, findings, gaps }));
    return file;
  };
  const state = () => path.join(dir, "state", "state.json");

  test("nothing to flag is a normal result", () => {
    const r = node("findings.mjs", ["--in", write([], ["No standup notes for Monday"]), "--state", state(), "--record"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to flag");
    expect(r.stdout).toContain("Not checked this run:\n- No standup notes for Monday");
    expect(JSON.parse(readFileSync(state(), "utf8")).lastRun).toBe("2026-11-03T09:00:00Z");
  });

  test("rejects SEV levels, unknown priorities and findings without evidence", () => {
    const r = node("findings.mjs", ["--in", write([finding({ priority: "SEV2" }), finding({ evidence: [] })]), "--state", state()]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Linear priority name");
    expect(r.stderr).toContain("never SEV");
    expect(r.stderr).toContain("evidence needs at least one link");
  });

  test("flags once, stays quiet while unchanged, and flags again when it materially changes", () => {
    const first = node("findings.mjs", ["--in", write([finding(), finding({ type: "no-ticket", title: "Low one", priority: "Low", subjects: ["https://github.com/lleverage-ai/lleverage/pull/102"] })]), "--state", state(), "--record"]);
    expect(first.status).toBe(3);
    expect(first.stdout).toMatch(/1\. High: Two migrations reshape widgets \(new, high confidence, tr-[0-9a-f]{10}\)/);
    expect(first.stdout).toMatch(/2\. Low: Low one/);
    expect(first.stdout).toContain("https://linear.app/lleverage/issue/LLE-500");
    const key = first.stdout.match(/tr-[0-9a-f]{10}/)![0];

    // Same finding, subjects in another order and form: same key, suppressed.
    const again = node("findings.mjs", ["--in", write([finding({ subjects: ["lleverage-ai/lleverage#102", "https://github.com/lleverage-ai/lleverage/pull/101/files"] })]), "--state", state(), "--record"]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("nothing to flag");
    expect(again.stdout).toContain(key);

    // Priority rises: flagged again as changed.
    const worse = node("findings.mjs", ["--in", write([finding({ priority: "Urgent" })]), "--state", state()]);
    expect(worse.status).toBe(3);
    expect(worse.stdout).toContain("changed: priority rose from High to Urgent");

    // A new PR in the evidence: changed.
    const wider = node("findings.mjs", ["--in", write([finding({ evidence: [{ url: "https://github.com/lleverage-ai/lleverage/pull/101" }, { url: "https://github.com/lleverage-ai/lleverage/pull/150" }] })]), "--state", state(), "--json"]);
    expect(wider.status).toBe(3);
    expect(JSON.parse(wider.stdout).flag[0]).toMatchObject({ key, status: "changed", change: "now also involves gh:lleverage-ai/lleverage#150" });
  });

  test("keys passed with --seen suppress findings even without a state file", () => {
    const first = node("findings.mjs", ["--in", write([finding()]), "--state", state(), "--json"]);
    const key = JSON.parse(first.stdout).flag[0].key;
    const r = node("findings.mjs", ["--in", write([finding()]), "--state", path.join(dir, "elsewhere.json"), "--seen", `tr-0000000000,${key}`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to flag");
  });
});

describe("team-radar skill", () => {
  test("description fits the 400-character budget and every script documents itself", () => {
    const source = readFileSync(path.join(skill, "SKILL.md"), "utf8");
    const description = source.match(/^description: (.*)$/m)![1]!;
    expect(description.length).toBeLessThan(400);
    expect(source).not.toMatch(/\bSEV ?\d/);
    for (const name of readdirSync(scripts)) {
      if (name === "lib.mjs" || name === "digest.mjs") continue;
      const help = node(name, ["--help"]);
      expect(help.status, name).toBe(0);
      expect(`${help.stdout}${help.stderr}`, name).toMatch(/[Uu]sage/);
    }
  });
});
