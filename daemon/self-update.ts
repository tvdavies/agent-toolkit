/**
 * Self-update orchestration — the daemon side of "the agent loads its own change".
 *
 * Flow (mirrors park/resume, with the daemon as the safe actor):
 *  1. The agent edits the live checkout and calls the `apply_update` tool, which
 *     writes an update request.
 *  2. apply(): validate the working tree with the root toolkit test gate. Red → notify + stop (the
 *     running daemon keeps the old code in memory; the bad edit stays uncommitted to
 *     fix). Green → commit it, record a restart marker (with the last-good commit as
 *     the rollback target), and restart (drain + exit; systemd re-execs new code).
 *  3. The launcher's preflight reverts to the rollback target if the new code keeps
 *     failing to boot; onBoot() reports such a rollback.
 *  4. onHealthy(): once the new daemon is confirmed healthy, clear the marker, record
 *     the new commit as last-good, and resume the agent.
 *
 * Git, validation, restart, notify and resume are all injected, so the (sensitive)
 * sequencing is tested without touching a real repo or process.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	clearRestartMarker,
	clearRolledBackFlag,
	clearUpdateRequest,
	readLastGoodCommit,
	readRestartMarker,
	readRolledBackFlag,
	type RestartMarker,
	type UpdateRequest,
	writeLastGoodCommit,
	writeRestartMarker,
} from "../extensions/lib/update.ts";

export type GitOps = {
	head: () => string | undefined;
	hasChanges: () => boolean;
	commitAll: (message: string) => string | undefined;
	resetHard: (commit: string) => boolean;
};

export type Validator = () => Promise<{ ok: boolean; output: string }>;

export type SelfUpdateDeps = {
	stateDir: string;
	git: GitOps;
	/** The validation gate; only a green result leads to a restart. */
	validate: Validator;
	notify: (summary: string, opts?: { force?: boolean }) => void;
	record: (kind: string, summary: string, detail?: Record<string, unknown>) => void;
	/** Drain and exit(0) so systemd re-execs the (now committed) new code. */
	restart: () => void;
	/** Deliver a message to the agent after a successful update. */
	resume: (prompt: string) => void;
	now: () => number;
	logger?: (message: string) => void;
};

const short = (c?: string): string => (c ? c.slice(0, 8) : "?");

/**
 * Whether an update request is authorised to run — it must carry the daemon's
 * capability token (injected only into the resident's env). A forged request from a
 * worker omits or guesses it and is refused. The token must be non-empty so a daemon
 * that somehow has no token never accepts an unauthenticated request.
 */
export function isAuthorisedRequest(req: { token?: string }, daemonToken: string): boolean {
	return typeof daemonToken === "string" && daemonToken.length > 0 && req.token === daemonToken;
}

export class SelfUpdater {
	private applying = false;
	private readonly o: SelfUpdateDeps;

	constructor(deps: SelfUpdateDeps) {
		this.o = deps;
	}

	/** Whether a self-update restart is mid-flight (the boot health gate uses this). */
	pendingRestart(): boolean {
		return readRestartMarker(this.o.stateDir) !== undefined;
	}

	/** Validate a pending request and, if green, commit + restart onto the new code. */
	async apply(req: UpdateRequest): Promise<void> {
		if (this.applying) return;
		this.applying = true;
		try {
			const v = await this.o.validate();
			if (!v.ok) {
				this.o.notify(`Self-update NOT applied — validation (bun test) failed: ${req.reason}`, { force: true });
				this.o.record("self-update-rejected", `Self-update rejected, tests failed: ${req.reason}`, { output: v.output.slice(-500) });
				clearUpdateRequest(this.o.stateDir);
				this.o.logger?.("[self-update] validation failed; not restarting");
				return;
			}
			// The rollback target is the commit the RUNNING daemon booted from (recorded on
			// the last healthy boot) — correct for both an edit and a `git pull`.
			const rollbackTo = readLastGoodCommit(this.o.stateDir) ?? this.o.git.head();
			let appliedCommit: string | undefined;
			if (this.o.git.hasChanges()) {
				appliedCommit = this.o.git.commitAll(`self-update: ${req.reason}`);
				// A failed commit must NOT restart onto an uncommitted tree with last-good
				// still pointing at the old commit (a half-applied, hard-to-recover state).
				if (!appliedCommit) {
					this.o.notify(`Self-update NOT applied — could not commit the change: ${req.reason}`, { force: true });
					this.o.record("self-update-rejected", `Self-update rejected, commit failed: ${req.reason}`);
					clearUpdateRequest(this.o.stateDir);
					this.o.logger?.("[self-update] commit failed; not restarting");
					return;
				}
			} else {
				appliedCommit = this.o.git.head();
			}
			const marker: RestartMarker = {
				rollbackTo,
				appliedCommit,
				reason: req.reason,
				resumePrompt: req.resumePrompt,
				runId: req.runId,
				attempts: 0,
				ts: new Date(this.o.now()).toISOString(),
			};
			writeRestartMarker(this.o.stateDir, marker);
			clearUpdateRequest(this.o.stateDir);
			this.o.record("self-update-applying", `Applying self-update: ${req.reason} (commit ${short(appliedCommit)}, rollback ${short(rollbackTo)}).`, { appliedCommit, rollbackTo });
			this.o.notify(`Applying self-update: ${req.reason} — tests pass; restarting to load it.`, { force: true });
			this.o.logger?.(`[self-update] validated; restarting onto ${short(appliedCommit)} (rollback ${short(rollbackTo)})`);
			this.o.restart();
		} finally {
			this.applying = false; // the process exits on restart; this matters only if restart is a no-op (tests)
		}
	}

	/** Early on boot: surface a rollback the launcher performed on the previous boot. */
	onBoot(): void {
		const rb = readRolledBackFlag(this.o.stateDir);
		if (!rb) return;
		this.o.notify(`Self-update '${rb.reason}' FAILED to boot and was rolled back to ${short(rb.to)}. The change is reverted — investigate before retrying.`, { force: true });
		this.o.record("self-update-rolledback", `Self-update '${rb.reason}' rolled back to ${short(rb.to)} after failing to boot.`, { from: rb.from, to: rb.to });
		clearRolledBackFlag(this.o.stateDir);
	}

	/**
	 * Resume the agent once the freshly-applied update has come up (the resident is
	 * alive). Called EARLY in probation — it does NOT yet clear the marker or advance
	 * last-good, so a later crash still rolls back. Idempotent.
	 */
	resumeAfterUpdate(): void {
		const marker = readRestartMarker(this.o.stateDir);
		if (!marker || this.resumed) return;
		this.resumed = true;
		this.o.record("self-update-live", `Self-update '${marker.reason}' is live (on probation).`, { appliedCommit: marker.appliedCommit });
		this.o.logger?.(`[self-update] '${marker.reason}' live; on probation until the settle window passes`);
		if (marker.resumePrompt) this.o.resume(marker.resumePrompt);
	}

	/**
	 * Commit-point: the new code survived the settle window healthy. Only NOW clear the
	 * marker (ending rollback eligibility) and advance last-good to the new commit, so a
	 * crash BEFORE this point always still has a marker + a good rollback target.
	 */
	commitPoint(): void {
		const marker = readRestartMarker(this.o.stateDir);
		if (!marker) return;
		const head = this.o.git.head();
		clearRestartMarker(this.o.stateDir);
		if (head) writeLastGoodCommit(this.o.stateDir, head);
		this.o.notify(`Self-update applied successfully: ${marker.reason}.`, { force: true });
		this.o.record("self-update-applied", `Self-update applied, healthy through the settle window: ${marker.reason} (${short(head)}).`, { commit: head });
		this.o.logger?.(`[self-update] '${marker.reason}' passed probation on ${short(head)}; marker cleared`);
	}

	/** Plain healthy boot (no update in flight): record where we are as the rollback
	 *  baseline so the very first self-update has a good target. */
	recordLastGood(): void {
		if (readRestartMarker(this.o.stateDir)) return; // mid-update — last-good is advanced at commitPoint
		const head = this.o.git.head();
		if (head) writeLastGoodCommit(this.o.stateDir, head);
	}

	private resumed = false;
}

/** Real git operations over a checkout (injectable for tests). */
export function gitOps(repoDir: string): GitOps {
	const run = (args: string[]) => spawnSync("git", args, { cwd: repoDir, encoding: "utf8", timeout: 10_000 });
	const head = (): string | undefined => {
		const r = run(["rev-parse", "HEAD"]);
		return r.status === 0 ? r.stdout.trim() : undefined;
	};
	return {
		head,
		hasChanges: () => {
			const r = run(["status", "--porcelain"]);
			return r.status === 0 && r.stdout.trim().length > 0;
		},
		commitAll: (message) => {
			if (run(["add", "-A"]).status !== 0) return undefined;
			// Attribute self-update commits to the agent so they are distinguishable from
			// human commits in the history.
			const c = run(["-c", "user.name=agent-toolkit[bot]", "-c", "user.email=agent-toolkit@localhost", "commit", "-m", message]);
			return c.status === 0 ? head() : undefined;
		},
		resetHard: (commit) => run(["reset", "--hard", commit]).status === 0,
	};
}

/** The validation gate for the root toolkit checkout (with the agent's uncommitted edits).
 *
 * The vendored Brain runtime has its own Bun workspace and test script; running
 * bare `bun test` from the root also discovers Brain's much larger upstream
 * suite and can exceed the self-update watchdog. Keep this gate scoped to the
 * toolkit files that are live-loaded by the daemon/Pi package.
 */
export function bunTestValidator(repoDir: string, bunBin = process.env.AGENT_TOOLKIT_BUN_BIN ?? "bun", timeoutMs = 120_000): Validator {
	return () =>
		new Promise((resolve) => {
			let out = "";
			const cap = (c: Buffer) => {
				if (out.length < 8192) out += c.toString("utf8");
			};
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(bunBin, ["test", "./daemon", "./extensions", "./bin"], { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"] });
			} catch (e) {
				resolve({ ok: false, output: `failed to spawn ${bunBin}: ${(e as Error).message}` });
				return;
			}
			child.stdout?.on("data", cap);
			child.stderr?.on("data", cap);
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// already gone
				}
				resolve({ ok: false, output: "validation timed out" });
			}, timeoutMs);
			child.on("error", (e) => {
				clearTimeout(timer);
				resolve({ ok: false, output: `validator error: ${e.message}` });
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ ok: code === 0, output: out.slice(-2000) });
			});
		});
}
