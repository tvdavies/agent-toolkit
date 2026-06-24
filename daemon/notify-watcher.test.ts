import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notify } from "../extensions/lib/notify";
import { NotifyWatcher } from "./notify-watcher";

const budget = { maxPerWindow: 100, windowMs: 10_000, minGapMs: 0 };
let dir: string;
let posted: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "nw-"));
	process.env.AGENT_TOOLKIT_STATE_DIR = dir;
	posted = [];
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.AGENT_TOOLKIT_STATE_DIR;
});

describe("NotifyWatcher", () => {
	it("delivers newly-appended notices once", () => {
		const watcher = new NotifyWatcher({ post: (t) => { posted.push(t); }});
		notify({ summary: "one" }, { now: 1000, budget });
		notify({ summary: "two" }, { now: 1100, budget });
		watcher.pollOnce();
		expect(posted).toHaveLength(2);
		expect(posted[0]).toContain("one");
		// Already-delivered notices are not re-sent.
		watcher.pollOnce();
		expect(posted).toHaveLength(2);
		notify({ summary: "three" }, { now: 1200, budget });
		watcher.pollOnce();
		expect(posted).toEqual([expect.stringContaining("one"), expect.stringContaining("two"), expect.stringContaining("three")]);
	});

	it("start() skips the existing backlog", () => {
		notify({ summary: "old" }, { now: 1000, budget });
		const watcher = new NotifyWatcher({ post: (t) => { posted.push(t); }});
		watcher.start();
		try {
			notify({ summary: "new" }, { now: 1100, budget });
			watcher.pollOnce();
			expect(posted).toEqual([expect.stringContaining("new")]);
		} finally {
			watcher.stop();
		}
	});
});
