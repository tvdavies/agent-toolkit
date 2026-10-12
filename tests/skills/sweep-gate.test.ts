import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const gate = path.join(root, "skills/lleverage/sweep/scripts/sweep-gate.sh");

type Issue = Record<string, unknown>;
type Task = { id: string; title: string; status: string; assignee: string; labels?: string[]; updated_at?: string };

const issue = (id: string, extra: Issue = {}): Issue => ({
  id,
  title: `Ticket ${id}`,
  url: `https://linear.app/x/issue/${id}`,
  priority: 3,
  estimate: null,
  state: "To Do",
  stateType: "unstarted",
  verdict: "eligible",
  assignee: null,
  assignedToMe: false,
  openAncestor: false,
  size: null,
  prepared: null,
  ...extra,
});
const ready = (id: string, extra: Issue = {}) => issue(id, { size: "S", prepared: "Ready", ...extra });
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "sweep-gate-"));
  mkdirSync(path.join(dir, "workspace"));
  mkdirSync(path.join(dir, "bin"));
  // Stand-ins: the queue prints $FAKE_QUEUE; docket prints $FAKE_TASKS.
  writeFileSync(path.join(dir, "queue.sh"), '#!/usr/bin/env bash\necho "$*" > "$FAKE_ARGS"\ncat "$FAKE_QUEUE"\n');
  writeFileSync(path.join(dir, "bin", "docket"), '#!/usr/bin/env bash\ncat "$FAKE_TASKS"\n');
  chmodSync(path.join(dir, "queue.sh"), 0o755);
  chmodSync(path.join(dir, "bin", "docket"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(issues: Issue[], tasks: Task[] = [], args: string[] = []) {
  writeFileSync(path.join(dir, "queue.jsonl"), issues.map((i) => JSON.stringify(i)).join("\n") + "\n");
  writeFileSync(path.join(dir, "tasks.json"), JSON.stringify(tasks.map((t) => ({ labels: [], updated_at: now(), ...t }))));
  const result = spawnSync("bash", [gate, "--state", path.join(dir, "state.json"), "--docket", path.join(dir, "workspace"), ...args], {
    env: {
      PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
      HOME: dir,
      SWEEP_QUEUE: path.join(dir, "queue.sh"),
      FAKE_QUEUE: path.join(dir, "queue.jsonl"),
      FAKE_TASKS: path.join(dir, "tasks.json"),
      FAKE_ARGS: path.join(dir, "args"),
    },
    encoding: "utf8",
  });
  const out = result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
  return { status: result.status, out, stderr: result.stderr };
}

describe("sweep-gate", () => {
  test("ready tickets start a delivery sweep of at most five, best first, from the whole team's cycle", () => {
    const issues = [ready("LLE-7", { priority: 0 }), ready("LLE-6"), ready("LLE-5", { priority: 1 }), ready("LLE-4"), ready("LLE-3", { size: "M" }), ready("LLE-2"), issue("LLE-1")];
    const result = run(issues);
    expect(result.status).toBe(3);
    const [finding] = result.out.findings;
    expect(finding.mode).toBe("deliver");
    expect(finding.key).toMatch(/^cycle-sweep:deliver:[0-9a-f]{12}$/);
    expect(finding.tickets.map((t: Issue) => t.id)).toEqual(["LLE-5", "LLE-2", "LLE-4", "LLE-6", "LLE-3"]);
    expect(readFileSync(path.join(dir, "args"), "utf8")).toContain("--all-assignees");
  });

  test("ineligible tickets are never picked", () => {
    const issues = [
      ready("LLE-10", { verdict: "has-pr" }),
      ready("LLE-11", { verdict: "claimed" }),
      ready("LLE-12", { openAncestor: true }),
      ready("LLE-13", { assignee: "Alex", assignedToMe: false }),
      ready("LLE-14", { size: "L" }),
      ready("LLE-15", { stateType: "started", state: "Human Required", verdict: "started" }),
      ready("LLE-16", { stateType: "triage", state: "Triage" }),
      ready("LLE-17", { assignee: "Tom Davies", assignedToMe: true }),
    ];
    const result = run(issues);
    expect(result.status).toBe(3);
    expect(result.out.findings[0].tickets.map((t: Issue) => t.id)).toEqual(["LLE-17"]);
  });

  test("tickets an open Docket task already names are taken", () => {
    const tasks = [{ id: "TASK-1", title: "Fix forward LLE-20: thing", status: "in-progress", assignee: "sal" }];
    const result = run([ready("LLE-20"), ready("LLE-21")], tasks);
    expect(result.out.findings[0].tickets.map((t: Issue) => t.id)).toEqual(["LLE-21"]);
  });

  test("a sweep in flight holds the next one", () => {
    const tasks = [{ id: "TASK-2", title: "Cycle sweep: deliver LLE-30", status: "ready", assignee: "worker" }];
    const result = run([ready("LLE-31")], tasks);
    expect(result.status).toBe(0);
    expect(result.out.reason).toContain("a sweep is in flight: TASK-2");
  });

  test("a stale sweep task no longer holds the next sweep, but its ticket stays taken", () => {
    const old = new Date(Date.now() - 13 * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
    const tasks = [{ id: "TASK-3", title: "Cycle sweep: deliver LLE-40", status: "in-progress", assignee: "worker", updated_at: old }];
    const result = run([ready("LLE-40"), ready("LLE-41")], tasks);
    expect(result.status).toBe(3);
    expect(result.out.findings[0].tickets.map((t: Issue) => t.id)).toEqual(["LLE-41"]);
  });

  test("an open Urgent incident holds every sweep", () => {
    const tasks = [{ id: "TASK-4", title: "Production watch", status: "in-progress", assignee: "sal", labels: ["urgent"] }];
    const result = run([ready("LLE-50")], tasks);
    expect(result.status).toBe(0);
    expect(result.out.reason).toContain("Urgent incident is open (TASK-4)");
  });

  test("an incident labelled before the rename (sev1) holds every sweep too; a High one does not", () => {
    const tasks = [
      { id: "TASK-5", title: "Production watch", status: "in-progress", assignee: "sal", labels: ["sev1"] },
      { id: "TASK-6", title: "Production watch", status: "in-progress", assignee: "sal", labels: ["high"] },
    ];
    const result = run([ready("LLE-51")], tasks);
    expect(result.status).toBe(0);
    expect(result.out.reason).toContain("Urgent incident is open (TASK-5)");
    expect(result.out.reason).not.toContain("TASK-6");
  });

  test("with nothing ready, unready tickets go to prepare once; the same set waits for a change", () => {
    const issues = [issue("LLE-60"), issue("LLE-61", { size: "S", prepared: "Needs decision" }), issue("LLE-62", { size: "M" })];
    const first = run(issues);
    expect(first.status).toBe(3);
    expect(first.out.findings[0].mode).toBe("prepare");
    expect(first.out.findings[0].tickets.map((t: Issue) => t.id)).toEqual(["LLE-61", "LLE-62", "LLE-60"]);
    const fingerprint = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).idleFingerprint;
    expect(first.out.findings[0].key).toBe(`cycle-sweep:prepare:${fingerprint}`);

    const again = run(issues);
    expect(again.status).toBe(0);
    expect(again.out.reason).toContain("unchanged since the last sweep");

    const changed = run([...issues, issue("LLE-63")]);
    expect(changed.status).toBe(3);
    expect(changed.out.findings[0].key).not.toBe(first.out.findings[0].key);
  });

  test("tickets a recent sweep prepared are not prepared again", () => {
    const tasks = [{ id: "TASK-5", title: "Cycle sweep: prepare LLE-70", status: "done", assignee: "sal" }];
    const result = run([issue("LLE-70"), issue("LLE-71")], tasks);
    expect(result.out.findings[0].tickets.map((t: Issue) => t.id)).toEqual(["LLE-71"]);
    const only = run([issue("LLE-70")], tasks);
    expect(only.status).toBe(0);
    expect(only.out.reason).toContain("nothing to work on");
  });

  test("a dry run records no fingerprint", () => {
    const result = run([issue("LLE-80")], [], ["--dry-run"]);
    expect(result.status).toBe(3);
    expect(existsSync(path.join(dir, "state.json"))).toBe(false);
  });

  test("nothing eligible: nothing to work on", () => {
    const result = run([issue("LLE-90", { verdict: "started", stateType: "started" })]);
    expect(result.status).toBe(0);
    expect(result.out.reason).toBe("nothing to work on: no eligible ticket is ready or left to prepare");
  });

  test("a queue that fails is a failed run, not a quiet one", () => {
    writeFileSync(path.join(dir, "queue.sh"), "#!/usr/bin/env bash\necho boom >&2\nexit 2\n");
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("linear-queue.sh failed: boom");
  });
});
