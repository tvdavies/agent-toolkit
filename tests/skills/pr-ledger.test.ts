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
  mergeState?: string;
  auto?: boolean;
  merge?: string | null;
  // What prwatch (0.1.6 on) reports for this state; the gh fallback must agree.
  reasons: string[];
};

const prs: Record<string, PrState> = {
  "acme/widgets#7": {
    state: "OPEN",
    ci: "FAILURE",
    review: "CHANGES_REQUESTED",
    changesBy: ["bob"],
    unresolved: 1,
    reasons: ["check_failed", "changes_requested", "unresolved_threads"],
  },
  "acme/infra#12": { state: "OPEN", ci: "SUCCESS", review: "APPROVED", reasons: ["ready_auto_merge_off"] },
  "acme/widgets#9": { state: "MERGED", ci: "SUCCESS", review: "APPROVED", merge: "0123456789abcdef", reasons: [] },
};

// Classification edges, read by the "need= follows prwatch's reasons" tests only.
const edges: Record<string, PrState> = {
  // No required review, so no review decision, but a reviewer asked for changes.
  "acme/infra#13": { state: "OPEN", ci: "SUCCESS", review: null, changesBy: ["dave"], reasons: ["changes_requested", "ready_auto_merge_off"] },
  // Approved and green, but GitHub still blocks the merge (a required check never reported).
  "acme/widgets#11": { state: "OPEN", ci: "SUCCESS", review: "APPROVED", mergeState: "BLOCKED", reasons: ["merge_blocked"] },
  // The same just after a push: no checks yet, so not (yet) blocked by anything unseen.
  "acme/widgets#14": { state: "OPEN", review: "APPROVED", mergeState: "BLOCKED", reasons: [] },
  // Drafts stay with their implementer.
  "acme/widgets#12": { state: "OPEN", isDraft: true, ci: "FAILURE", reasons: ["check_failed"] },
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
          mergeStateStatus: p.mergeState ?? "CLEAN",
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
    mergeStateStatus: p.mergeState ?? "CLEAN",
    autoMerge: { enabled: p.auto ?? false, method: null },
    reviewDecision: p.review ?? null,
    reviews: (p.changesBy ?? []).map((author) => ({ author, state: "CHANGES_REQUESTED" })).concat([{ author: "carol", state: "APPROVED" }]),
    threads: { total: (p.unresolved ?? 0) + 1, unresolved: p.unresolved ?? 0, items: [] },
    checks: { state: p.ci ?? "NONE", total: 0, contexts: [] },
    comments: { total: 0, recent: [] },
    needsAction: p.reasons.length > 0,
    reasons: p.reasons,
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

  for (const [ref, p] of Object.entries({ ...prs, ...edges })) {
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

  const snapshots = Object.entries({ ...prs, ...edges }).map(([ref, p]) => prwatchSnapshot(ref, p));
  writeFileSync(join(temp, "status.json"), JSON.stringify(snapshots, null, 2));
  writeFileSync(
    join(prwatchBin, "prwatch"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'prwatch %s\\n' "$*" >> "$FAKE_LOG"
case "\${1:-}" in
  status)
    shift; shift
    # Like prwatch, one unparseable reference is a usage error for the whole call.
    for ref in "$@"; do
      [[ "$ref" =~ ^[^/#]+/[^/#]+#[0-9]+$ ]] || { echo "prwatch: unrecognised PR reference \"$ref\"" >&2; exit 2; }
    done
    # Simulates a batch-level failure (rate limit, daemon restart) for multi-PR calls.
    if [ -n "\${FAKE_BATCH_FAIL:-}" ] && [ "$#" -gt 1 ]; then echo "prwatch: temporary error" >&2; exit 1; fi
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

describe("pr-ledger.sh need= follows prwatch's reasons", () => {
  const edgeLines = [
    "acme/infra#13\tLLE-13\tagent-a\tstate=OPEN head=abc12345 ci=SUCCESS review=NONE changes-by=dave threads=0 mergeable=MERGEABLE auto=off need=changes-requested",
    "acme/widgets#11\tLLE-11\tagent-a\tstate=OPEN head=abc12345 ci=SUCCESS review=APPROVED threads=0 mergeable=MERGEABLE auto=off need=merge-blocked",
    "acme/widgets#14\tLLE-14\tagent-a\tstate=OPEN head=abc12345 ci=NONE review=APPROVED threads=0 mergeable=MERGEABLE auto=off need=none",
    "acme/widgets#12\tLLE-12\tagent-a\tstate=OPEN head=abc12345 ci=FAILURE review=NONE threads=0 mergeable=MERGEABLE auto=off draft need=none",
  ];
  function addEdges() {
    for (const ref of Object.keys(edges)) {
      const [repo, n] = ref.split("#");
      expect(run(["add", repo!, n!, `LLE-${n}`, "agent-a"]).status).toBe(0);
    }
  }

  it("maps the first reason, and the gh fallback works out the same reasons", () => {
    addEdges();
    const viaPrwatch = run(["list"], { prwatch: true });
    expect(viaPrwatch.status, viaPrwatch.stderr).toBe(0);
    expect(lines(viaPrwatch.stdout)).toEqual(edgeLines);
    const viaGh = run(["list"]);
    expect(viaGh.status, viaGh.stderr).toBe(0);
    expect(lines(viaGh.stdout)).toEqual(edgeLines);
  });

  it("passes a reason it doesn't know through, so it still needs action", () => {
    const status = join(temp, "status.json");
    const snapshots = JSON.parse(readFileSync(status, "utf8"));
    for (const s of snapshots) if (s.pr === "acme/widgets#11") s.reasons = ["merge_queue_failed"];
    writeFileSync(status, JSON.stringify(snapshots));
    expect(run(["add", "acme/widgets", "11", "LLE-11", "agent-a"]).status).toBe(0);
    const result = run(["list"], { prwatch: true });
    expect(lines(result.stdout)).toEqual([edgeLines[1]!.replace("need=merge-blocked", "need=merge-queue-failed")]);
  });
});

describe("pr-ledger.sh ledger rows", () => {
  it("refuses to add a malformed repository or PR number", () => {
    for (const args of [["440", "infrastructure", "LLE-1"], ["acme/widgets", "x7", "LLE-1"], ["acme", "7", "LLE-1"]]) {
      const result = run(["add", ...args]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("OWNER/REPO");
    }
    expect(readFileSync(join(wsDir, "prs.tsv"), "utf8")).toBe("");
  });

  it("reports a hand-edited malformed row on its own and still reads the others", () => {
    addAll();
    writeFileSync(join(wsDir, "prs.tsv"), readFileSync(join(wsDir, "prs.tsv"), "utf8") + "440\tinfrastructure\tLLE-1\tnote\n");
    const result = run(["list"], { prwatch: true });
    expect(result.status, result.stderr).toBe(0);
    expect(calls()).toEqual(["prwatch status --json acme/widgets#7 acme/infra#12 acme/widgets#9"]);
    expect(lines(result.stdout)).toEqual([
      `acme/widgets#7\tLLE-7\tagent-a\t${expected["acme/widgets#7"]}`,
      `acme/infra#12\tLLE-12\tagent-a\t${expected["acme/infra#12"]}`,
      `acme/widgets#9\tLLE-9\tagent-a\t${expected["acme/widgets#9"]}`,
      "440#infrastructure\tLLE-1\tnote\tERROR malformed ledger row; re-add it with: pr-ledger.sh add OWNER/REPO PR TICKET",
    ]);
  });

  it("reads PRs one at a time when the batched prwatch call fails", () => {
    addAll();
    const result = run(["list"], { prwatch: true, env: { FAKE_BATCH_FAIL: "1" } });
    expect(result.status, result.stderr).toBe(0);
    expect(lines(result.stdout)).toEqual([
      `acme/widgets#7\tLLE-7\tagent-a\t${expected["acme/widgets#7"]}`,
      `acme/infra#12\tLLE-12\tagent-a\t${expected["acme/infra#12"]}`,
      `acme/widgets#9\tLLE-9\tagent-a\t${expected["acme/widgets#9"]}`,
    ]);
  });

  it("watch reports a malformed row once and keeps watching the valid PRs", () => {
    addAll();
    writeFileSync(join(wsDir, "prs.tsv"), readFileSync(join(wsDir, "prs.tsv"), "utf8") + "440\tinfrastructure\tLLE-1\tnote\n");
    const result = run(["watch", "--interval", "1"], { prwatch: true, timeout: 4_000 });
    const out = lines(result.stdout);
    expect(out).toContain(`CHANGE acme/infra#12 LLE-12 agent-a ${expected["acme/infra#12"]}`);
    expect(out.filter((l) => l.startsWith("ERROR 440#infrastructure")).length).toBe(1);
    const events = calls().filter((call) => call.startsWith("prwatch events"));
    expect(events[0]).toBe("prwatch events --json --pr acme/infra#12 --pr acme/widgets#7");
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
