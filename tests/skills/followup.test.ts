import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const followup = path.join(root, "skills/lleverage/workstream/scripts/followup.sh");

// A linear-cli stand-in: answers the queries followup.sh makes and records each mutation's input.
const fake = `#!/usr/bin/env bash
set -euo pipefail
kind="$2"; q="$3"; shift 3
vars=()
while [ "$#" -gt 0 ]; do case "$1" in -v) vars+=("$2"); shift 2 ;; *) shift ;; esac; done
case "$kind:$q" in
  query:*searchIssues*) echo '{"data":{"searchIssues":{"nodes":[]}}}' ;;
  query:*viewer*) echo '{"data":{"viewer":{"id":"me"},"teams":{"nodes":[{"id":"team-lle","states":{"nodes":[{"id":"st-triage","name":"Triage"},{"id":"st-todo","name":"To Do"}]}}]},"cycles":{"nodes":[{"id":"cy","number":7,"startsAt":"2026-10-01","endsAt":"2026-10-15","isActive":true}]}}}' ;;
  query:*issueLabels*)
    case "\${vars[0]}" in
      n=Sal) echo '{"data":{"issueLabels":{"nodes":[{"id":"e663c5c3-b033-4953-9849-d0adf1829ddc","team":null}]}}}' ;;
      *) echo '{"data":{"issueLabels":{"nodes":[]}}}' ;;
    esac ;;
  mutate:*issueCreate*)
    jq -c . <<<"\${vars[0]#input=}" >> "$FAKE_LOG"
    echo '{"data":{"issueCreate":{"success":true,"issue":{"identifier":"LLE-1","url":"u","cycle":null,"state":{"name":"Triage"}}}}}' ;;
  *) echo "unexpected $kind" >&2; exit 1 ;;
esac
`;

function run(args: string[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "followup-"));
  try {
    writeFileSync(path.join(dir, "linear-cli"), fake);
    chmodSync(path.join(dir, "linear-cli"), 0o755);
    const log = path.join(dir, "created.jsonl");
    writeFileSync(log, "");
    const result = spawnSync("bash", [followup, ...args], {
      env: { PATH: `${dir}:${process.env.PATH}`, FAKE_LOG: log, HOME: dir },
      encoding: "utf8",
    });
    const created = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { status: result.status, stderr: result.stderr, created };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("followup.sh labels", () => {
  test("a label name resolves to the workspace label and is passed to issueCreate", () => {
    const result = run(["--triage", "-p", "2", "-l", "Sal", "session-service cannot publish agent activity"]);
    expect(result.status).toBe(0);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({ stateId: "st-triage", priority: 2, labelIds: ["e663c5c3-b033-4953-9849-d0adf1829ddc"] });
  });

  test("a label id is used as is", () => {
    const result = run(["--triage", "--label", "e663c5c3-b033-4953-9849-d0adf1829ddc", "PostHog capture silent"]);
    expect(result.status).toBe(0);
    expect(result.created[0].labelIds).toEqual(["e663c5c3-b033-4953-9849-d0adf1829ddc"]);
  });

  test("an unknown label creates nothing", () => {
    const result = run(["--triage", "-l", "Nope", "Some bug"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("label Nope not found");
    expect(result.created).toHaveLength(0);
  });

  test("without a label no labelIds are sent", () => {
    const result = run(["--triage", "Another bug"]);
    expect(result.status).toBe(0);
    expect(result.created[0].labelIds).toBeUndefined();
  });
});
