/**
 * Notify — the push channel, gated by the escalation budget.
 *
 * Everything an autonomous loop wants to surface goes through here. It ALWAYS
 * records to the decision spine (the pull channel), then asks the escalation
 * rate-limiter whether a push is warranted; if so it appends to notify.jsonl
 * (which the daemon's notify-watcher delivers to Slack). When the budget is
 * exhausted the notice stays pull-only — the agent keeps working, it does not
 * spam. This is the "notify-after, never thrash" rail in code.
 *
 * Used both in-session (extensions) and by tools, so it is plain fs + the pure
 * escalation core. Best-effort: failures never throw.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	DEFAULT_BUDGET,
	type EscalationBudget,
	type EscalationState,
	evaluateEscalation,
	INITIAL_ESCALATION_STATE,
} from "../../daemon/escalation.ts";
import { recordDecision, stateDir } from "./decisions.ts";

export type Notice = {
	id: string;
	ts: string;
	summary: string;
	kind: string;
	source?: string;
	acked?: boolean;
};

export type NotifyInput = {
	summary: string;
	/** Decision kind; defaults to "escalate". */
	kind?: string;
	source?: string;
	detail?: Record<string, unknown>;
};

export type NotifyOptions = {
	budget?: EscalationBudget;
	now?: number;
	/** Bypass the rate-limiter (e.g. a scheduled digest that must always push). */
	force?: boolean;
};

export function notifyPath(): string {
	return join(stateDir(), "notify.jsonl");
}
function escalationStatePath(): string {
	return join(stateDir(), "escalation-state.json");
}

/** Record to the spine; push to notify.jsonl iff the escalation budget allows. */
export function notify(input: NotifyInput, options: NotifyOptions = {}): { pushed: boolean } {
	const now = options.now ?? Date.now();
	recordDecision({
		kind: input.kind ?? "escalate",
		summary: input.summary,
		source: input.source,
		detail: input.detail,
		ts: new Date(now).toISOString(),
	});

	if (!options.force) {
		const state = readState();
		const decision = evaluateEscalation(state, options.budget ?? DEFAULT_BUDGET, now);
		writeState(decision.state);
		if (!decision.allowed) return { pushed: false };
	}

	const notice: Notice = {
		id: randomUUID(),
		ts: new Date(now).toISOString(),
		summary: input.summary,
		kind: input.kind ?? "escalate",
		source: input.source,
		acked: false,
	};
	try {
		const path = notifyPath();
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(notice)}\n`, "utf8");
	} catch {
		return { pushed: false };
	}
	return { pushed: true };
}

/** Read notices, optionally only those not yet acknowledged. */
export function readNotices(options: { unackedOnly?: boolean } = {}): Notice[] {
	const path = notifyPath();
	if (!existsSync(path)) return [];
	const out: Notice[] = [];
	try {
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (line.trim() === "") continue;
			const notice = JSON.parse(line) as Notice;
			if (options.unackedOnly && notice.acked) continue;
			out.push(notice);
		}
	} catch {
		return out;
	}
	return out;
}

/** Mark a notice acknowledged (e.g. from the dashboard). */
export function ackNotice(id: string): boolean {
	const path = notifyPath();
	if (!existsSync(path)) return false;
	const all = readNotices();
	let found = false;
	const next = all.map((notice) => {
		if (notice.id === id) {
			found = true;
			return { ...notice, acked: true };
		}
		return notice;
	});
	if (found) writeFileSync(path, `${next.map((n) => JSON.stringify(n)).join("\n")}\n`, "utf8");
	return found;
}

function readState(): EscalationState {
	const path = escalationStatePath();
	if (!existsSync(path)) return INITIAL_ESCALATION_STATE;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as EscalationState;
	} catch {
		return INITIAL_ESCALATION_STATE;
	}
}

function writeState(state: EscalationState): void {
	try {
		const path = escalationStatePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(state), "utf8");
	} catch {
		// best-effort
	}
}
