import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "../..");
const script = join(root, "skills/lleverage/linear-cli/scripts/start-issue.sh");
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

// Models the upstream bug: Changes Required is the first started state, while
// explicit state names are resolved exactly. No live CLI, API or git operations.
const fakeLinear = `#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['FAKE_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
scenario = os.environ['SCENARIO']
state_file = Path(os.environ['FAKE_STATE'])
states = [{'id': 'changes', 'name': 'Changes Required', 'type': 'started'},
          {'id': 'review', 'name': 'Technical Review', 'type': 'started'},
          {'id': 'progress', 'name': 'In Progress', 'type': 'started'}]
def value(flag):
    return args[args.index(flag) + 1] if flag in args else None
if args[:2] == ['api', 'query']:
    print(json.dumps({'data': {'viewer': {'id': None if scenario == 'no-viewer' else 'viewer-id'}}}))
elif args[:2] in (['issues', 'start'], ['issues', 'update']):
    if scenario == 'update-failure':
        print('simulated update failure', file=sys.stderr)
        sys.exit(7)
    if scenario == 'missing-state':
        states = [state for state in states if state['name'] != 'In Progress']
    wanted = value('--state')
    selected = next((state for state in states if state['name'] == wanted), None) if args[1] == 'update' else states[0]
    if selected is None:
        print('State not found for team', file=sys.stderr)
        sys.exit(1)
    issue = {'identifier': args[2], 'state': selected, 'assignee': {'id': 'viewer-id' if value('--assignee') == 'me' else 'other-user'}}
    state_file.write_text(json.dumps(issue))
    print(json.dumps({'identifier': args[2]}))
elif args[:2] == ['issues', 'get']:
    if scenario == 'get-failure':
        sys.exit(8)
    if scenario == 'malformed':
        print('not-json')
        sys.exit(0)
    issue = json.loads(state_file.read_text())
    if scenario == 'wrong-state': issue['state'] = states[0]
    if scenario == 'wrong-assignee': issue['assignee'] = {'id': 'other-user'}
    if scenario == 'unassigned': issue['assignee'] = None
    if scenario == 'wrong-issue': issue['identifier'] = 'TEAM-99'
    print(json.dumps(issue))
elif args[:2] == ['git', 'checkout']:
    print('mock checkout', file=sys.stderr)
else:
    sys.exit('Unexpected command')
`;

function run(args: string[], scenario = "ok") {
  const home = mkdtempSync(join(tmpdir(), "linear-start-"));
  temporary.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin);
  const log = join(home, "calls.jsonl");
  writeFileSync(log, "");
  writeFileSync(join(bin, "linear-cli"), fakeLinear, { mode: 0o755 });
  writeFileSync(join(bin, "git"), "#!/bin/sh\n[ \"$*\" = 'rev-parse --is-inside-work-tree' ] || exit 9\nprintf 'true\\n'\n", { mode: 0o755 });
  const result = spawnSync("bash", [script, ...args], {
    cwd: home,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      LINEAR_API_KEY: "fixture-not-a-real-key",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_LOG: log,
      FAKE_STATE: join(home, "state.json"),
      SCENARIO: scenario,
    },
  });
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return { result, calls };
}

const isCall = (call: string[], group: string, action: string) => call[0] === group && call[1] === action;

describe("Linear start wrapper", () => {
  it("documents the unsafe shortcut without recommending it as an executable command", () => {
    const skill = readFileSync(join(root, "skills/lleverage/linear-cli/SKILL.md"), "utf8");
    const commands = [...skill.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]).join("\n");
    expect(skill).toContain("Do **not** use `linear-cli issues start`");
    expect(commands).not.toContain("linear-cli issues start");
    expect(commands).toContain('--state "In Progress" --assignee me');
    expect(skill).toContain('state.name == "In Progress"');
  });

  it("selects exact In Progress despite other started states coming first, assigns me and verifies uncached", () => {
    const { result, calls } = run(["--no-branch", "--json", "team-42"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ identifier: "TEAM-42", state: { id: "progress", name: "In Progress" }, assignee: { id: "viewer-id" } });
    expect(calls.map((call) => call.slice(0, 2))).toEqual([["api", "query"], ["issues", "update"], ["issues", "get"]]);
    expect(calls[1]!.slice(2, 7)).toEqual(["TEAM-42", "--state", "In Progress", "--assignee", "me"]);
    for (const call of calls) {
      expect(call).toContain("--no-cache");
      expect(call).toContain("--compact");
      expect(call).toContain("--no-pager");
    }
    expect(result.stderr).toContain("Ready to work on TEAM-42");
  });

  it("checks out a branch only after successful readback, retaining human-readable output", () => {
    const { result, calls } = run(["TEAM-42"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("TEAM-42: In Progress, assigned to you.");
    expect(calls.at(-1)!.slice(0, 3)).toEqual(["git", "checkout", "TEAM-42"]);
  });

  for (const scenario of ["wrong-state", "wrong-assignee", "unassigned", "wrong-issue", "malformed", "get-failure", "update-failure", "missing-state", "no-viewer"]) {
    it(`stops without checkout or a success claim on ${scenario}`, () => {
      const { result, calls } = run(["--json", "TEAM-42"], scenario);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("Ready to work");
      expect(calls.some((call) => isCall(call, "git", "checkout"))).toBe(false);
      expect(calls.some((call) => isCall(call, "issues", "start"))).toBe(false);
      expect(calls.filter((call) => isCall(call, "issues", "update")).length).toBe(scenario === "no-viewer" ? 0 : 1);
    });
  }

  for (const args of [[], ["TEAM-42", "TEAM-43"], ["--schema"], ["https://linear.app/TEAM-42"], ["TEAM-42 extra"]]) {
    it(`rejects invalid targeting before any API call: ${JSON.stringify(args)}`, () => {
      const { result, calls } = run(args);
      expect(result.status).not.toBe(0);
      expect(calls).toEqual([]);
    });
  }
});
