import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countDecisions } from "./decisions";
import { ackNotice, notify, readNotices } from "./notify";

const budget = { maxPerWindow: 2, windowMs: 10_000, minGapMs: 1000 };
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "notify-"));
	process.env.AGENT_TOOLKIT_STATE_DIR = dir;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.AGENT_TOOLKIT_STATE_DIR;
});

describe("notify", () => {
	it("always records to the spine; pushes within budget, drops to pull when rate-limited", () => {
		expect(notify({ summary: "first" }, { now: 1000, budget }).pushed).toBe(true);
		expect(notify({ summary: "too soon" }, { now: 1500, budget }).pushed).toBe(false); // min gap
		expect(notify({ summary: "ok now" }, { now: 2200, budget }).pushed).toBe(true);

		// All three were recorded as decisions (pull); only two pushed (notify.jsonl).
		expect(countDecisions()).toBe(3);
		expect(readNotices()).toHaveLength(2);
	});

	it("supports acking a notice", () => {
		notify({ summary: "needs ack" }, { now: 1000, budget });
		const [notice] = readNotices();
		expect(notice).toBeDefined();
		expect(ackNotice(notice?.id ?? "")).toBe(true);
		expect(readNotices({ unackedOnly: true })).toHaveLength(0);
		expect(readNotices()).toHaveLength(1);
	});
});
