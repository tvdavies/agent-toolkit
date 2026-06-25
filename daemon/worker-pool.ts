/**
 * Worker pool — bounded-concurrency delegation of triggers to worker sessions.
 *
 * The router sends discrete tracked work here; the pool runs up to N workers at
 * once (queuing the rest) so the resident orchestrator never blocks on a long
 * task and independent tasks run in parallel. It owns each task's TADU lifecycle:
 * move to in-progress on start, in-review on success or blocked on failure, with
 * the worker's output recorded as a comment (the decision log). Failures escalate.
 *
 * Everything external — spawning a worker, the TADU CLI, the id factory — is
 * injectable, so the pool's concurrency and lifecycle are tested deterministically.
 */

import { randomUUID } from "node:crypto";
import type { Trigger } from "./inbox.ts";
import { taduControl, type TaduControl } from "./tadu-control.ts";
import { runWorker, type WorkerHandle, type WorkerResult, type WorkerSpec } from "./worker.ts";

export type WorkerRunner = (spec: WorkerSpec) => WorkerHandle;

export type PoolDecision = {
	kind: string;
	summary: string;
	source?: string;
	detail?: Record<string, unknown>;
};

export type WorkerPoolOptions = {
	maxConcurrent: number;
	sessionDir: string;
	cwd: string;
	piBin: string;
	model?: string;
	timeoutMs?: number;
	/** Max queued (not-yet-started) triggers; excess is dropped + escalated. */
	maxQueue?: number;
	/** Upper bound on how long stop() waits for workers to die. */
	stopTimeoutMs?: number;
	/** Spawn a worker; defaults to the real `pi -p` runner. */
	runner?: WorkerRunner;
	/** TADU lifecycle surface; defaults to the `tadu` CLI. */
	tadu?: TaduControl;
	startStatus?: string;
	successStatus?: string;
	failureStatus?: string;
	/** Record a decision to the spine. */
	onDecision?: (d: PoolDecision) => void;
	/** Push an escalation when a delegated task fails. */
	onEscalate?: (summary: string) => void;
	/** Run-id factory (injected in tests). */
	newId?: () => string;
	logger?: (message: string) => void;
};

export class WorkerPool {
	private readonly o: Required<
		Omit<WorkerPoolOptions, "model" | "timeoutMs" | "onDecision" | "onEscalate" | "logger">
	> &
		Pick<WorkerPoolOptions, "model" | "timeoutMs" | "onDecision" | "onEscalate" | "logger">;
	private readonly queue: Trigger[] = [];
	private readonly active = new Map<string, WorkerHandle>();
	/** TADU tasks currently queued or running, so a task is never double-dispatched. */
	private readonly inFlightTasks = new Set<string>();
	private stopping = false;

	constructor(options: WorkerPoolOptions) {
		this.o = {
			maxConcurrent: Math.max(1, options.maxConcurrent),
			sessionDir: options.sessionDir,
			cwd: options.cwd,
			piBin: options.piBin,
			runner: options.runner ?? ((spec) => runWorker(spec)),
			tadu: options.tadu ?? taduControl(),
			startStatus: options.startStatus ?? "in-progress",
			successStatus: options.successStatus ?? "in-review",
			failureStatus: options.failureStatus ?? "blocked",
			newId: options.newId ?? (() => `w-${randomUUID().slice(0, 8)}`),
			maxQueue: Math.max(1, options.maxQueue ?? 200),
			stopTimeoutMs: options.stopTimeoutMs ?? 6000,
			model: options.model,
			timeoutMs: options.timeoutMs,
			onDecision: options.onDecision,
			onEscalate: options.onEscalate,
			logger: options.logger,
		};
	}

	/** Queue a trigger and start it if there is spare capacity. */
	dispatch(trigger: Trigger): void {
		if (this.stopping) return;
		const taskId = trigger.taduTask;
		// Coalesce: never run the same task twice concurrently (re-dispatch / inbox
		// replay must not drag a running or finished task backwards).
		if (taskId && this.inFlightTasks.has(taskId)) {
			this.o.logger?.(`[pool] task ${taskId} already in flight; skipping duplicate`);
			return;
		}
		// Bound the backlog so a burst cannot grow memory or pending work without limit.
		if (this.queue.length >= this.o.maxQueue) {
			const summary = `Worker queue full (${this.o.maxQueue}); dropped: ${trigger.text.slice(0, 80)}`;
			this.o.onDecision?.({ kind: "escalate", summary, source: trigger.source });
			this.o.onEscalate?.(summary);
			return;
		}
		if (taskId) this.inFlightTasks.add(taskId);
		this.queue.push(trigger);
		this.pump();
	}

	activeCount(): number {
		return this.active.size;
	}
	queuedCount(): number {
		return this.queue.length;
	}

	/** Kill any active workers and drop the queue, bounded so shutdown never wedges. */
	async stop(): Promise<void> {
		this.stopping = true;
		this.queue.length = 0;
		const handles = [...this.active.values()];
		for (const h of handles) h.kill();
		await Promise.race([
			Promise.allSettled(handles.map((h) => h.done)),
			new Promise((resolve) => setTimeout(resolve, this.o.stopTimeoutMs)),
		]);
	}

	private pump(): void {
		if (this.stopping) return;
		while (this.active.size < this.o.maxConcurrent && this.queue.length > 0) {
			const trigger = this.queue.shift();
			if (trigger) this.start(trigger);
		}
	}

	private start(trigger: Trigger): void {
		const id = this.o.newId();
		const taskId = trigger.taduTask;
		const spec: WorkerSpec = {
			id,
			taskId,
			prompt: composePrompt(trigger),
			sessionDir: this.o.sessionDir,
			cwd: this.o.cwd,
			piBin: this.o.piBin,
			model: this.o.model,
			timeoutMs: this.o.timeoutMs,
		};
		if (taskId) {
			this.o.tadu.move(taskId, this.o.startStatus);
			this.o.tadu.comment(taskId, `Worker ${id} started.`);
		}
		this.o.onDecision?.({
			kind: "delegate",
			summary: `Delegated to worker ${id}: ${trigger.text.slice(0, 100)}`,
			source: trigger.source,
			detail: { worker: id, ...(taskId ? { taduTask: taskId } : {}) },
		});
		this.o.logger?.(`[pool] worker ${id} started (active ${this.active.size + 1}/${this.o.maxConcurrent}, queued ${this.queue.length})`);

		const handle = this.o.runner(spec);
		this.active.set(id, handle);
		handle.done
			.then((result) => this.finish(spec, result))
			.catch(() =>
				this.finish(spec, {
					id,
					taskId,
					ok: false,
					code: null,
					signal: null,
					outputText: "",
					errorText: "worker handle rejected",
					timedOut: false,
				}),
			)
			.finally(() => {
				this.active.delete(id);
				if (taskId) this.inFlightTasks.delete(taskId);
				this.pump();
			});
	}

	private finish(spec: WorkerSpec, result: WorkerResult): void {
		const taskId = spec.taskId;
		if (result.ok) {
			if (taskId) {
				this.o.tadu.move(taskId, this.o.successStatus);
				this.o.tadu.comment(taskId, `Worker ${spec.id} done.\n\n${result.outputText.slice(0, 1500) || "(no output)"}`);
			}
			this.o.onDecision?.({
				kind: "worker",
				summary: `Worker ${spec.id} completed${taskId ? ` (${taskId})` : ""}.`,
				detail: taskId ? { taduTask: taskId } : { worker: spec.id },
			});
			this.o.logger?.(`[pool] worker ${spec.id} completed`);
		} else {
			const reason = result.timedOut ? "timed out" : `exit ${result.code ?? "?"}`;
			if (taskId) {
				this.o.tadu.move(taskId, this.o.failureStatus);
				this.o.tadu.comment(taskId, `Worker ${spec.id} failed (${reason}).\n\n${result.errorText.slice(0, 1500)}`);
			}
			const summary = `Delegated task ${taskId ?? spec.id} failed (${reason}).`;
			this.o.onDecision?.({ kind: "escalate", summary, detail: taskId ? { taduTask: taskId } : { worker: spec.id } });
			this.o.onEscalate?.(summary);
			this.o.logger?.(`[pool] worker ${spec.id} failed (${reason})`);
		}
	}
}

/** Build the worker's prompt: the task plus a one-shot worker instruction. */
export function composePrompt(trigger: Trigger): string {
	const tag = trigger.taduTask ? `(TADU ${trigger.taduTask}) ` : "";
	return `${tag}${trigger.text}\n\nYou are an autonomous worker running this task to completion in a non-interactive session. Do the work, then end your reply with a concise summary of what you did and any follow-ups — that summary is recorded against the task.`;
}
