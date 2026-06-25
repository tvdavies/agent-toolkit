/**
 * Control-plane additions to the worker pool: taskState (the live activity a task
 * is in) and stopTask (a human override that kills/dequeues/un-parks without the
 * normal failure lifecycle). Mirrors the harness in worker-pool.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAllParked, writeParkRequest } from "../extensions/lib/park";
import type { Trigger } from "./inbox";
import type { TaduControl } from "./tadu-control";
import type { PreparedWorktree } from "./worktree";
import { type PoolDecision, type WorkerPoolOptions, WorkerPool, type WorkerRunner, type WorktreeProvider } from "./worker-pool";
import type { WorkerResult, WorkerSpec } from "./worker";

const flush = () => new Promise((r) => setTimeout(r, 0));

type Pending = { spec: WorkerSpec; resolve: (r: WorkerResult) => void; killed: boolean };
let pendings: Pending[];
let moves: Array<[string, string]>;
let comments: Array<[string, string]>;
let decisions: PoolDecision[];
let escalations: string[];
let ids: number;
let stateDir: string;
let clock: number;

const runner: WorkerRunner = (spec) => {
	let resolve!: (r: WorkerResult) => void;
	const done = new Promise<WorkerResult>((res) => {
		resolve = res;
	});
	const p: Pending = { spec, resolve, killed: false };
	pendings.push(p);
	return { id: spec.id, kill: () => { p.killed = true; }, done };
};
const tadu: TaduControl = {
	move: (id, s) => { moves.push([id, s]); return true; },
	comment: (id, t) => { comments.push([id, t]); return true; },
};
const okResult = (spec: WorkerSpec): WorkerResult => ({ id: spec.id, taskId: spec.taskId, ok: true, code: 0, signal: null, outputText: "done", errorText: "", timedOut: false });
const killedResult = (spec: WorkerSpec): WorkerResult => ({ id: spec.id, taskId: spec.taskId, ok: false, code: null, signal: "SIGTERM", errorText: "killed", outputText: "", timedOut: false });
const trig = (taskId?: string): Trigger => ({ id: `t-${taskId ?? "x"}`, text: `work ${taskId ?? ""}`.trim(), taduTask: taskId });

function pool(maxConcurrent: number, extra: Partial<WorkerPoolOptions> = {}): WorkerPool {
	return new WorkerPool({
		maxConcurrent,
		sessionDir: "/tmp/sessions",
		cwd: "/tmp/cwd",
		piBin: "pi",
		stateDir,
		runner,
		tadu,
		newId: () => `w${++ids}`,
		now: () => clock,
		parkPollMs: 0,
		onDecision: (d) => decisions.push(d),
		onEscalate: (s) => escalations.push(s),
		...extra,
	});
}

beforeEach(() => {
	pendings = [];
	moves = [];
	comments = [];
	decisions = [];
	escalations = [];
	ids = 0;
	clock = 1_000_000;
	stateDir = mkdtempSync(join(tmpdir(), "pool-ctl-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("taskState", () => {
	it("reports running, queued, and none", () => {
		const p = pool(1);
		p.dispatch(trig("TASK-1")); // starts (running)
		p.dispatch(trig("TASK-2")); // queued
		expect(p.taskState("TASK-1")).toBe("running");
		expect(p.taskState("TASK-2")).toBe("queued");
		expect(p.taskState("TASK-9")).toBe("none");
	});

	it("reports parked and awaiting-human", async () => {
		const p = pool(1);
		p.dispatch(trig("TASK-1"));
		const spec = pendings[0]!.spec;
		// Plain park (timer-based): dormant, not awaiting an answer.
		writeParkRequest(stateDir, { runId: spec.id, dueAt: clock + 60_000, prompt: "recheck" });
		pendings[0]!.resolve(okResult(spec));
		await flush();
		expect(p.taskState("TASK-1")).toBe("parked");

		const p2 = pool(1);
		p2.dispatch(trig("TASK-2"));
		const spec2 = pendings[1]!.spec;
		writeParkRequest(stateDir, { runId: spec2.id, dueAt: clock + 60_000, prompt: "blocked", awaitingAnswer: true, question: "which?" });
		pendings[1]!.resolve(okResult(spec2));
		await flush();
		expect(p2.taskState("TASK-2")).toBe("awaiting-human");
	});
});

describe("activitySnapshot, stats, wasManaged (live board)", () => {
	it("reports per-task activity with the worker run id", () => {
		const p = pool(1);
		p.dispatch(trig("TASK-1")); // running
		p.dispatch(trig("TASK-2")); // queued
		const snap = p.activitySnapshot();
		expect(snap["TASK-1"]?.state).toBe("running");
		expect(snap["TASK-1"]?.runId).toBeTruthy();
		expect(snap["TASK-2"]?.state).toBe("queued");
		expect(snap["TASK-9"]).toBeUndefined(); // unknown task = no activity (none)
	});

	it("counts active/queued/parked/awaiting", async () => {
		const p = pool(1);
		p.dispatch(trig("TASK-1"));
		p.dispatch(trig("TASK-2"));
		let s = p.stats();
		expect(s).toMatchObject({ active: 1, queued: 1, parked: 0, awaiting: 0 });

		// Park TASK-1 → TASK-2 promotes to running; parked count reflects the dormant one.
		const spec = pendings[0]!.spec;
		writeParkRequest(stateDir, { runId: spec.id, dueAt: clock + 60_000, prompt: "x" });
		pendings[0]!.resolve(okResult(spec));
		await flush();
		s = p.stats();
		expect(s.parked).toBe(1);
		expect(p.activitySnapshot()["TASK-1"]?.state).toBe("parked");
	});

	it("clears activity when a task finishes", async () => {
		const p = pool(1);
		p.dispatch(trig("TASK-1"));
		expect(p.activitySnapshot()["TASK-1"]?.state).toBe("running");
		pendings[0]!.resolve(okResult(pendings[0]!.spec));
		await flush();
		expect(p.taskState("TASK-1")).toBe("none");
		expect(p.activitySnapshot()["TASK-1"]).toBeUndefined();
	});
});

describe("stopTask", () => {
	it("kills a running worker and suppresses the failed→blocked lifecycle", async () => {
		const p = pool(1);
		p.dispatch(trig("TASK-1"));
		expect(p.taskState("TASK-1")).toBe("running");

		expect(p.stopTask("TASK-1", "human moved to blocked")).toBe(true);
		expect(pendings[0]!.killed).toBe(true);
		// The killed process dies → finish() runs the cancel path.
		pendings[0]!.resolve(killedResult(pendings[0]!.spec));
		await flush();

		expect(moves).not.toContainEqual(["TASK-1", "blocked"]); // no failure move
		expect(escalations).toHaveLength(0); // no escalation
		expect(decisions.some((d) => d.kind === "control-stop")).toBe(true);
		expect(p.taskState("TASK-1")).toBe("none"); // released — can be re-dispatched
	});

	it("can re-dispatch a task after stopping its running worker", async () => {
		const p = pool(1);
		p.dispatch(trig("TASK-1"));
		p.stopTask("TASK-1", "x");
		pendings[0]!.resolve(killedResult(pendings[0]!.spec));
		await flush();
		p.dispatch(trig("TASK-1"));
		expect(p.taskState("TASK-1")).toBe("running");
		expect(pendings).toHaveLength(2);
	});

	it("drops a queued task without starting it", async () => {
		const p = pool(1);
		p.dispatch(trig("TASK-1")); // running
		p.dispatch(trig("TASK-2")); // queued
		expect(p.stopTask("TASK-2", "human moved to backlog")).toBe(true);
		expect(p.queuedCount()).toBe(0);
		expect(p.taskState("TASK-2")).toBe("none");
		// Finishing TASK-1 must not start the dropped TASK-2.
		pendings[0]!.resolve(okResult(pendings[0]!.spec));
		await flush();
		expect(pendings).toHaveLength(1);
	});

	it("un-parks a dormant session and clears it from disk", async () => {
		const p = pool(1);
		p.dispatch(trig("TASK-1"));
		const spec = pendings[0]!.spec;
		writeParkRequest(stateDir, { runId: spec.id, dueAt: clock + 60_000, prompt: "recheck" });
		pendings[0]!.resolve(okResult(spec));
		await flush();
		expect(p.taskState("TASK-1")).toBe("parked");

		expect(p.stopTask("TASK-1", "human moved to done")).toBe(true);
		expect(p.parkedCount()).toBe(0);
		expect(p.taskState("TASK-1")).toBe("none");
		expect(readAllParked(stateDir)).toEqual([]);
	});

	it("returns false when there is nothing to stop", () => {
		const p = pool(1);
		expect(p.stopTask("TASK-404", "nothing")).toBe(false);
	});

	it("preserves worktree changes when a human stops a running worker", async () => {
		const prepared: PreparedWorktree = {
			cwd: "/wt/1",
			isolated: true,
			branch: "worker/w1",
			path: "/wt/1",
			finalize: () => ({ isolated: true, changed: true, removed: false, path: "/wt/1", branch: "worker/w1" }),
		};
		const worktree: WorktreeProvider = () => prepared;
		const p = pool(1, { worktree });
		p.dispatch(trig("TASK-1"));
		p.stopTask("TASK-1", "human took over");
		pendings[0]!.resolve(killedResult(pendings[0]!.spec));
		await flush();
		expect(comments.some(([id, text]) => id === "TASK-1" && /changes left in worktree/.test(text))).toBe(true);
	});

	it("preserves worktree changes when a human stops a PARKED worker", async () => {
		let finalized = 0;
		const prepared: PreparedWorktree = {
			cwd: "/wt/2",
			isolated: true,
			branch: "worker/w1",
			path: "/wt/2",
			finalize: () => {
				finalized += 1;
				return { isolated: true, changed: true, removed: false, path: "/wt/2", branch: "worker/w1" };
			},
		};
		const p = pool(1, { worktree: () => prepared });
		p.dispatch(trig("TASK-1"));
		const spec = pendings[0]!.spec;
		writeParkRequest(stateDir, { runId: spec.id, dueAt: clock + 60_000, prompt: "recheck" });
		pendings[0]!.resolve(okResult(spec));
		await flush();
		expect(p.taskState("TASK-1")).toBe("parked");

		expect(p.stopTask("TASK-1", "human moved to done")).toBe(true);
		expect(finalized).toBe(1); // the parked worktree was finalised, not orphaned
		expect(comments.some(([id, text]) => id === "TASK-1" && /changes left in worktree/.test(text))).toBe(true);
		expect(readAllParked(stateDir)).toEqual([]);
	});
});
