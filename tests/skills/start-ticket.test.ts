import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");
const skillPath = join(root, "skills/general/start-ticket/SKILL.md");
const openAiPath = join(root, "skills/general/start-ticket/agents/openai.yaml");
const scriptPath = join(root, "skills/general/start-ticket/scripts/get-ticket.sh");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runLookup(input: string, scenario: "direct" | "fallback" | "mismatch") {
  const dir = mkdtempSync(join(tmpdir(), "start-ticket-test-"));
  tempDirs.push(dir);
  const binDir = join(dir, "bin");
  const logPath = join(dir, "linear.log");
  mkdirSync(binDir);
  const fakeLinear = join(binDir, "linear-cli");
  writeFileSync(
    fakeLinear,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_LINEAR_LOG"
if [[ "$1 $2" == "issues get" ]]; then
  if [[ "$FAKE_LINEAR_SCENARIO" == "direct" ]]; then
    printf '%s\\n' '{"id":"issue-id","identifier":"TEAM-11972","title":"Replay"}'
    exit 0
  fi
  echo 'Entity not found: Issue' >&2
  exit 1
fi
if [[ "$1 $2" == "api query" ]]; then
  if [[ "$FAKE_LINEAR_SCENARIO" == "mismatch" ]]; then
    printf '%s\\n' '{"data":{"issues":{"nodes":[{"id":"other","identifier":"TEAM-11971"}]}}}'
  else
    printf '%s\\n' '{"data":{"issues":{"nodes":[{"id":"issue-id","identifier":"TEAM-11972","title":"Replay"}]}}}'
  fi
  exit 0
fi
exit 1
`,
  );
  chmodSync(fakeLinear, 0o755);

  const result = spawnSync("bash", [scriptPath, input], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      FAKE_LINEAR_LOG: logPath,
      FAKE_LINEAR_SCENARIO: scenario,
    },
  });
  const log = (() => {
    try {
      return readFileSync(logPath, "utf8");
    } catch {
      return "";
    }
  })();
  return { result, log };
}

describe("start-ticket skill", () => {
  it("is explicit-only and defines the end-to-end delivery contract", () => {
    const skill = readFileSync(skillPath, "utf8");
    const openAi = readFileSync(openAiPath, "utf8");

    expect(skill).toContain("name: start-ticket");
    expect(skill).toContain("disable-model-invocation: true");
    expect(openAi).toContain("allow_implicit_invocation: false");
    expect(skill).toContain("move it to **In Progress**");
    expect(skill).toContain("Never edit the user's main checkout");
    expect(skill).toContain("Do not launch a workflow merely for confidence");
    expect(skill).toContain("$SKILL_DIR/../pr-review/SKILL.md");
    expect(skill).toContain("Do not invoke the full multi-agent review for routine tickets");
    expect(skill).toContain("READY TO MERGE");
    expect(skill).toContain("If no change is warranted");
  });

  it("normalises and returns an exact direct Linear lookup", () => {
    const { result, log } = runLookup("team-11972", "direct");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).identifier).toBe("TEAM-11972");
    expect(log).toContain("issues get --comments --retry 3 --no-cache");
    expect(log).toContain("-- TEAM-11972");
  });

  it("uses the exact team and issue-number fallback", () => {
    const { result, log } = runLookup("TEAM-11972", "fallback");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).identifier).toBe("TEAM-11972");
    expect(log).toContain("api query");
    expect(log).toContain("number=11972");
    expect(log).toContain("teamKey=TEAM");
  });

  it("rejects invalid and non-matching identifiers", () => {
    const invalid = runLookup("--schema", "direct");
    expect(invalid.result.status).toBe(2);
    expect(invalid.result.stderr).toContain("Invalid Linear issue identifier");
    expect(invalid.log).toBe("");

    const mismatch = runLookup("TEAM-11972", "mismatch");
    expect(mismatch.result.status).toBe(1);
    expect(mismatch.result.stderr).toContain("Exact identifier fallback also failed");
  });
});
