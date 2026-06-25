/**
 * Park/resume coordination (pure fs).
 *
 * A worker that must wait for an external change (CI, a review, a deploy) calls
 * the `park` tool, which writes a PARK REQUEST and ends the turn. The worker
 * process exits — nothing is held open while waiting. The daemon's worker pool
 * reads the request, records a durable PARKED ENTRY, and at the due time resumes
 * that exact session (`pi --continue --session-dir <per-run>`), so the agent
 * wakes with full prior context. This module is the shared on-disk contract
 * between the park extension (writer) and the pool (reader); it carries no Pi
 * deps so both can use it and it is unit-tested directly.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Written by a worker via the `park`/`needs_human` tools; consumed by the pool. */
export type ParkRequest = {
	runId: string;
	dueAt: number;
	prompt: string;
	reason?: string;
	/** Set by needs_human: the pool pushes the question and waits for an answer
	 *  (woken by a human reply, not just the dueAt safety timer). */
	awaitingAnswer?: boolean;
	question?: string;
};

/** The pool's durable record of a dormant session awaiting resume. */
export type ParkedEntry = {
	runId: string;
	taskId?: string;
	worktreePath?: string;
	dueAt: number;
	prompt: string;
	reason?: string;
	resumes: number;
	/** Carried so a long-running loop (e.g. drive-pr) keeps its timeout on resume. */
	timeoutMs?: number;
	/** Waiting on a human answer (needs_human) rather than just the dueAt timer. */
	awaitingAnswer?: boolean;
	question?: string;
};

/** A human's answer to a needs_human question, keyed by task id or run id. */
export type WorkerAnswer = { ref: string; answer: string; ts: string };

export const MIN_PARK_SECONDS = 30;
export const MAX_PARK_SECONDS = 3600;
export const DEFAULT_PARK_SECONDS = 180;

/** Keep a wait sane: at least 30s (no busy-loop), at most 1h (bounded dormancy). */
export function clampParkSeconds(seconds: number): number {
	if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_PARK_SECONDS;
	return Math.min(MAX_PARK_SECONDS, Math.max(MIN_PARK_SECONDS, Math.floor(seconds)));
}

const requestsDir = (stateDir: string) => join(stateDir, "worker-park-requests");
const parkedDir = (stateDir: string) => join(stateDir, "worker-parked");
const reqPath = (stateDir: string, runId: string) => join(requestsDir(stateDir), `${runId}.json`);
const parkedPath = (stateDir: string, runId: string) => join(parkedDir(stateDir), `${runId}.json`);

export function writeParkRequest(stateDir: string, req: ParkRequest): void {
	mkdirSync(requestsDir(stateDir), { recursive: true });
	writeFileSync(reqPath(stateDir, req.runId), JSON.stringify(req), "utf8");
}

export function readParkRequest(stateDir: string, runId: string): ParkRequest | undefined {
	const path = reqPath(stateDir, runId);
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as ParkRequest;
	} catch {
		return undefined;
	}
}

export function clearParkRequest(stateDir: string, runId: string): void {
	try {
		rmSync(reqPath(stateDir, runId), { force: true });
	} catch {
		// best-effort
	}
}

export function writeParked(stateDir: string, entry: ParkedEntry): void {
	mkdirSync(parkedDir(stateDir), { recursive: true });
	writeFileSync(parkedPath(stateDir, entry.runId), JSON.stringify(entry), "utf8");
}

export function removeParked(stateDir: string, runId: string): void {
	try {
		rmSync(parkedPath(stateDir, runId), { force: true });
	} catch {
		// best-effort
	}
}

/** All durable parked entries (used to re-arm timers after a daemon restart). */
export function readAllParked(stateDir: string): ParkedEntry[] {
	const dir = parkedDir(stateDir);
	if (!existsSync(dir)) return [];
	const out: ParkedEntry[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		try {
			out.push(JSON.parse(readFileSync(join(dir, file), "utf8")) as ParkedEntry);
		} catch {
			// skip a corrupt record
		}
	}
	return out;
}

// --- human answers to needs_human questions -------------------------------
const answersDir = (stateDir: string) => join(stateDir, "worker-answers");
const refSlug = (ref: string) => ref.replace(/[^\w.-]/g, "_").slice(0, 120);
const answerPath = (stateDir: string, ref: string) => join(answersDir(stateDir), `${refSlug(ref)}.json`);

/** Record a human's answer, keyed by a task id or run id (the CLI/dashboard write this). */
export function writeAnswer(stateDir: string, ref: string, answer: string, ts: string): void {
	mkdirSync(answersDir(stateDir), { recursive: true });
	writeFileSync(answerPath(stateDir, ref), JSON.stringify({ ref, answer, ts } satisfies WorkerAnswer), "utf8");
}

/** All pending answers (the pool matches these against parked needs_human entries). */
export function readAnswers(stateDir: string): WorkerAnswer[] {
	const dir = answersDir(stateDir);
	if (!existsSync(dir)) return [];
	const out: WorkerAnswer[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		try {
			out.push(JSON.parse(readFileSync(join(dir, file), "utf8")) as WorkerAnswer);
		} catch {
			// skip a corrupt record
		}
	}
	return out;
}

export function clearAnswer(stateDir: string, ref: string): void {
	try {
		rmSync(answerPath(stateDir, ref), { force: true });
	} catch {
		// best-effort
	}
}
