import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");
const ledger = join(root, "skills/lleverage/workstream/scripts/pr-ledger.sh");

// A real prwatch on the test machine must not leak into the fallback tests.
const pathWithoutPrwatch = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((dir) => dir && !existsSync(join(dir, "prwatch")))
  .join(delimiter);

let temp = "";
let ghBin = "";
let prwatchBin = "";
let wsDir = "";

type PrState = {
  state: string;
  isDraft?: boolean;
  head?: string;
  ci?: string;
  review?: string | null;
  changesBy?: string[];
  unresolved?: number;
  mergeable?: string;
  auto?: boolean;
  merge?: string | null;
};

const prs: Record<string, PrState> = {
  "acme/widgets#7": { state: "OPEN", ci: "FAILURE", review: "CHANGES_REQUESTED", changesBy: ["bob"], unresolved: 1 },
  "acme/infra#12": { state: "OPEN", ci: "SUCCESS", review: "APPROVED" },
  "acme/widgets#9": { state: "MERGED", ci: "SUCCESS", review: "APPROVED", merge: "0123456789abcdef" },
};

// The old gh-backed watcher printed exactly these lines; both backends must keep them.
const expected = {
  "acme/widgets#7": "state=OPEN head=abc12345 ci=FAILURE review=CHANGES_REQUESTED changes-by=bob threads=1 mergeable=MERGEABLE auto=off need=ci-failed",
  "acme/infra#12": "state=OPEN head=abc12345 ci=SUCCESS review=APPROVED threads=0 mergeable=MERGEABLE auto=off need=approved-not-armed",
  "acme/widgets#9": "state=MERGED head=abc12345 ci=SUCCESS review=APPROVED threads=0 mergeable=MERGEABLE auto=off need=none merge=0123456789",
};

function graphql(p: PrState) {
  return {
    data: {
      repository: {
        pullRequest: {
          state: p.state,
          isDraft: p.isDraft ?? false,
          headRefOid: p.head ?? "abc1234567890",
          mergeable: p.mergeable ?? "MERGEABLE",
          reviewDecision: p.review ?? null,
          baseRefName: "main",
          mergeCommit: p.merge ? { oid: p.merge } : null,
          autoMergeRequest: p.auto ? { enabledAt: "2026-01-01T00:00:00Z" } : null,
          commits: { nodes: [{ commit: { statusCheckRollup: p.ci ? { state: p.ci } : null } }] },
          reviewThreads: { nodes: Array.from({ length: p.unresolved ?? 0 }, () => ({ isResolved: false })).concat([{ isResolved: true }]) },
          latestReviews: { nodes: (p.changesBy ?? []).map((login) => ({ state: "CHANGES_REQUESTED", author: { login } })).concat([{ state: "APPROVED", author: { login: "carol" } }]) },
        },
      },
    },
  };
}

function prwatchSnapshot(ref: string, p: PrState) {
  const [ownerRepo, number] = ref.split("#");
  const [owner, repo] = ownerRepo!.split("/");
  return {
    schemaVersion: 1,
    pr: ref,
    owner,
    repo,
    number: Number(number),
    state: p.state,
    isDraft: p.isDraft ?? false,
    merged: p.state === "MERGED",
    mergeCommit: p.merge ?? null,
    headRefOid: p.head ?? "abc1234567890",
    baseRefName: "main",
    mergeable: p.mergeable ?? "MERGEABLE",
    mergeStateStatus: "CLEAN",
    autoMerge: { enabled: p.auto ?? false, method: null },
    reviewDecision: p.review ?? null,
    reviews: (p.changesBy ?? []).map((author) => ({ author, state: "CHANGES_REQUESTED" })).concat([{ author: "carol", state: "APPROVED" }]),
    threads: { total: (p.unresolved ?? 0) + 1, unresolved: p.unresolved ?? 0, items: [] },
    checks: { state: p.ci ?? "NONE", total: 0, contexts: [] },
    comments: { total: 0, recent: [] },
    needsAction: false,
    reasons: [],
    token: "1.0000000000000000.00000000",
    incomplete: false,
  };
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "pr-ledger-test-"));
  wsDir = join(temp, "ws");
  ghBin = join(temp, "gh-bin");
  prwatchBin = join(temp, "prwatch-bin");
  mkdirSync(ghBin);
  mkdirSync(prwatchBin);

  for (const [ref, p] of Object.entries(prs)) {
    const safe = ref.replace(/[/#]/g, "_");
    writeFileSync(join(temp, `gql-${safe}.json`), JSON.stringify(graphql(p)));
  }
  writeFileSync(
    join(ghBin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\\n' "$1" "$2" >> "$FAKE_LOG"
owner="" name="" n=""
for a in "$@"; do
  case "$a" in owner=*) owner="\${a#owner=}" ;; name=*) name="\${a#name=}" ;; n=*) n="\${a#n=}" ;; esac
done
f="$FAKE_DIR/gql-\${owner}_\${name}_\${n}.json"
[ -f "$f" ] || { echo 'gh: {"message":"Could not resolve to a PullRequest"}' >&2; exit 1; }
cat "$f"
`,
  );
  chmodSync(join(ghBin, "gh"), 0o755);

  const snapshots = Object.entries(prs).map(([ref, p]) => prwatchSnapshot(ref, p));
  writeFileSync(join(temp, "status.json"), JSON.stringify(snapshots, null, 2));
  writeFileSync(
    join(prwatchBin, "prwatch"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'prwatch %s\\n' "$*" >> "$FAKE_LOG"
case "\${1:-}" in
  status)
    shift; shift
    # Print only the snapshots asked for; report unknown PRs like prwatch does.
    rc=0
    jq --args '[.[] | select(.pr as $p | $ARGS.positional | index($p))]' "$@" < "$FAKE_DIR/status.json"
    for ref in "$@"; do
      jq -e --arg r "$ref" 'any(.[]; .pr == $r)' "$FAKE_DIR/status.json" >/dev/null || { echo "prwatch: $ref not found" >&2; rc=3; }
    done
    exit "$rc" ;;
  events)
    if [ -n "\${FAKE_EVENT_BURST:-}" ]; then
      while :; do echo '{"type":"change","pr":"x","changes":["checks"],"snapshot":{}}'; sleep 0.3; done
    fi
    echo '{"type":"change","pr":"x","changes":["initial"],"snapshot":{}}'
    exec sleep 30 ;;
  *) echo "unexpected prwatch invocation: $*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(join(prwatchBin, "prwatch"), 0o755);
});

afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
});

function run(args: string[], options: { prwatch?: boolean; timeout?: number; env?: Record<string, string> } = {}) {
  const path = options.prwatch ? [prwatchBin, ghBin, pathWithoutPrwatch] : [ghBin, pathWithoutPrwatch];
  return spawnSync("bash", [ledger, ...args], {
    cwd: temp,
    encoding: "utf8",
    timeout: options.timeout ?? 10_000,
    killSignal: "SIGTERM",
    env: { ...process.env, ...options.env, PATH: path.join(delimiter), WS_DIR: wsDir, FAKE_DIR: temp, FAKE_LOG: join(temp, "calls.log") },
  });
}

function calls() {
  const log = join(temp, "calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
}

function addAll(extra: string[] = []) {
  for (const ref of [...Object.keys(prs), ...extra]) {
    const [repo, n] = ref.split("#");
    const added = run(["add", repo!, n!, `LLE-${n}`, "agent-a"]);
    expect(added.status, added.stderr).toBe(0);
  }
}

function lines(stdout: string) {
  return stdout.trim().split("\n").filter(Boolean);
}

describe("pr-ledger.sh list", () => {
  it("reads every PR with one prwatch status call and keeps the line format", () => {
    addAll(["acme/widgets#404"]);
    const result = run(["list"], { prwatch: true });
    expect(result.status, result.stderr).toBe(0);
    expect(calls()).toEqual(["prwatch status --json acme/widgets#7 acme/infra#12 acme/widgets#9 acme/widgets#404"]);
    expect(lines(result.stdout)).toEqual([
      `acme/widgets#7\tLLE-7\tagent-a\t${expected["acme/widgets#7"]}`,
      `acme/infra#12\tLLE-12\tagent-a\t${expected["acme/infra#12"]}`,
      `acme/widgets#9\tLLE-9\tagent-a\t${expected["acme/widgets#9"]}`,
      "acme/widgets#404\tLLE-404\tagent-a\tERROR acme/widgets#404 not found",
    ]);
  });

  it("falls back to gh per PR without prwatch, with identical lines", () => {
    addAll(["acme/widgets#404"]);
    const result = run(["list"]);
    expect(result.status, result.stderr).toBe(0);
    expect(calls().every((call) => call.startsWith("api graphql"))).toBe(true);
    expect(calls().length).toBe(4);
    expect(lines(result.stdout)).toEqual([
      `acme/widgets#7\tLLE-7\tagent-a\t${expected["acme/widgets#7"]}`,
      `acme/infra#12\tLLE-12\tagent-a\t${expected["acme/infra#12"]}`,
      `acme/widgets#9\tLLE-9\tagent-a\t${expected["acme/widgets#9"]}`,
      "acme/widgets#404\tLLE-404\tagent-a\tERROR Could not resolve to a PullRequest",
    ]);
  });
});

describe("pr-ledger.sh watch", () => {
  const watchLines = [
    `CHANGE acme/widgets#7 LLE-7 agent-a ${expected["acme/widgets#7"]}`,
    `CHANGE acme/infra#12 LLE-12 agent-a ${expected["acme/infra#12"]}`,
    "MERGED acme/widgets#9 LLE-9 agent-a 0123456789",
  ];

  it("uses one prwatch events stream across the ledger and prints the same events", () => {
    addAll(["acme/widgets#404"]);
    const result = run(["watch", "--interval", "1"], { prwatch: true, timeout: 4_000 });
    const out = lines(result.stdout);
    expect(out.slice(0, 4)).toEqual([...watchLines, "ERROR acme/widgets#404 acme/widgets#404 not found"]);
    // Repeats are suppressed: each event appears once however many passes ran.
    expect(new Set(out).size).toBe(out.length);
    // The merged PR left the ledger; the failing PR is not in the events stream.
    expect(readFileSync(join(wsDir, "prs.tsv"), "utf8")).not.toContain("acme/widgets\t9\t");
    const events = calls().filter((call) => call.startsWith("prwatch events"));
    expect(events.length).toBe(1);
    expect(events[0]).toBe("prwatch events --json --pr acme/infra#12 --pr acme/widgets#7");
    expect(calls().some((call) => call.startsWith("api graphql"))).toBe(false);
  });

  it("keeps taking status passes under a sustained event stream", () => {
    addAll();
    run(["watch", "--interval", "60"], { prwatch: true, timeout: 7_000, env: { FAKE_EVENT_BURST: "1" } });
    // Each burst is coalesced for at most ~2s, so ~7s of constant events still gives
    // several passes rather than one pass followed by an endless drain.
    const passes = calls().filter((call) => call.startsWith("prwatch status")).length;
    expect(passes).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it("falls back to gh polling without prwatch", () => {
    addAll();
    const result = run(["watch", "--interval", "1"], { timeout: 3_000 });
    expect(lines(result.stdout).slice(0, 3)).toEqual(watchLines);
    expect(calls().every((call) => call.startsWith("api graphql"))).toBe(true);
  });

  it("documents the prwatch backend in --help without needing WS_DIR", () => {
    const help = spawnSync("bash", [ledger, "--help"], { encoding: "utf8", env: { ...process.env, WS_DIR: "" } });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("prwatch events");
    expect(help.stdout).toContain("NO_PRWATCH=1");
  });
});

describe("prwatch guidance in PR-waiting skills", () => {
  const docs = [
    "skills/general/_shared/pr-readiness/PROTOCOL.md",
    "skills/general/babysit-pr/SKILL.md",
    "skills/general/yolo-ticket/SKILL.md",
    "skills/general/start-ticket/SKILL.md",
    "skills/lleverage/workstream/SKILL.md",
    "skills/lleverage/workstream/references/orchestration.md",
    "skills/lleverage/workstream/references/implementer-brief.md",
    "skills/lleverage/sweep/SKILL.md",
  ];

  it("tells agents to install prwatch and wait through it, not ad hoc gh loops", () => {
    for (const doc of docs) {
      const text = readFileSync(join(root, doc), "utf8").replace(/\s+/g, " ");
      expect(text, doc).toContain("npm i -g @tvdavies/prwatch");
      expect(text, doc).toMatch(/prwatch wait/);
      expect(text, doc).toMatch(/prwatch events/);
      expect(text, doc).toMatch(/never [^.`]*`gh pr view`/i);
      expect(text, doc).toContain("prwatch rate");
      expect(text, doc).toMatch(/REST/);
    }
  });

  it("keeps writes on gh and full-body reads in fetch-pr-blockers", () => {
    const protocol = readFileSync(join(root, "skills/general/_shared/pr-readiness/PROTOCOL.md"), "utf8").replace(/\s+/g, " ");
    expect(protocol).toContain("Writes still go through `gh` directly");
    expect(protocol).toContain("`fetch-pr-blockers.sh` is a one-shot read for a processing cycle, not a polling loop");
  });
});
