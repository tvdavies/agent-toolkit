/**
 * Worker — run one discrete task as its own `pi -p` (non-interactive) session.
 *
 * A worker is a short-lived subprocess: it processes a single prompt to
 * completion, persists its session JSONL (so it shows in the dashboard), then
 * exits. This is the unit the fleet delegates to so coding/long work never
 * blocks the resident orchestrator, and so every task can run concurrently.
 *
 * Workers run with `--no-extensions` for predictable one-shot behaviour (no
 * resident-session extension loops); built-in tools stay enabled.
 * The spawn is injectable so the lifecycle (capture, exit, timeout) is tested
 * without pi.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { AGENT_ACTOR } from "../extensions/lib/tadu-actor.ts";

export type WorkerSpec = {
	/** Stable run id (also the session/log label). */
	id: string;
	/** TADU task this run advances, when delegated work. */
	taskId?: string;
	/** The prompt the worker processes. */
	prompt: string;
	/** Directory pi writes the worker's session JSONL into. */
	sessionDir: string;
	/** Working directory for the run. */
	cwd: string;
	/** Absolute path to the pi binary. */
	piBin: string;
	/** Model override (provider/id), as the resident uses. */
	model?: string;
	/** Absolute path to the guardrails extension, loaded so workers keep the
	 *  safety floor despite running with --no-extensions. */
	guardrailsPath?: string;
	/** Extra capability extensions to load (e.g. the slim worktree tools). */
	toolExtensions?: string[];
	/** Resume an existing session in sessionDir (--continue) instead of a fresh one. */
	resume?: boolean;
	/** Hard timeout; the worker is killed past it. Default 15 min. */
	timeoutMs?: number;
};

export type WorkerResult = {
	id: string;
	taskId?: string;
	ok: boolean;
	code: number | null;
	signal: NodeJS.Signals | null;
	/** Trimmed stdout — the final assistant text in pi's `-p` text mode. */
	outputText: string;
	/** Tail of stderr, for diagnosing a failure. */
	errorText: string;
	timedOut: boolean;
};

export type SpawnFn = typeof nodeSpawn;

export type WorkerHandle = {
	id: string;
	kill: () => void;
	done: Promise<WorkerResult>;
};

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_CAPTURE = 64 * 1024; // cap captured output so a chatty run can't grow unbounded

/** Build the pi argument vector for a worker run. */
export function workerArgs(spec: WorkerSpec): string[] {
	const args = ["-p"];
	// Resume the same per-run session (full context) instead of starting fresh.
	if (spec.resume) args.push("--continue");
	args.push("--no-extensions", "--session-dir", spec.sessionDir);
	// Re-enable just the safety floor + chosen capabilities (an explicit -e
	// survives --no-extensions).
	if (spec.guardrailsPath) args.push("-e", spec.guardrailsPath);
	for (const ext of spec.toolExtensions ?? []) args.push("-e", ext);
	if (spec.model) args.push("--model", spec.model);
	args.push(spec.prompt);
	return args;
}

/** Spawn a worker subprocess. `spawn` is injected for tests. */
export function runWorker(spec: WorkerSpec, spawn: SpawnFn = nodeSpawn): WorkerHandle {
	try {
		mkdirSync(spec.sessionDir, { recursive: true });
	} catch {
		// best-effort; pi will surface a clearer error if the dir is unusable
	}

	const child: ChildProcess = spawn(spec.piBin, workerArgs(spec), {
		cwd: spec.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		// Curated env: a worker has no business holding the daemon's Slack/webhook
		// secrets or the dashboard token. Provider keys + PATH/HOME (where pi keeps
		// its auth) are kept so the run still works. The run id lets the park tool
		// record which session to resume.
		env: { ...workerEnv(), AGENT_TOOLKIT_WORKER_RUN_ID: spec.id },
		// Own process group, so a timeout/stop kills the worker AND any tool
		// subprocesses it spawned (otherwise a grandchild can hold the output pipe
		// open and `close` never fires).
		detached: true,
	});

	// Signal the whole group; fall back to the child alone if the group is gone.
	const killGroup = (signal: NodeJS.Signals): void => {
		try {
			if (typeof child.pid === "number") process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch {
			try {
				child.kill(signal);
			} catch {
				// already exited
			}
		}
	};

	let out = "";
	let err = "";
	let timedOut = false;
	let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
	child.stdout?.on("data", (chunk: Buffer) => {
		if (out.length < MAX_CAPTURE) out += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		if (err.length < MAX_CAPTURE) err += chunk.toString("utf8");
	});

	// SIGTERM now, SIGKILL the whole group if it has not closed shortly after — so
	// neither a timeout nor an operator stop can wedge on an unresponsive child.
	const requestStop = (): void => {
		killGroup("SIGTERM");
		if (!hardKillTimer) hardKillTimer = setTimeout(() => killGroup("SIGKILL"), 3000);
	};

	const timer = setTimeout(() => {
		timedOut = true;
		requestStop();
	}, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);

	const done = new Promise<WorkerResult>((resolve) => {
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			clearTimeout(timer);
			if (hardKillTimer) clearTimeout(hardKillTimer);
			resolve({
				id: spec.id,
				taskId: spec.taskId,
				ok: !timedOut && code === 0,
				code,
				signal,
				outputText: out.trim(),
				errorText: err.trim().slice(-2000),
				timedOut,
			});
		};
		child.on("error", (e) => {
			err += `${err ? "\n" : ""}${(e as Error).message}`;
			finish(null, null);
		});
		child.on("close", (code, signal) => finish(code, signal));
	});

	return { id: spec.id, kill: requestStop, done };
}

/** Daemon env minus the secrets/tokens a worker must never see. */
export function workerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const denied = /^SLACK_|^WEBHOOK_|SIGNING_SECRET|DASHBOARD_TOKEN|SELF_UPDATE_TOKEN/;
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (!denied.test(key)) out[key] = value;
	}
	// A worker is the agent doing work: any `tadu` write it makes (progress
	// comments, lane moves via a skill) is attributed to the agent, never the
	// human — so the watch loop does not treat the agent's own work as control input.
	out.TADU_ACTOR = AGENT_ACTOR;
	return out;
}
