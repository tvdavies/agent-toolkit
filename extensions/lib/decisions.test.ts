import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countDecisions, decisionsPath, readRecent, recordDecision } from "./decisions";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "decisions-"));
	process.env.AGENT_TOOLKIT_STATE_DIR = dir;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.AGENT_TOOLKIT_STATE_DIR;
});

describe("recordDecision / readRecent", () => {
	it("appends and reads back records newest-last", () => {
		recordDecision({ kind: "brain-write", summary: "first" });
		recordDecision({ kind: "guardrail-block", summary: "second", source: "interactive" });
		const recent = readRecent();
		expect(recent.map((d) => d.summary)).toEqual(["first", "second"]);
		expect(recent[1]?.source).toBe("interactive");
		expect(recent[0]?.ts).toBeDefined();
	});

	it("respects the limit (returns the newest N)", () => {
		for (let i = 0; i < 20; i += 1) recordDecision({ kind: "x", summary: `n${i}` });
		const recent = readRecent(5);
		expect(recent).toHaveLength(5);
		expect(recent[4]?.summary).toBe("n19");
	});

	it("counts total decisions", () => {
		expect(countDecisions()).toBe(0);
		recordDecision({ kind: "x", summary: "a" });
		recordDecision({ kind: "x", summary: "b" });
		expect(countDecisions()).toBe(2);
	});

	it("tolerates malformed lines without throwing", () => {
		recordDecision({ kind: "x", summary: "good" });
		appendFileSync(decisionsPath(), "not-json\n");
		expect(() => readRecent()).not.toThrow();
		expect(readRecent().some((d) => d.summary === "good")).toBe(true);
	});

	it("returns empty when the log does not exist", () => {
		expect(readRecent()).toEqual([]);
		expect(countDecisions()).toBe(0);
	});
});
