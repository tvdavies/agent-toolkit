import { beforeEach, describe, expect, it } from "bun:test";
import type { Trigger } from "./inbox";
import type { TaduControl } from "./tadu-control";
import { type PoolDecision, WorkerPool, type WorkerRunner } from "./worker-pool";
import type { WorkerResult, WorkerSpec } from "./worker";

// Flush the microtask chain (resolve → then(finish) → finally(pump)).
const flush = () => new Promise((r) => setTimeout(r, 0));

type Pending = { spec: WorkerSpec; resolve: (r: WorkerResult) => void; killed: boolean };
let pendings: Pending[];
let moves: Array<[string, string]>;
let comments: Array<[string, string]>;
let decisions: PoolDecision[];
let escalations: string[];
let ids: number;

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

function pool(maxConcurrent: number): WorkerPool {
	return new WorkerPool({
		maxConcurrent,
		sessionDir: "/tmp/sessions",
		cwd: "/tmp/cwd",
		piBin: "pi",
		runner,
		tadu,
		newId: () => `w${++ids}`,
		onDecision: (d) => decisions.push(d),
		onEscalate: (s) => escalations.push(s),
	});
}

beforeEach(() => {
	pendings = [];
	moves = [];
	comments = [];
	decisions = [];
	escalations = [];
	ids = 0;
});

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
		const p = new WorkerPool({
			maxConcurrent: 1,
			maxQueue: 1,
			sessionDir: "/tmp/s",
			cwd: "/tmp/c",
			piBin: "pi",
			runner,
			tadu,
			newId: () => `w${++ids}`,
			onDecision: (d) => decisions.push(d),
			onEscalate: (s) => escalations.push(s),
		});
		p.dispatch(trig("TASK-1")); // active
		p.dispatch(trig("TASK-2")); // queued (fills the queue)
		p.dispatch(trig("TASK-3")); // dropped
		expect(p.activeCount()).toBe(1);
		expect(p.queuedCount()).toBe(1);
		expect(escalations.some((s) => s.includes("queue full"))).toBe(true);
	});

	it("stop() resolves even if a worker never closes", async () => {
		const p = new WorkerPool({
			maxConcurrent: 1,
			stopTimeoutMs: 50,
			sessionDir: "/tmp/s",
			cwd: "/tmp/c",
			piBin: "pi",
			runner, // its done never resolves unless we resolve it
			tadu,
			newId: () => `w${++ids}`,
		});
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
});
