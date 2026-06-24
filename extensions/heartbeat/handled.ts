/**
 * Handled-items store — TTL dedupe so the heartbeat never re-flags the same item
 * (a Slack message, a PR, a failure) across runs.
 *
 * Each entry expires after a TTL; the heartbeat lists the live entries to the
 * agent so it knows what it has already dealt with, and records new ones via the
 * heartbeat_note tool. Plain JSON on disk with an injectable clock — tested
 * directly. Best-effort: read/write failures degrade to "nothing handled".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type HandledEntry = {
	key: string;
	expiresAt: number;
	note?: string;
};

export const DEFAULT_TTL_MS = 86_400_000; // 24h

export class HandledStore {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	/** Mark a key handled until `now + ttlMs`. */
	add(key: string, ttlMs = DEFAULT_TTL_MS, note?: string, now = Date.now()): void {
		const entries = this.readAll().filter((entry) => entry.key !== key);
		entries.push({ key, expiresAt: now + ttlMs, ...(note ? { note } : {}) });
		this.write(entries);
	}

	/** Whether a key is currently handled (present and not expired). */
	isHandled(key: string, now = Date.now()): boolean {
		return this.readAll().some((entry) => entry.key === key && entry.expiresAt > now);
	}

	/** Live (non-expired) entries. */
	list(now = Date.now()): HandledEntry[] {
		return this.readAll().filter((entry) => entry.expiresAt > now);
	}

	/** Drop expired entries; return how many were removed. */
	prune(now = Date.now()): number {
		const all = this.readAll();
		const live = all.filter((entry) => entry.expiresAt > now);
		if (live.length !== all.length) this.write(live);
		return all.length - live.length;
	}

	private readAll(): HandledEntry[] {
		if (!existsSync(this.path)) return [];
		try {
			const data = JSON.parse(readFileSync(this.path, "utf8"));
			return Array.isArray(data) ? (data as HandledEntry[]) : [];
		} catch {
			return [];
		}
	}

	private write(entries: HandledEntry[]): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			writeFileSync(this.path, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
		} catch {
			// best-effort
		}
	}
}
