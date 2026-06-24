/**
 * Decision spine — the append-only audit log of autonomous actions.
 *
 * Every meaningful thing the agent does on its own (a guardrail block, a brain
 * write, a goal continuation, an escalation) appends one structured JSON line to
 * `decisions.jsonl`. It is the source of truth behind every oversight surface
 * (/status, digests, the future dashboard) and answers "what did my agent do
 * while I was away?" with `jq`/`rg`, no service required.
 *
 * Phase 1+ will additionally mirror decisions onto the active TADU task (as a
 * comment) when a trigger created one; `recordDecision` is the single seam for
 * that. Writes are best-effort and never throw — auditing must not break a turn.
 *
 * No Pi imports; tested against a tmpdir via AGENT_TOOLKIT_STATE_DIR.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A single autonomous decision/action record. */
export type Decision = {
	/** ISO 8601 timestamp. */
	ts: string;
	/** Category, e.g. "guardrail-block", "brain-write", "goal-continue", "escalate". */
	kind: string;
	/** One-line human-readable summary. */
	summary: string;
	/** What triggered the work (e.g. "slack", "cron:heartbeat", "interactive"). */
	source?: string;
	/** Optional structured payload for richer queries. */
	detail?: Record<string, unknown>;
};

/** Resolve the toolkit state directory (XDG-style; env-overridable for tests). */
export function stateDir(): string {
	return (
		process.env.AGENT_TOOLKIT_STATE_DIR ??
		join(homedir(), ".local", "state", "agent-toolkit")
	);
}

/** Path to the decisions log. */
export function decisionsPath(): string {
	return join(stateDir(), "decisions.jsonl");
}

/** Append a decision to the spine. Stamps `ts` when omitted. Never throws. */
export function recordDecision(entry: Omit<Decision, "ts"> & { ts?: string }): void {
	try {
		const line = JSON.stringify({
			ts: entry.ts ?? new Date().toISOString(),
			kind: entry.kind,
			summary: entry.summary,
			...(entry.source ? { source: entry.source } : {}),
			...(entry.detail ? { detail: entry.detail } : {}),
		});
		const path = decisionsPath();
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${line}\n`, "utf8");
	} catch {
		// Auditing is best-effort; a logging failure must never break a turn.
	}
}

/** Read the most recent `limit` decisions (newest last). Tolerates bad lines. */
export function readRecent(limit = 10): Decision[] {
	const path = decisionsPath();
	if (!existsSync(path)) return [];
	let lines: string[];
	try {
		lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
	} catch {
		return [];
	}
	const out: Decision[] = [];
	for (const line of lines.slice(-limit)) {
		try {
			out.push(JSON.parse(line) as Decision);
		} catch {
			// Skip malformed lines rather than fail the whole read.
		}
	}
	return out;
}

/** Count total decisions recorded (cheap line count). */
export function countDecisions(): number {
	const path = decisionsPath();
	if (!existsSync(path)) return 0;
	try {
		return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").length;
	} catch {
		return 0;
	}
}
