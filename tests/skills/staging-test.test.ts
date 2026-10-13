import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const scripts = path.join(root, "skills/lleverage/staging-test/scripts");
const plan = path.join(scripts, "staging-plan.sh");
const push = path.join(scripts, "staging-push.sh");
const builds = path.join(scripts, "staging-builds.sh");

let dir: string;
let work: string;
let env: Record<string, string>;

function sh(command: string, cwd = work) {
  const result = spawnSync("bash", ["-c", command], { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command}\n${result.stderr}`);
  return result.stdout.trim();
}

/** Commit FILE with CONTENT on the current branch of the work clone. */
function commit(file: string, content: string, message = `edit ${file}`) {
  mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  writeFileSync(path.join(work, file), content);
  sh(`git add -A && git commit -q -m '${message}'`);
  return sh("git rev-parse HEAD");
}

const lines = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `line ${i}${tag}`).join("\n") + "\n";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString().replace(/\.\d+Z$/, "Z");

function activity(minutes: number, after = "0000000000000000000000000000000000000000") {
  writeFileSync(path.join(dir, "activity.json"), JSON.stringify([{ timestamp: minutesAgo(minutes), after, actor: { login: "someone" }, activity_type: "push" }]));
}

function checks(runs: Array<{ name: string; status: string; conclusion?: string | null }>) {
  writeFileSync(
    path.join(dir, "checks.json"),
    JSON.stringify({ check_runs: runs.map((r) => ({ app: { slug: "google-cloud-build" }, conclusion: null, ...r })) }),
  );
}

function runPlan(args: string[] = ["--ref", "fix"], extra: Record<string, string> = {}) {
  const result = spawnSync("bash", [plan, "--json", ...args], { cwd: work, env: { ...env, ...extra }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as Record<string, string>;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "staging-test-"));
  work = path.join(dir, "work");
  mkdirSync(path.join(dir, "bin"));
  // gh stand-in: answers the activity and check-runs endpoints from files, applying --jq.
  writeFileSync(
    path.join(dir, "bin", "gh"),
    `#!/usr/bin/env bash
filter=. url=""
while [ $# -gt 0 ]; do case "$1" in api) shift ;; --jq) filter="$2"; shift 2 ;; *) url="$1"; shift ;; esac; done
case "$url" in *activity*) f="$FAKE_ACTIVITY" ;; *check-runs*) f="$FAKE_CHECKS" ;; *) exit 1 ;; esac
[ -f "$f" ] || exit 1
jq -r "$filter" "$f"
`,
  );
  writeFileSync(path.join(dir, "bin", "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(path.join(dir, "bin", "gh"), 0o755);
  chmodSync(path.join(dir, "bin", "sleep"), 0o755);
  env = {
    PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
    HOME: dir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    FAKE_ACTIVITY: path.join(dir, "activity.json"),
    FAKE_CHECKS: path.join(dir, "checks.json"),
    STAGING_FREEZE_CMD: "echo 'platform-staging live'",
  };
  sh(`git init -q --bare -b main ${dir}/remote.git && git clone -q ${dir}/remote.git ${work}`, dir);
  sh("git checkout -q -b main");
  commit("a.txt", lines(20));
  commit("b.txt", lines(20));
  commit("pnpm-lock.yaml", lines(5));
  sh("git push -q origin main && git branch staging && git push -q origin staging");
  activity(120);
  checks([{ name: "app (lleverage-staging)", status: "completed", conclusion: "success" }]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Staging-only work, then the change as a branch from main. */
function stagingCommit(file: string, content: string) {
  sh("git checkout -q staging");
  const sha = commit(file, content, `staging-only ${file}`);
  sh("git push -q origin staging && git checkout -q main");
  return sha;
}
function fixBranch(file = "fix.txt", content = "fix\n") {
  sh("git checkout -q -b fix main");
  const sha = commit(file, content, "the fix");
  sh("git checkout -q main");
  return sha;
}
function mainCommit(file: string, content: string) {
  sh("git checkout -q main");
  const sha = commit(file, content);
  sh("git push -q origin main");
  return sha;
}

describe("staging-plan", () => {
  test("tier 1: a recent staging and a clean merge merge the change as it is", () => {
    stagingCommit("experiment.txt", "x\n");
    fixBranch();
    const out = runPlan();
    expect(out.verdict).toBe("merge-as-is");
    expect(out.badly_out_of_date).toBe("false");
    expect(out.freeze).toBe("live");
  });

  test("tier 2: a staging badly behind main merges main first", () => {
    stagingCommit("experiment.txt", "x\n");
    mainCommit("c.txt", "c\n");
    mainCommit("d.txt", "d\n");
    fixBranch();
    const out = runPlan(["--ref", "fix"], { STAGING_MAX_BEHIND: "2" });
    expect(out.behind).toBe("2");
    expect(out.badly_out_of_date).toBe("true");
    expect(out.verdict).toBe("merge-main-first");
    expect(out.t2_change_conflicts).toBe("0");
  });

  test("tier 1 conflicts move to tier 2 even when staging is recent", () => {
    // The fix branch carries main's change to a.txt, which staging-only work also changed.
    stagingCommit("a.txt", lines(20, " staging"));
    mainCommit("a.txt", lines(20, " main"));
    fixBranch();
    const out = runPlan(["--ref", "fix"]);
    expect(out.badly_out_of_date).toBe("false");
    expect(out.t1_conflicts).toBe("1");
    expect(out.verdict).toBe("merge-main-first-resolve");
  });

  test("a few main conflicts are resolved by hand; protected paths and too many need a reset", () => {
    stagingCommit("a.txt", lines(20, " staging"));
    mainCommit("a.txt", lines(20, " main"));
    fixBranch();
    let out = runPlan(["--ref", "fix"], { STAGING_MAX_BEHIND: "1" });
    expect(out.main_conflicts).toBe("1");
    expect(out.verdict).toBe("merge-main-first-resolve");

    out = runPlan(["--ref", "fix"], { STAGING_MAX_BEHIND: "1", STAGING_MAX_CONFLICT_HUNKS: "0" });
    expect(out.verdict).toBe("reset-needed");
    expect(out.reason).toContain("over the limit");

    stagingCommit("pnpm-lock.yaml", lines(5, " staging"));
    mainCommit("pnpm-lock.yaml", lines(5, " main"));
    out = runPlan(["--ref", "fix"], { STAGING_MAX_BEHIND: "1" });
    expect(out.main_protected).toBe("pnpm-lock.yaml");
    expect(out.verdict).toBe("reset-needed");
  });

  test("a change that collides with staging-only work after main merges needs a reset", () => {
    stagingCommit("b.txt", lines(20, " staging"));
    mainCommit("c.txt", "c\n");
    fixBranch("b.txt", lines(20, " fix"));
    const out = runPlan(["--ref", "fix"], { STAGING_MAX_BEHIND: "1" });
    expect(out.main_conflicts).toBe("0");
    expect(out.t2_change_conflicts).toBe("1");
    expect(out.verdict).toBe("reset-needed");
  });

  test("a change already on staging or conflicting with main is not a staging tier", () => {
    const sha = fixBranch();
    sh(`git checkout -q staging && git merge -q --no-ff -m merge fix && git push -q origin staging && git checkout -q main`);
    expect(runPlan(["--ref", sha]).verdict).toBe("already-on-staging");

    const base = sh("git rev-parse main");
    mainCommit("a.txt", lines(20, " main"));
    sh(`git branch -D -q fix && git checkout -q -b fix ${base}`);
    commit("a.txt", lines(20, " fix"), "the fix, on an old main");
    sh("git checkout -q main");
    expect(runPlan().verdict).toBe("update-branch");
  });

  test("a freeze, or an unreadable freeze state, defers", () => {
    fixBranch();
    expect(runPlan(["--ref", "fix"], { STAGING_FREEZE_CMD: "echo 'platform-staging FROZEN'" }).verdict).toBe("defer");
    const out = runPlan(["--ref", "fix"], { STAGING_FREEZE_CMD: "exit 1" });
    expect(out.verdict).toBe("defer");
    expect(out.freeze).toBe("unknown");
  });

  test("someone else's recent push or running builds mean wait, then defer after --wait", () => {
    fixBranch();
    activity(10);
    let out = runPlan();
    expect(out.verdict).toBe("wait");
    expect(out.reason).toContain("pushed 10 min ago");

    out = runPlan(["--ref", "fix", "--wait", "30"]);
    expect(out.verdict).toBe("defer");
    expect(out.reason).toContain("still after waiting");

    const head = sh("git rev-parse origin/staging");
    activity(10, head);
    expect(runPlan(["--ref", "fix", "--mine", head]).verdict).toBe("merge-as-is");

    activity(120);
    checks([{ name: "app (lleverage-staging)", status: "in_progress" }, { name: "app (lleverage)", status: "in_progress" }]);
    out = runPlan();
    expect(out.builds_running).toBe("1");
    expect(out.verdict).toBe("wait");

    rmSync(path.join(dir, "activity.json"));
    expect(runPlan().reason).toContain("unreadable");
  });
});

describe("staging-push", () => {
  function prepared(mergeRef = "fix") {
    const staging = sh("git rev-parse origin/staging");
    const wt = path.join(dir, "wt");
    sh(`git worktree add -q --detach ${wt} ${staging} && git -C ${wt} merge -q --no-ff -m test ${mergeRef}`);
    return { staging, wt };
  }
  const runPush = (args: string[]) => spawnSync("bash", [push, ...args], { cwd: work, env, encoding: "utf8" });

  test("pushes a fast-forward of the planned head and prints both SHAs", () => {
    fixBranch();
    const { staging, wt } = prepared();
    const result = runPush(["--dir", wt, "--expect-staging", staging]);
    expect(result.status).toBe(0);
    const head = sh(`git -C ${wt} rev-parse HEAD`);
    expect(result.stdout).toContain(`old=${staging}`);
    expect(result.stdout).toContain(`new=${head}`);
    expect(sh(`git --git-dir=${dir}/remote.git rev-parse staging`)).toBe(head);
  });

  test("refuses when staging moved, when it isn't a fast-forward, or with conflict markers", () => {
    fixBranch();
    const { staging, wt } = prepared();
    stagingCommit("other.txt", "other\n");
    let result = runPush(["--dir", wt, "--expect-staging", staging]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("run staging-plan.sh again");

    const moved = sh("git rev-parse origin/staging");
    result = runPush(["--dir", wt, "--expect-staging", moved]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not be a fast-forward");

    sh(`git -C ${wt} reset -q --hard ${moved}`);
    writeFileSync(path.join(wt, "a.txt"), "<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n");
    sh(`git -C ${wt} commit -q -am markers`);
    result = runPush(["--dir", wt, "--expect-staging", moved]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("conflict markers left in: a.txt");
    expect(sh(`git --git-dir=${dir}/remote.git rev-parse staging`)).toBe(moved);
  });

  test("never forces: the script has no force option", () => {
    const source = readFileSync(push, "utf8");
    expect(source).not.toMatch(/--force|\+HEAD|-f\b/);
    expect(source).toContain('git push "$remote" "$head:refs/heads/staging"');
  });
});

describe("staging-builds", () => {
  const runBuilds = () => spawnSync("bash", [builds, "abc123"], { cwd: dir, env, encoding: "utf8" });

  test("exit codes: all done 0, a failure 1, still running 3", () => {
    checks([
      { name: "app (lleverage-staging)", status: "completed", conclusion: "success" },
      { name: "document-service (lleverage-staging)", status: "completed", conclusion: "neutral" },
      { name: "app (lleverage)", status: "completed", conclusion: "failure" },
    ]);
    expect(runBuilds().status).toBe(0);
    checks([{ name: "app (lleverage-staging)", status: "completed", conclusion: "failure" }]);
    expect(runBuilds().status).toBe(1);
    checks([{ name: "app (lleverage-staging)", status: "queued" }]);
    expect(runBuilds().status).toBe(3);
  });
});

describe("staging-test skill", () => {
  const skill = readFileSync(path.join(root, "skills/lleverage/staging-test/SKILL.md"), "utf8");

  test("states Tom's tiers, the thresholds and that a reset needs approval each time", () => {
    for (const text of [
      "merge the change into `staging` as it is",
      "merge `origin/main` into `staging`",
      "A reset needs Tom's explicit approval each time.",
      "Never ask Tom anything and never wait on him.",
      "100 or more",
      "24 hours old",
      "more than 3 files or more than 5 hunks",
      "30 minutes",
      "STAGING CHECK PENDING",
      "STAGING RESET NEEDED",
    ]) {
      expect(skill.replace(/\s+/g, " ")).toContain(text.replace(/\s+/g, " "));
    }
    const reset = readFileSync(path.join(root, "skills/lleverage/staging-test/references/reset.md"), "utf8");
    expect(reset).toContain("staging-backup/");
    expect(reset).toContain("--force-with-lease=staging:");
  });

  test("sweep and workstream no longer treat staging promotion as an authority question", () => {
    const sweep = readFileSync(path.join(root, "skills/lleverage/sweep/SKILL.md"), "utf8");
    const workstream = readFileSync(path.join(root, "skills/lleverage/workstream/SKILL.md"), "utf8");
    expect(sweep).not.toContain("staging promotion");
    expect(workstream).not.toContain("staging promotion");
    expect(sweep).toContain("staging-test");
    expect(workstream).toContain("staging-test");
  });
});
