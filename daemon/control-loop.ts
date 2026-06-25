/**
 * Control loop — translate a human's board action into an agent action.
 *
 * The TADU watcher (./tadu-watch) streams events; the actor model (../extensions/
 * lib/tadu-actor) keeps the human's writes apart from the agent's own. This module
 * is the policy and the executor for the human ones: a lane drag or a comment
 * becomes "start a worker", "answer the blocked worker", "stop the work", or
 * "nothing", depending on what the task is actually doing right now.
 *
 * The mapping (confirmed with the user):
 *  - drag → in-progress ........ start a worker (if not already in flight)
 *  - drag → blocked/backlog ..... stop any in-flight work (human takes over)
 *  - drag → in-review ........... stop a live worker (human says "good enough")
 *  - drag → done (terminal) ..... stop any in-flight work; "nothing more to do"
 *  - drag → ready (grooming) .... nothing (the human starts work by moving to in-progress)
 *  - comment, worker awaiting .... the comment IS the answer → resume the worker
 *  - comment, task idle .......... the comment is an instruction → start a worker
 *  - comment, task in flight ..... nothing actionable (a -p worker can't be steered mid-run)
 *  - comment, task terminal ...... nothing (no work on a done task)
 *
 * The decision is a pure function over (event kind, lane, live state); the executor
 * reads the task to compose prompts/answers and calls the injected ports. Both are
 * tested without the daemon.
 */

import { actorOrigin } from "../extensions/lib/tadu-actor.ts";
import type { TaduEvent } from "../extensions/lib/tadu.ts";
import type { TaskControlState } from "./worker-pool.ts";

export type ControlActionKind = "dispatch" | "answer" | "stop" | "ignore";
export type ControlDecision = { action: ControlActionKind; reason: string };

export type ControlInput = {
	kind: "move" | "comment";
	/** A move's TARGET lane; a comment's task CURRENT lane. */
	lane: string;
	state: TaskControlState;
	/** Terminal lanes (e.g. "done"), from the TADU config. */
	terminal: ReadonlySet<string>;
	/** The lane whose arrival means "start work now". Default "in-progress". */
	startLane: string;
};

const STOP_LANES: ReadonlySet<string> = new Set(["blocked", "backlog", "in-review"]);

/** The policy: pure, exhaustive, side-effect-free. */
export function decideControlAction(input: ControlInput): ControlDecision {
	const { kind, lane, state, terminal, startLane } = input;

	if (kind === "move") {
		if (lane === startLane) {
			return state === "none"
				? { action: "dispatch", reason: "human started the task" }
				: { action: "ignore", reason: "already in flight" };
		}
		if (terminal.has(lane) || STOP_LANES.has(lane)) {
			// done/blocked/backlog/in-review: the human owns the lane; the agent yields.
			return state === "none"
				? { action: "ignore", reason: "nothing in flight to stop" }
				: { action: "stop", reason: `human moved to ${lane}` };
		}
		// A grooming lane (e.g. "ready"): no work is started until "in-progress".
		return { action: "ignore", reason: `lane ${lane} has no control action` };
	}

	// comment
	if (state === "awaiting-human") return { action: "answer", reason: "comment answers the blocked worker" };
	if (state === "none") {
		return terminal.has(lane)
			? { action: "ignore", reason: "comment on a terminal task" }
			: { action: "dispatch", reason: "comment is an instruction for an idle task" };
	}
	return { action: "ignore", reason: "task in flight; a running worker cannot be steered mid-run" };
}

export type ControlTaskView = {
	status: string;
	title: string;
	description?: string;
	comments: Array<{ text: string; ts?: string; actor?: string }>;
};

export type ControlLoopPorts = {
	/** Read a task (status, title, description, comments). */
	getTask: (id: string) => ControlTaskView | undefined;
	/** The task's live activity, from the worker pool. */
	taskState: (id: string) => TaskControlState;
	/** TADU lanes + terminal lanes, from config. */
	config: () => { statuses: string[]; terminal: string[] };
	/** Start a worker on a task with the given prompt body. */
	dispatch: (taskId: string, text: string) => void;
	/** Deliver a human answer to a blocked worker (resumes it). */
	answer: (taskId: string, text: string) => void;
	/** Stop all work for a task (human override). */
	stopTask: (taskId: string, reason: string) => void;
	onDecision?: (d: { kind: string; summary: string; source?: string; detail?: Record<string, unknown> }) => void;
	logger?: (message: string) => void;
	/** Override the "start work" lane (default "in-progress"). */
	startLane?: string;
};

export class ControlLoop {
	private readonly o: ControlLoopPorts;
	private readonly startLane: string;

	constructor(ports: ControlLoopPorts) {
		this.o = ports;
		this.startLane = ports.startLane ?? "in-progress";
	}

	/** React to one human control event (a `task.moved` or `task.commented`). */
	handle(event: TaduEvent): void {
		const taskId = event.task;
		if (!taskId) return;
		const task = this.o.getTask(taskId);
		if (!task) {
			this.o.logger?.(`[control] ${taskId} ${event.type}: task not found; ignoring`);
			return;
		}

		const kind = event.type === "task.moved" ? "move" : "comment";
		const lane = kind === "move" ? String((event.data as { to?: string } | undefined)?.to ?? task.status) : task.status;
		const decision = decideControlAction({
			kind,
			lane,
			state: this.o.taskState(taskId),
			terminal: new Set(this.o.config().terminal),
			startLane: this.startLane,
		});

		switch (decision.action) {
			case "dispatch": {
				const comment = kind === "comment" ? latestComment(task) : undefined;
				this.o.dispatch(taskId, composeWorkText(task, comment));
				this.record("control-dispatch", `Human ${kind === "comment" ? "instructed" : "started"} ${taskId} → dispatched a worker.`, taskId);
				break;
			}
			case "answer": {
				const text = latestComment(task);
				if (!text) {
					this.o.logger?.(`[control] ${taskId} comment: no comment text found; ignoring`);
					return;
				}
				this.o.answer(taskId, text);
				this.record("control-answer", `Human comment on ${taskId} answers the blocked worker → resuming.`, taskId);
				break;
			}
			case "stop":
				// stopTask emits its own "control-stop" decision (it knows what it stopped).
				this.o.stopTask(taskId, decision.reason);
				break;
			case "ignore":
				this.o.logger?.(`[control] ${taskId} ${event.type}: ${decision.reason}`);
				break;
		}
	}

	private record(kind: string, summary: string, taskId: string): void {
		this.o.onDecision?.({ kind, summary, source: "control-plane", detail: { taduTask: taskId } });
		this.o.logger?.(`[control] ${summary}`);
	}
}

/**
 * The newest HUMAN comment's text — the one whose board action we are reacting to.
 * Never returns one of the agent's own comments (e.g. the pool's "Blocked — needs a
 * human decision" note), which a purely positional "last comment" could pick up in
 * the narrow window where an agent write lands between the event and this read.
 * A comment with no recorded actor is treated as human (legacy/manual writes).
 */
function latestComment(task: ControlTaskView): string | undefined {
	for (let i = task.comments.length - 1; i >= 0; i -= 1) {
		const c = task.comments[i];
		if (c && actorOrigin(c.actor) === "human") return c.text?.trim() || undefined;
	}
	return undefined;
}

/** Build the prompt body for a worker dispatched from a board action. */
export function composeWorkText(task: ControlTaskView, comment?: string): string {
	let body = task.title;
	if (task.description) body += `\n\n${task.description}`;
	if (comment) body += `\n\nThe human added this instruction:\n${comment}`;
	return body;
}
