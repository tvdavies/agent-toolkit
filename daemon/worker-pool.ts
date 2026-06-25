/**
 * Worker pool — bounded-concurrency delegation of triggers to worker sessions.
 *
 * The router sends discrete tracked work here; the pool runs up to N workers at
 * once (queuing the rest) so the resident orchestrator never blocks on a long
 * task and independent tasks run in parallel. It owns each task's TADU lifecycle:
 * move to in-progress on start, in-review on success or blocked on failure, with
 * the worker's output recorded as a comment (the decision log). Failures escalate.
 *
 * Park/resume: a worker that must wait for an external change (CI, a review) calls
 * the `park` tool and ends its turn. The pool then keeps the task in flight but
 * DORMANT — no process, no slot — and at the due time resumes the exact same
 * session (`--continue`) so the agent wakes with full context. Parked entries are
 * persisted, so they survive a daemon restart (re-armed by loadParked).
 *
 * Everything external — spawning a worker, the TADU CLI, the id factory, the
 * clock — is injectable, so concurrency, lifecycle, and park/resume are tested
 * deterministically.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDrivePrPrompt } from "../extensions/lib/drive-pr.ts";
import {
	clearAnswer,
	clearParkRequest,
	type ParkedEntry,
	readAllParked,
	readAnswers,
	readParkRequest,
	removeParked,
	writeParked,
} from "../extensions/lib/park.ts";

/** Drive-to-green and similar loops do real fix work per cycle; give them headroom. */
const LONG_RUN_TIMEOUT_MS = 45 * 60_000;
import type { Trigger } from "./inbox.ts";
import { taduControl, type TaduControl } from "./tadu-control.ts";
import { runWorker, type WorkerHandle, type WorkerResult, type WorkerSpec } from "./worker.ts";
import type { PreparedWorktree } from "./worktree.ts";

export type WorkerRunner = (spec: WorkerSpec) => WorkerHandle;

/** Prepare an isolated worktree for a run (the pool stays git-agnostic + testable). */
export type WorktreeProvider = (baseCwd: string, id: string) => PreparedWorktree;

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
	/** State dir where park requests/entries live (shared with the park tool). */
	stateDir: string;
	model?: string;
	timeoutMs?: number;
	/** Max queued (not-yet-started) items; excess is dropped + escalated. */
	maxQueue?: number;
	/** Upper bound on how long stop() waits for workers to die. */
	stopTimeoutMs?: number;
	/** Cap on resume cycles per task, so a park loop cannot run forever. */
	maxResumes?: number;
	/** How often to check for due parked sessions (0 disables the timer; tests call checkParked). */
	parkPollMs?: number;
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
	/** Push a needs-human question (carries the run/task id so a reply can resume it). */
	onNeedsHuman?: (info: { question: string; runId: string; taskId?: string }) => void;
	/** Run-id factory (injected in tests). */
	newId?: () => string;
	/** Injected clock (defaults to Date.now), for testable park scheduling. */
	now?: () => number;
	/** Absolute path to the guardrails extension, loaded into every worker. */
	guardrailsPath?: string;
	/** Extra capability extensions loaded into every worker (e.g. worktree + park tools). */
	toolExtensions?: string[];
	/** Isolate each worker in a git worktree; omit to run workers in the base cwd. */
	worktree?: WorktreeProvider;
	logger?: (message: string) => void;
};

type Optional = "model" | "timeoutMs" | "onDecision" | "onEscalate" | "onNeedsHuman" | "logger" | "guardrailsPath" | "toolExtensions" | "worktree";

type FreshItem = { kind: "fresh"; trigger: Trigger };
type ResumeItem = { kind: "resume"; entry: ParkedEntry; prepared?: PreparedWorktree };
type WorkItem = FreshItem | ResumeItem;

type ParkedState = { entry: ParkedEntry; prepared?: PreparedWorktree };

export class WorkerPool {
	private readonly o: Required<Omit<WorkerPoolOptions, Optional>> & Pick<WorkerPoolOptions, Optional>;
	private readonly queue: WorkItem[] = [];
	private readonly active = new Map<string, WorkerHandle>();
	/** TADU tasks currently in flight (queued, running, or parked) — never double-dispatched. */
	private readonly inFlightTasks = new Set<string>();
	/** Dormant sessions awaiting resume, keyed by run id. */
	private readonly parked = new Map<string, ParkedState>();
	private parkTimer: ReturnType<typeof setInterval> | undefined;
	private stopping = false;

	constructor(options: WorkerPoolOptions) {
		this.o = {
			maxConcurrent: Math.max(1, options.maxConcurrent),
			sessionDir: options.sessionDir,
			cwd: options.cwd,
			piBin: options.piBin,
			stateDir: options.stateDir,
			runner: options.runner ?? ((spec) => runWorker(spec)),
			tadu: options.tadu ?? taduControl(),
			startStatus: options.startStatus ?? "in-progress",
			successStatus: options.successStatus ?? "in-review",
			failureStatus: options.failureStatus ?? "blocked",
			newId: options.newId ?? (() => `w-${randomUUID().slice(0, 8)}`),
			now: options.now ?? Date.now,
			maxQueue: Math.max(1, options.maxQueue ?? 200),
			stopTimeoutMs: options.stopTimeoutMs ?? 6000,
			maxResumes: Math.max(1, options.maxResumes ?? 40),
			parkPollMs: options.parkPollMs ?? 1000,
			model: options.model,
			timeoutMs: options.timeoutMs,
			guardrailsPath: options.guardrailsPath,
			toolExtensions: options.toolExtensions,
			worktree: options.worktree,
			onDecision: options.onDecision,
			onEscalate: options.onEscalate,
			onNeedsHuman: options.onNeedsHuman,
			logger: options.logger,
		};
	}

	/** Queue a trigger and start it if there is spare capacity. */
	dispatch(trigger: Trigger): void {
		if (this.stopping) return;
		const taskId = trigger.taduTask;
		// Coalesce: never run the same task twice concurrently (re-dispatch / inbox
		// replay must not drag a running, parked, or finished task backwards).
		if (taskId && this.inFlightTasks.has(taskId)) {
			this.o.logger?.(`[pool] task ${taskId} already in flight; skipping duplicate`);
			return;
		}
		if (this.queue.length >= this.o.maxQueue) {
			const summary = `Worker queue full (${this.o.maxQueue}); dropped: ${trigger.text.slice(0, 80)}`;
			this.o.onDecision?.({ kind: "escalate", summary, source: trigger.source });
			this.o.onEscalate?.(summary);
			return;
		}
		if (taskId) this.inFlightTasks.add(taskId);
		this.queue.push({ kind: "fresh", trigger });
		this.pump();
	}

	/** Re-arm parked sessions persisted from a previous daemon run. */
	loadParked(): void {
		for (const entry of readAllParked(this.o.stateDir)) {
			this.parked.set(entry.runId, { entry });
			if (entry.taskId) this.inFlightTasks.add(entry.taskId);
		}
		if (this.parked.size) {
			this.o.logger?.(`[pool] re-armed ${this.parked.size} parked session(s) from disk`);
			this.ensureParkTimer();
			this.checkParked();
		}
	}

	/** Tasks currently parked — the reconcile sweep must not mark these as orphaned. */
	parkedTaskIds(): Set<string> {
		const ids = new Set<string>();
		for (const p of this.parked.values()) if (p.entry.taskId) ids.add(p.entry.taskId);
		return ids;
	}

	activeCount(): number {
		return this.active.size;
	}
	queuedCount(): number {
		return this.queue.length;
	}
	parkedCount(): number {
		return this.parked.size;
	}

	/** Resume any parked sessions now due. Public so tests can drive it. */
	checkParked(): void {
		if (this.stopping) return;
		const now = this.o.now();
		for (const [runId, p] of [...this.parked.entries()]) {
			if (p.entry.dueAt <= now) {
				this.parked.delete(runId);
				removeParked(this.o.stateDir, runId);
				this.queue.push({ kind: "resume", entry: p.entry, prepared: p.prepared });
			}
		}
		this.pump();
	}

	/** Resume any needs-human session that has received a human answer. Public for tests. */
	checkAnswers(): void {
		if (this.stopping) return;
		for (const answer of readAnswers(this.o.stateDir)) {
			let match: ParkedState | undefined;
			for (const p of this.parked.values()) {
				if (p.entry.awaitingAnswer && (p.entry.taskId === answer.ref || p.entry.runId === answer.ref)) {
					match = p;
					break;
				}
			}
			// Consume the answer either way (a no-match is a stale/typo ref — dropped).
			clearAnswer(this.o.stateDir, answer.ref);
			if (!match) continue;
			const { entry, prepared } = match;
			this.parked.delete(entry.runId);
			removeParked(this.o.stateDir, entry.runId);
			const resumePrompt =
				`The human answered your question${entry.question ? ` ("${entry.question}")` : ""}:\n\n${answer.answer}\n\n` +
				`Continue from where you left off, taking this answer into account.`;
			this.queue.push({
				kind: "resume",
				entry: { ...entry, prompt: resumePrompt, awaitingAnswer: false, question: undefined },
				prepared,
			});
			if (entry.taskId) this.o.tadu.comment(entry.taskId, `Human answered — resuming: ${answer.answer.slice(0, 300)}`);
			this.o.onDecision?.({
				kind: "answered",
				summary: `Worker ${entry.runId} resumed with a human answer${entry.taskId ? ` (${entry.taskId})` : ""}.`,
				detail: entry.taskId ? { taduTask: entry.taskId } : { worker: entry.runId },
			});
			this.o.logger?.(`[pool] worker ${entry.runId} resumed with human answer`);
		}
		this.pump();
	}

	/** Kill any active workers and drop the queue, bounded so shutdown never wedges. */
	async stop(): Promise<void> {
		this.stopping = true;
		if (this.parkTimer) clearInterval(this.parkTimer);
		this.parkTimer = undefined;
		this.queue.length = 0;
		const handles = [...this.active.values()];
		for (const h of handles) h.kill();
		await Promise.race([
			Promise.allSettled(handles.map((h) => h.done)),
			new Promise((resolve) => setTimeout(resolve, this.o.stopTimeoutMs)),
		]);
		// Parked sessions stay on disk (no live process) and resume after restart.
	}

	private ensureParkTimer(): void {
		if (this.parkTimer || this.o.parkPollMs <= 0 || this.stopping) return;
		this.parkTimer = setInterval(() => {
			this.checkParked();
			this.checkAnswers();
		}, this.o.parkPollMs);
	}

	private pump(): void {
		if (this.stopping) return;
		while (this.active.size < this.o.maxConcurrent && this.queue.length > 0) {
			const item = this.queue.shift();
			if (item) this.start(item);
		}
	}

	private start(item: WorkItem): void {
		const fresh = item.kind === "fresh";
		const id = fresh ? this.o.newId() : item.entry.runId;
		const taskId = fresh ? item.trigger.taduTask : item.entry.taskId;
		const prepared = fresh ? this.o.worktree?.(this.o.cwd, id) : item.prepared;
		if (fresh && prepared?.error) {
			this.o.logger?.(`[pool] worktree isolation failed for ${id}; running un-isolated: ${prepared.error}`);
		}
		const cwd = fresh ? (prepared?.cwd ?? this.o.cwd) : (item.entry.worktreePath ?? this.o.cwd);
		const resumes = fresh ? 0 : item.entry.resumes;
		// A long-running loop (drive-pr) needs a bigger per-cycle timeout; carried
		// across park/resume so every cycle keeps it.
		const timeoutMs = fresh
			? isDrivePrPrompt(item.trigger.text)
				? Math.max(this.o.timeoutMs ?? 0, LONG_RUN_TIMEOUT_MS)
				: this.o.timeoutMs
			: (item.entry.timeoutMs ?? this.o.timeoutMs);
		const spec: WorkerSpec = {
			id,
			taskId,
			// On resume, prepend a cycle counter so a looping worker can bound itself.
			prompt: fresh ? composePrompt(item.trigger) : `[cycle ${resumes}/${this.o.maxResumes}] ${item.entry.prompt}`,
			// Each run gets its own session dir so it can be resumed deterministically.
			sessionDir: join(this.o.sessionDir, id),
			cwd,
			piBin: this.o.piBin,
			model: this.o.model,
			guardrailsPath: this.o.guardrailsPath,
			toolExtensions: this.o.toolExtensions,
			resume: !fresh,
			timeoutMs,
		};
		if (fresh) {
			if (taskId) {
				this.o.tadu.move(taskId, this.o.startStatus);
				this.o.tadu.comment(taskId, `Worker ${id} started${prepared?.isolated ? ` in worktree ${prepared.path}` : ""}.`);
			}
			this.o.onDecision?.({
				kind: "delegate",
				summary: `Delegated to worker ${id}: ${item.trigger.text.slice(0, 100)}`,
				source: item.trigger.source,
				detail: { worker: id, ...(taskId ? { taduTask: taskId } : {}) },
			});
			this.o.logger?.(`[pool] worker ${id} started (active ${this.active.size + 1}/${this.o.maxConcurrent}, queued ${this.queue.length})`);
		} else {
			// Back to the active lane (a needs-human resume was sitting in "blocked").
			if (taskId) {
				this.o.tadu.move(taskId, this.o.startStatus);
				this.o.tadu.comment(taskId, `Worker ${id} resumed (cycle ${resumes}).`);
			}
			this.o.onDecision?.({
				kind: "worker-resume",
				summary: `Resumed worker ${id}${taskId ? ` (${taskId})` : ""} — cycle ${resumes}.`,
				detail: { worker: id, ...(taskId ? { taduTask: taskId } : {}) },
			});
			this.o.logger?.(`[pool] worker ${id} resumed (cycle ${resumes})`);
		}

		const handle = this.o.runner(spec);
		this.active.set(id, handle);
		handle.done
			.then((result) => this.finish(spec, result, prepared, resumes))
			.catch(() =>
				this.finish(
					spec,
					{ id, taskId, ok: false, code: null, signal: null, outputText: "", errorText: "worker handle rejected", timedOut: false },
					prepared,
					resumes,
				),
			)
			.finally(() => {
				this.active.delete(id);
				this.pump();
			});
	}

	private finish(spec: WorkerSpec, result: WorkerResult, prepared: PreparedWorktree | undefined, resumes: number): void {
		const taskId = spec.taskId;
		const req = readParkRequest(this.o.stateDir, spec.id);

		// PARK: the worker asked to wait. Keep the task in flight but dormant; free
		// the slot; resume at the due time. Don't finalise the worktree or status.
		if (req && result.ok && resumes < this.o.maxResumes) {
			clearParkRequest(this.o.stateDir, spec.id);
			const entry: ParkedEntry = {
				runId: spec.id,
				taskId,
				worktreePath: spec.cwd,
				dueAt: req.dueAt,
				prompt: req.prompt,
				reason: req.reason,
				resumes: resumes + 1,
				timeoutMs: spec.timeoutMs,
				awaitingAnswer: req.awaitingAnswer,
				question: req.question,
			};
			this.parked.set(spec.id, { entry, prepared });
			writeParked(this.o.stateDir, entry);
			if (req.awaitingAnswer) {
				// Blocked on a human decision: surface it on the board, PUSH the
				// question, and wait for an answer (woken by the reply, not the timer).
				const question = req.question ?? "(no question given)";
				if (taskId) {
					this.o.tadu.move(taskId, this.o.failureStatus); // "blocked" lane while awaiting
					this.o.tadu.comment(taskId, `Blocked — needs a human decision:\n${question}`);
				}
				this.o.onNeedsHuman?.({ question, runId: spec.id, taskId });
				this.o.onDecision?.({
					kind: "needs-human",
					summary: `Worker ${spec.id} needs a human answer${taskId ? ` (${taskId})` : ""}: ${question.slice(0, 120)}`,
					detail: { runId: spec.id, ...(taskId ? { taduTask: taskId } : {}) },
				});
				this.o.logger?.(`[pool] worker ${spec.id} blocked, awaiting human answer (reply with: --answer ${taskId ?? spec.id})`);
			} else {
				const when = new Date(entry.dueAt).toISOString();
				if (taskId) this.o.tadu.comment(taskId, `Parked until ${when}${entry.reason ? ` (${entry.reason})` : ""}.`);
				this.o.onDecision?.({
					kind: "park",
					summary: `Worker ${spec.id} parked until ${when}${entry.reason ? `: ${entry.reason}` : ""}.`,
					detail: taskId ? { taduTask: taskId } : { worker: spec.id },
				});
				this.o.logger?.(`[pool] worker ${spec.id} parked until ${when} (cycle ${entry.resumes})`);
			}
			this.ensureParkTimer();
			return;
		}

		// TERMINAL: clean up park state, finalise the worktree, release the task.
		clearParkRequest(this.o.stateDir, spec.id);
		removeParked(this.o.stateDir, spec.id);
		this.parked.delete(spec.id);
		const wt = prepared?.isolated ? prepared.finalize() : undefined;
		const wtNote = wt?.changed ? `\n\nChanges left in worktree ${wt.path} (branch ${wt.branch}) for review.` : "";
		const loopExceeded = req != null && resumes >= this.o.maxResumes;

		if (loopExceeded) {
			// A still-working loop that ran out of resume budget is a hand-off, not a
			// failure: park it back for review instead of marking it blocked.
			if (taskId) {
				this.o.tadu.move(taskId, this.o.successStatus);
				this.o.tadu.comment(taskId, `Worker ${spec.id} paused: resume budget (${this.o.maxResumes} cycles) exhausted — left for review.${wtNote}`);
			}
			this.o.onDecision?.({
				kind: "park-exhausted",
				summary: `Worker ${spec.id} hit the resume budget (${this.o.maxResumes} cycles)${taskId ? ` (${taskId})` : ""}; paused for review.`,
				detail: taskId ? { taduTask: taskId } : { worker: spec.id },
			});
			this.o.logger?.(`[pool] worker ${spec.id} paused: resume budget exhausted`);
		} else if (result.ok) {
			if (taskId) {
				this.o.tadu.move(taskId, this.o.successStatus);
				this.o.tadu.comment(taskId, `Worker ${spec.id} done.\n\n${result.outputText.slice(0, 1500) || "(no output)"}${wtNote}`);
			}
			this.o.onDecision?.({
				kind: "worker",
				summary: `Worker ${spec.id} completed${taskId ? ` (${taskId})` : ""}${wt?.changed ? " — worktree preserved" : ""}.`,
				detail: { ...(taskId ? { taduTask: taskId } : { worker: spec.id }), ...(wt?.changed ? { worktree: wt.path, branch: wt.branch } : {}) },
			});
			this.o.logger?.(`[pool] worker ${spec.id} completed${wt?.changed ? ` (worktree preserved: ${wt.path})` : ""}`);
		} else {
			const reason = result.timedOut ? "timed out" : `exit ${result.code ?? "?"}`;
			if (taskId) {
				this.o.tadu.move(taskId, this.o.failureStatus);
				this.o.tadu.comment(taskId, `Worker ${spec.id} failed (${reason}).\n\n${result.errorText.slice(0, 1500)}${wtNote}`);
			}
			const summary = `Delegated task ${taskId ?? spec.id} failed (${reason}).`;
			this.o.onDecision?.({ kind: "escalate", summary, detail: taskId ? { taduTask: taskId } : { worker: spec.id } });
			this.o.onEscalate?.(summary);
			this.o.logger?.(`[pool] worker ${spec.id} failed (${reason})`);
		}
		if (taskId) this.inFlightTasks.delete(taskId);
	}
}

/** Build the worker's prompt: the task plus a one-shot worker instruction. */
export function composePrompt(trigger: Trigger): string {
	const tag = trigger.taduTask ? `(TADU ${trigger.taduTask}) ` : "";
	return `${tag}${trigger.text}\n\nYou are an autonomous worker running this task to completion in a non-interactive session. Do the work, then end your reply with a concise summary of what you did and any follow-ups — that summary is recorded against the task. If you must wait for an external change (CI, a review), use the park tool to resume later instead of blocking.`;
}
