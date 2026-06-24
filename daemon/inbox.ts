/**
 * Trigger inbox — the single chokepoint through which anything (cron, Slack,
 * webhooks, the CLI) asks the resident agent to do work.
 *
 * Phase 1 uses a durable, append-only `inbox.jsonl` as the reliable transport.
 * `toolkit-trigger` appends; the daemon drains via a persisted line cursor.
 * (Triggers also surface in TADU as work items for visibility — that is done in
 * the CLI, best-effort, and is not on this reliable path.)
 *
 * The record shape and dedupe are pure and tested; FileInbox is thin fs I/O
 * exercised against a tmpdir.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Where a trigger came from, used to route a reply back to its source. */
export type TriggerOrigin = {
	/** e.g. "slack", "webhook". */
	kind: string;
	channel?: string;
	threadTs?: string;
	user?: string;
};

/** One unit of work to hand to the agent. */
export type Trigger = {
	id: string;
	/** The prompt text delivered to the agent. */
	text: string;
	/** Where it came from, e.g. "cli", "cron:heartbeat", "slack". */
	source?: string;
	/** ISO 8601 creation time. */
	ts?: string;
	/** Collapses repeats (e.g. the same Slack message) across drains. */
	dedupeKey?: string;
	/** Linked TADU task id, when one was created for visibility. */
	taduTask?: string;
	/** Reply destination, for triggers that expect a response (e.g. a Slack DM). */
	origin?: TriggerOrigin;
};

/** Drop triggers already seen (by dedupeKey, else id). Mutates `seen`; returns fresh. */
export function dedupe(incoming: Trigger[], seen: Set<string>): Trigger[] {
	const fresh: Trigger[] = [];
	for (const trigger of incoming) {
		const key = trigger.dedupeKey ?? trigger.id;
		if (seen.has(key)) continue;
		seen.add(key);
		fresh.push(trigger);
	}
	return fresh;
}

/** A durable append-only inbox with a persisted consumption cursor. */
export class FileInbox {
	private readonly path: string;
	private readonly cursorPath: string;

	constructor(path: string) {
		this.path = path;
		this.cursorPath = `${path}.cursor`;
	}

	/** Append a trigger. Fills id/ts when absent. Returns the stored record. */
	append(input: Partial<Trigger> & { text: string }): Trigger {
		const trigger: Trigger = {
			id: input.id ?? randomUUID(),
			text: input.text,
			ts: input.ts ?? new Date().toISOString(),
			...(input.source ? { source: input.source } : {}),
			...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
			...(input.taduTask ? { taduTask: input.taduTask } : {}),
			...(input.origin ? { origin: input.origin } : {}),
		};
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(this.path, `${JSON.stringify(trigger)}\n`, "utf8");
		return trigger;
	}

	/** Return triggers appended since the last drain and advance the cursor. */
	drain(): Trigger[] {
		const all = this.readAll();
		const cursor = this.readCursor();
		const fresh = all.slice(cursor);
		this.writeCursor(all.length);
		return fresh;
	}

	private readAll(): Trigger[] {
		if (!existsSync(this.path)) return [];
		const out: Trigger[] = [];
		for (const line of readFileSync(this.path, "utf8").split("\n")) {
			if (line.trim() === "") continue;
			try {
				out.push(JSON.parse(line) as Trigger);
			} catch {
				// Skip a corrupt line rather than stall the whole inbox.
			}
		}
		return out;
	}

	private readCursor(): number {
		if (!existsSync(this.cursorPath)) return 0;
		const value = Number(readFileSync(this.cursorPath, "utf8").trim());
		return Number.isFinite(value) && value >= 0 ? value : 0;
	}

	private writeCursor(value: number): void {
		mkdirSync(dirname(this.cursorPath), { recursive: true });
		writeFileSync(this.cursorPath, String(value), "utf8");
	}
}
