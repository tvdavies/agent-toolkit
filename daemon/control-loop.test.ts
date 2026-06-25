import { describe, expect, it } from "bun:test";
import type { TaduEvent } from "../extensions/lib/tadu";
import type { TaskControlState } from "./worker-pool";
import {
	composeWorkText,
	ControlLoop,
	type ControlLoopPorts,
	type ControlTaskView,
	decideControlAction,
} from "./control-loop";

const TERMINAL = new Set(["done"]);

const decide = (kind: "move" | "comment", lane: string, state: TaskControlState) =>
	decideControlAction({ kind, lane, state, terminal: TERMINAL, startLane: "in-progress" });

describe("decideControlAction — moves", () => {
	it("drag to in-progress on an idle task dispatches a worker", () => {
		expect(decide("move", "in-progress", "none")).toMatchObject({ action: "dispatch" });
	});
	it("drag to in-progress on an in-flight task is a no-op (coalesced)", () => {
		expect(decide("move", "in-progress", "running").action).toBe("ignore");
		expect(decide("move", "in-progress", "parked").action).toBe("ignore");
	});
	it("drag to blocked/backlog stops in-flight work, else nothing", () => {
		expect(decide("move", "blocked", "running").action).toBe("stop");
		expect(decide("move", "backlog", "parked").action).toBe("stop");
		expect(decide("move", "blocked", "none").action).toBe("ignore");
	});
	it("drag to in-review stops a live worker (human override), else nothing", () => {
		expect(decide("move", "in-review", "running").action).toBe("stop");
		expect(decide("move", "in-review", "none").action).toBe("ignore");
	});
	it("drag to done (terminal) stops in-flight work but starts nothing", () => {
		expect(decide("move", "done", "running").action).toBe("stop");
		expect(decide("move", "done", "none").action).toBe("ignore");
	});
	it("drag to a grooming lane (ready) does nothing", () => {
		expect(decide("move", "ready", "none").action).toBe("ignore");
		expect(decide("move", "ready", "running").action).toBe("ignore");
	});
});

describe("decideControlAction — comments", () => {
	it("a comment on a blocked (awaiting-human) task answers it", () => {
		expect(decide("comment", "blocked", "awaiting-human")).toMatchObject({ action: "answer" });
	});
	it("a comment on an idle non-terminal task is an instruction → dispatch", () => {
		expect(decide("comment", "ready", "none").action).toBe("dispatch");
		expect(decide("comment", "blocked", "none").action).toBe("dispatch");
	});
	it("a comment on a terminal (done) task does nothing", () => {
		expect(decide("comment", "done", "none").action).toBe("ignore");
	});
	it("a comment on a running/queued/parked task cannot steer a live run → ignore", () => {
		expect(decide("comment", "in-progress", "running").action).toBe("ignore");
		expect(decide("comment", "in-progress", "queued").action).toBe("ignore");
		expect(decide("comment", "in-progress", "parked").action).toBe("ignore");
	});
});

describe("composeWorkText", () => {
	it("joins title, description, and a human comment", () => {
		const task: ControlTaskView = { status: "ready", title: "Fix login", description: "It 500s", comments: [] };
		expect(composeWorkText(task)).toBe("Fix login\n\nIt 500s");
		expect(composeWorkText(task, "use the v2 endpoint")).toContain("The human added this instruction:\nuse the v2 endpoint");
	});
});

type Calls = {
	dispatch: Array<{ id: string; text: string }>;
	answer: Array<{ id: string; text: string }>;
	stop: Array<{ id: string; reason: string }>;
};

function harness(opts: {
	task?: ControlTaskView;
	state?: TaskControlState;
}): { loop: ControlLoop; calls: Calls } {
	const calls: Calls = { dispatch: [], answer: [], stop: [] };
	const ports: ControlLoopPorts = {
		getTask: () => opts.task,
		taskState: () => opts.state ?? "none",
		config: () => ({ statuses: ["backlog", "ready", "in-progress", "blocked", "in-review", "done"], terminal: ["done"] }),
		dispatch: (id, text) => calls.dispatch.push({ id, text }),
		answer: (id, text) => calls.answer.push({ id, text }),
		stopTask: (id, reason) => calls.stop.push({ id, reason }),
	};
	return { loop: new ControlLoop(ports), calls };
}

const moveEvent = (to: string): TaduEvent => ({ seq: 1, time: "t", type: "task.moved", task: "TASK-1", actor: "Tom Davies", data: { to } });
const commentEvent = (): TaduEvent => ({ seq: 1, time: "t", type: "task.commented", task: "TASK-1", actor: "Tom Davies" });

describe("ControlLoop executor", () => {
	it("dispatches a worker with the task's text on drag to in-progress", () => {
		const { loop, calls } = harness({ task: { status: "in-progress", title: "Do the thing", description: "details", comments: [] }, state: "none" });
		loop.handle(moveEvent("in-progress"));
		expect(calls.dispatch).toHaveLength(1);
		expect(calls.dispatch[0]!.id).toBe("TASK-1");
		expect(calls.dispatch[0]!.text).toContain("Do the thing");
		expect(calls.dispatch[0]!.text).toContain("details");
	});

	it("answers the blocked worker with the latest comment text", () => {
		const { loop, calls } = harness({
			task: { status: "blocked", title: "t", comments: [{ text: "old" }, { text: "use option B" }] },
			state: "awaiting-human",
		});
		loop.handle(commentEvent());
		expect(calls.answer).toEqual([{ id: "TASK-1", text: "use option B" }]);
		expect(calls.dispatch).toHaveLength(0);
	});

	it("dispatches with the comment as an instruction for an idle task", () => {
		const { loop, calls } = harness({
			task: { status: "ready", title: "Task", description: "ctx", comments: [{ text: "also handle nulls" }] },
			state: "none",
		});
		loop.handle(commentEvent());
		expect(calls.dispatch).toHaveLength(1);
		expect(calls.dispatch[0]!.text).toContain("also handle nulls");
	});

	it("stops the worker when a card is dragged to done while running", () => {
		const { loop, calls } = harness({ task: { status: "done", title: "t", comments: [] }, state: "running" });
		loop.handle(moveEvent("done"));
		expect(calls.stop).toHaveLength(1);
		expect(calls.dispatch).toHaveLength(0);
	});

	it("does nothing when the task cannot be read", () => {
		const { loop, calls } = harness({ task: undefined, state: "none" });
		loop.handle(moveEvent("in-progress"));
		expect(calls.dispatch).toHaveLength(0);
	});

	it("does not answer when awaiting-human but no comment text is present", () => {
		const { loop, calls } = harness({ task: { status: "blocked", title: "t", comments: [] }, state: "awaiting-human" });
		loop.handle(commentEvent());
		expect(calls.answer).toHaveLength(0);
	});

	it("uses the latest HUMAN comment, skipping the agent's own comments", () => {
		const { loop, calls } = harness({
			task: {
				status: "blocked",
				title: "t",
				comments: [
					{ text: "use option B", actor: "Tom Davies" },
					{ text: "Blocked — needs a human decision: which option?", actor: "agent:toolkit" },
				],
			},
			state: "awaiting-human",
		});
		loop.handle(commentEvent());
		expect(calls.answer).toEqual([{ id: "TASK-1", text: "use option B" }]);
	});

	it("does not answer when the only comments are the agent's own", () => {
		const { loop, calls } = harness({
			task: { status: "blocked", title: "t", comments: [{ text: "Worker started.", actor: "agent:toolkit" }] },
			state: "awaiting-human",
		});
		loop.handle(commentEvent());
		expect(calls.answer).toHaveLength(0);
	});
});
