import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAnswers, writeAnswer, writeParkRequest } from "../extensions/lib/park";
import type { Trigger } from "./inbox";
import type { TaduControl } from "./tadu-control";
import { type PoolDecision, type WorkerPoolOptions, WorkerPool, type WorkerRunner } from "./worker-pool";
import type { WorkerResult, WorkerSpec } from "./worker";

// Flush the microtask chain (resolve → then(finish) → finally(pump)).
const flush = () => new Promise((r) => setTimeout(r, 0));

type Pending = { spec: WorkerSpec; resolve: (r: WorkerResult) => void; killed: boolean };
let pendings: Pending[];
let moves: Array<[string, string]>;
let comments: Array<[string, string]>;
let decisions: PoolDecision[];
let escalations: string[];
let needsHuman: Array<{ question: string; runId: string; taskId?: string }>;
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
const okResult = (spec: WorkerSpec, output = "did it"): WorkerResult => ({
	id: spec.id, taskId: spec.taskId, ok: true, code: 0, signal: null, outputText: output, errorText: "", timedOut: false,
});
const failResult = (spec: WorkerSpec, code = 1): WorkerResult => ({
	id: spec.id, taskId: spec.taskId, ok: false, code, signal: null, outputText: "", errorText: "boom", timedOut: false,
});
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
		parkPollMs: 0, // tests drive checkParked() manually
		onDecision: (d) => decisions.push(d),
		onEscalate: (s) => escalations.push(s),
		onNeedsHuman: (info) => needsHuman.push(info),
		...extra,
	});
}

beforeEach(() => {
	pendings = [];
	moves = [];
	comments = [];
	decisions = [];
	escalations = [];
	needsHuman = [];
	ids = 0;
	clock = 1_000_000;
	stateDir = mkdtempSync(join(tmpdir(), "pool-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("WorkerPool", () => {
	it("runs up to maxConcurrent and queues the rest", async () => {
		const p = pool(2);
		p.dispatch(trig("TASK-1"));
		p.dispatch(trig("TASK-2"));
		p.dispatch(trig("TASK-3"));
		expect(p.activeCount()).toBe(2);
		expect(p.queuedCount()).toBe(1);

		pendings[0]?.resolve(okResult(pendings[0].spec));
		await flush();
		expect(p.activeCount()).toBe(2); // the queued one started
		expect(p.queuedCount()).toBe(0);
	});

	it("drives the TADU lifecycle to in-review on success, recording output", async () => {
		const p = pool(1);
		p.dispatch(trig("TASK-1"));
		expect(moves).toContainEqual(["TASK-1", "in-progress"]);
		pendings[0]?.resolve(okResult(pendings[0].spec, "implemented the fix"));
		await flush();
		expect(moves).toContainEqual(["TASK-1", "in-review"]);
		expect(comments.some(([id, t]) => id === "TASK-1" && t.includes("implemented the fix"))).toBe(true);
		expect(decisions.some((d) => d.kind === "worker")).toBe(true);
	});

	it("moves to blocked and escalates on failure", async () => {
		const p = pool(1);
		p.dispatch(trig("TASK-9"));
		pendings[0]?.resolve(failResult(pendings[0].spec, 2));
		await flush();
		expect(moves).toContainEqual(["TASK-9", "blocked"]);
		expect(escalations).toHaveLength(1);
		expect(escalations[0]).toContain("TASK-9");
		expect(decisions.some((d) => d.kind === "escalate")).toBe(true);
	});

	it("runs a task-less trigger without touching TADU", async () => {
		const p = pool(1);
		p.dispatch(trig(undefined));
		expect(p.activeCount()).toBe(1);
		expect(moves).toHaveLength(0);
		pendings[0]?.resolve(okResult(pendings[0].spec));
		await flush();
		expect(moves).toHaveLength(0);
		expect(decisions.some((d) => d.kind === "delegate")).toBe(true);
	});

	it("coalesces a duplicate dispatch of the same task", () => {
		const p = pool(2);
		p.dispatch(trig("TASK-1"));
		p.dispatch(trig("TASK-1")); // same task, must not double-run
		expect(p.activeCount()).toBe(1);
		expect(pendings).toHaveLength(1);
	});

	it("allows a task to be dispatched again once it has finished", async () => {
		const p = pool(1);
		p.dispatch(trig("TASK-1"));
		pendings[0]?.resolve(okResult(pendings[0].spec));
		await flush();
		p.dispatch(trig("TASK-1")); // now free to run again
		expect(p.activeCount()).toBe(1);
		expect(pendings).toHaveLength(2);
	});

	it("drops and escalates when the queue is full", () => {
		const p = pool(1, { maxQueue: 1 });
		p.dispatch(trig("TASK-1")); // active
		p.dispatch(trig("TASK-2")); // queued (fills the queue)
		p.dispatch(trig("TASK-3")); // dropped
		expect(p.activeCount()).toBe(1);
		expect(p.queuedCount()).toBe(1);
		expect(escalations.some((s) => s.includes("queue full"))).toBe(true);
	});

	it("stop() resolves even if a worker never closes", async () => {
		const p = pool(1, { stopTimeoutMs: 50 }); // runner's done never resolves unless we do
		p.dispatch(trig("TASK-1"));
		await p.stop(); // must not hang despite the unresolved worker
		expect(pendings[0]?.killed).toBe(true);
	});

	it("ignores dispatch after stop", async () => {
		const p = pool(1);
		await p.stop();
		p.dispatch(trig("TASK-1"));
		expect(p.activeCount()).toBe(0);
		expect(pendings).toHaveLength(0);
	});

	it("runs the worker in an isolated worktree and preserves it when changed", async () => {
		const finalized: string[] = [];
		const provider = (_base: string, id: string) => ({
			cwd: `/trees/${id}`,
			isolated: true,
			branch: `worker/${id}`,
			path: `/trees/${id}`,
			finalize: () => {
				finalized.push(id);
				return { isolated: true, changed: true, removed: false, path: `/trees/${id}`, branch: `worker/${id}` };
			},
		});
		const p = pool(1, { sessionDir: "/s", cwd: "/base", newId: () => "w1", worktree: provider });
		p.dispatch(trig("TASK-1"));
		expect(pendings[0]?.spec.cwd).toBe("/trees/w1"); // ran in the worktree, not the base
		pendings[0]?.resolve(okResult(pendings[0].spec));
		await flush();
		expect(finalized).toContain("w1");
		expect(comments.some(([id, t]) => id === "TASK-1" && t.includes("worktree /trees/w1"))).toBe(true);
	});

	it("does not add a preserve note when the worktree was untouched", async () => {
		const provider = (_base: string, id: string) => ({
			cwd: `/trees/${id}`,
			isolated: true,
			branch: `worker/${id}`,
			path: `/trees/${id}`,
			finalize: () => ({ isolated: true, changed: false, removed: true, path: `/trees/${id}`, branch: `worker/${id}` }),
		});
		const p = pool(1, { sessionDir: "/s", cwd: "/base", newId: () => "w2", worktree: provider });
		p.dispatch(trig("TASK-2"));
		pendings[0]?.resolve(okResult(pendings[0].spec));
		await flush();
		expect(comments.some(([id, t]) => id === "TASK-2" && t.includes("Changes left"))).toBe(false);
	});

	it("drains the whole queue as workers finish", async () => {
		const p = pool(1);
		for (let i = 1; i <= 3; i += 1) p.dispatch(trig(`TASK-${i}`));
		expect(p.queuedCount()).toBe(2);
		// Resolve each active worker in turn; the next should start each time.
		for (let i = 0; i < 3; i += 1) {
			const p = pendings[i];
			if (p) p.resolve(okResult(p.spec));
			await flush();
		}
		expect(p.activeCount()).toBe(0);
		expect(p.queuedCount()).toBe(0);
		expect(pendings).toHaveLength(3);
	});

	it("parks a worker that requested a wait, frees the slot, then resumes the same session", async () => {
		const p = pool(1);
		p.dispatch(trig("TASK-1"));
		const spec = pendings[0]?.spec as WorkerSpec;
		// Worker requests a park before its turn ends.
		writeParkRequest(stateDir, { runId: spec.id, dueAt: clock + 60_000, prompt: "re-check the PR", reason: "ci" });
		pendings[0]?.resolve(okResult(spec));
		await flush();

		// Task is NOT finalised; the slot is free; the session is parked + in flight.
		expect(moves).not.toContainEqual(["TASK-1", "in-review"]);
		expect(p.activeCount()).toBe(0);
		expect(p.parkedCount()).toBe(1);
		expect(p.parkedTaskIds().has("TASK-1")).toBe(true);

		// A duplicate dispatch while parked is coalesced.
		p.dispatch(trig("TASK-1"));
		expect(pendings).toHaveLength(1);

		// Not due yet → no resume.
		p.checkParked();
		await flush();
		expect(p.activeCount()).toBe(0);

		// Advance the clock past the due time → resumes the SAME run id (same session).
		clock += 61_000;
		p.checkParked();
		await flush();
		expect(p.activeCount()).toBe(1);
		expect(pendings).toHaveLength(2);
		expect(pendings[1]?.spec.id).toBe(spec.id);
		expect(pendings[1]?.spec.resume).toBe(true);
		expect(pendings[1]?.spec.prompt).toContain("re-check the PR");
		expect(pendings[1]?.spec.prompt).toMatch(/^\[cycle 1\/\d+\] /); // resume carries a cycle counter

		// Finish the resume terminally → task completes.
		pendings[1]?.resolve(okResult(pendings[1].spec, "all green"));
		await flush();
		expect(moves).toContainEqual(["TASK-1", "in-review"]);
		expect(p.parkedCount()).toBe(0);
		expect(p.parkedTaskIds().has("TASK-1")).toBe(false);
	});

	it("re-arms parked sessions after a restart (loadParked)", async () => {
		const p1 = pool(1);
		p1.dispatch(trig("TASK-9"));
		const spec = pendings[0]?.spec as WorkerSpec;
		writeParkRequest(stateDir, { runId: spec.id, dueAt: clock + 1000, prompt: "go", reason: "ci" });
		pendings[0]?.resolve(okResult(spec));
		await flush();
		expect(p1.parkedCount()).toBe(1);

		// Simulate a restart: a fresh pool loads parked entries from disk.
		const p2 = pool(1);
		p2.loadParked();
		expect(p2.parkedTaskIds().has("TASK-9")).toBe(true);
		clock += 2000;
		p2.checkParked();
		await flush();
		expect(pendings[1]?.spec.id).toBe(spec.id); // resumed the same run
		expect(pendings[1]?.spec.resume).toBe(true);
	});

	it("blocks on needs_human: pushes the question, parks, and resumes when answered (by task id)", async () => {
		const p = pool(1);
		p.dispatch(trig("TASK-1"));
		const spec = pendings[0]?.spec as WorkerSpec;
		writeParkRequest(stateDir, {
			runId: spec.id,
			dueAt: clock + 86_400_000, // safety timer far out
			prompt: "fallback",
			reason: "awaiting human answer",
			awaitingAnswer: true,
			question: "Keep the /v1 endpoint or drop it?",
		});
		pendings[0]?.resolve(okResult(spec));
		await flush();

		// Pushed the question + blocked + awaiting (NOT a timer park).
		expect(needsHuman).toHaveLength(1);
		expect(needsHuman[0]).toMatchObject({ runId: spec.id, taskId: "TASK-1", question: "Keep the /v1 endpoint or drop it?" });
		expect(moves).toContainEqual(["TASK-1", "blocked"]);
		expect(p.parkedCount()).toBe(1);
		expect(decisions.some((d) => d.kind === "needs-human")).toBe(true);

		// The timer must NOT resume it (due far in the future).
		p.checkParked();
		await flush();
		expect(p.activeCount()).toBe(0);

		// Human answers by TASK id → resumes that exact session with the answer.
		writeAnswer(stateDir, "TASK-1", "Drop it.", "t");
		p.checkAnswers();
		await flush();
		expect(p.activeCount()).toBe(1);
		expect(pendings[1]?.spec.id).toBe(spec.id);
		expect(pendings[1]?.spec.resume).toBe(true);
		expect(pendings[1]?.spec.prompt).toContain("Drop it.");
		expect(moves).toContainEqual(["TASK-1", "in-progress"]); // back to the active lane
		expect(readAnswers(stateDir)).toEqual([]); // answer consumed
	});

	it("resumes a task-less needs-human worker answered by run id", async () => {
		const p = pool(1);
		p.dispatch(trig(undefined));
		const spec = pendings[0]?.spec as WorkerSpec;
		writeParkRequest(stateDir, { runId: spec.id, dueAt: clock + 86_400_000, prompt: "f", awaitingAnswer: true, question: "q" });
		pendings[0]?.resolve(okResult(spec));
		await flush();
		expect(p.parkedCount()).toBe(1);

		writeAnswer(stateDir, spec.id, "go ahead", "t"); // answer by run id
		p.checkAnswers();
		await flush();
		expect(pendings[1]?.spec.id).toBe(spec.id);
		expect(pendings[1]?.spec.prompt).toContain("go ahead");
	});

	it("drops a stale answer that matches no parked worker", async () => {
		const p = pool(1);
		writeAnswer(stateDir, "TASK-999", "nobody waiting", "t");
		p.checkAnswers();
		await flush();
		expect(p.activeCount()).toBe(0);
		expect(readAnswers(stateDir)).toEqual([]); // stale (invalid ts) consumed/dropped, no resume
	});

	it("honours needs_human even when the resume budget is exhausted", async () => {
		const p = pool(1, { maxResumes: 1 });
		// Exhaust the budget with one timer park + resume.
		p.dispatch(trig("TASK-7"));
		let spec = pendings[0]?.spec as WorkerSpec;
		writeParkRequest(stateDir, { runId: spec.id, dueAt: clock, prompt: "again", reason: "ci" });
		pendings[0]?.resolve(okResult(spec));
		await flush();
		p.checkParked();
		await flush();
		expect(pendings).toHaveLength(2);

		// The resumed worker (now at maxResumes) hits a real blocker.
		spec = pendings[1]?.spec as WorkerSpec;
		writeParkRequest(stateDir, { runId: spec.id, dueAt: clock + 86_400_000, prompt: "f", awaitingAnswer: true, question: "decide?" });
		pendings[1]?.resolve(okResult(spec));
		await flush();

		// Must park-for-answer + push — NOT be swallowed as loop-exhausted / in-review.
		expect(needsHuman.some((n) => n.taskId === "TASK-7")).toBe(true);
		expect(moves).toContainEqual(["TASK-7", "blocked"]);
		expect(moves).not.toContainEqual(["TASK-7", "in-review"]);
		expect(p.parkedCount()).toBe(1);
	});

	it("hands off (does not fail) a park loop that exceeds maxResumes", async () => {
		const p = pool(1, { maxResumes: 1 });
		p.dispatch(trig("TASK-5"));
		let spec = pendings[0]?.spec as WorkerSpec;
		writeParkRequest(stateDir, { runId: spec.id, dueAt: clock, prompt: "again", reason: "r" });
		pendings[0]?.resolve(okResult(spec));
		await flush();
		expect(p.parkedCount()).toBe(1);

		p.checkParked(); // due now → resume (cycle 1)
		await flush();
		expect(pendings).toHaveLength(2);
		spec = pendings[1]?.spec as WorkerSpec;
		writeParkRequest(stateDir, { runId: spec.id, dueAt: clock, prompt: "again", reason: "r" });
		pendings[1]?.resolve(okResult(spec));
		await flush();

		// resumes(1) >= maxResumes(1) → benign hand-off for review, NOT a failure.
		expect(moves).toContainEqual(["TASK-5", "in-review"]);
		expect(moves).not.toContainEqual(["TASK-5", "blocked"]);
		expect(escalations).toHaveLength(0);
		expect(decisions.some((d) => d.kind === "park-exhausted")).toBe(true);
		expect(p.parkedCount()).toBe(0);
	});
});
