import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clampParkSeconds,
	clearAnswer,
	clearParkRequest,
	DEFAULT_PARK_SECONDS,
	readAllParked,
	readAnswers,
	readParkRequest,
	removeParked,
	writeAnswer,
	writeParked,
	writeParkRequest,
} from "./park";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "park-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("clampParkSeconds", () => {
	it("clamps to [30, 3600] and defaults sensibly", () => {
		expect(clampParkSeconds(5)).toBe(30);
		expect(clampParkSeconds(99999)).toBe(3600);
		expect(clampParkSeconds(180)).toBe(180);
		expect(clampParkSeconds(0)).toBe(DEFAULT_PARK_SECONDS);
		expect(clampParkSeconds(Number.NaN)).toBe(DEFAULT_PARK_SECONDS);
	});
});

describe("park request round-trip", () => {
	it("writes, reads, and clears a request", () => {
		writeParkRequest(dir, { runId: "w-1", dueAt: 1000, prompt: "re-check", reason: "ci" });
		const req = readParkRequest(dir, "w-1");
		expect(req).toMatchObject({ runId: "w-1", dueAt: 1000, prompt: "re-check", reason: "ci" });
		clearParkRequest(dir, "w-1");
		expect(readParkRequest(dir, "w-1")).toBeUndefined();
	});

	it("returns undefined for an absent request", () => {
		expect(readParkRequest(dir, "nope")).toBeUndefined();
	});
});

describe("parked entries (durable)", () => {
	it("persists, lists, and removes parked entries", () => {
		writeParked(dir, { runId: "w-1", taskId: "TASK-1", worktreePath: "/wt/1", dueAt: 10, prompt: "go", resumes: 1 });
		writeParked(dir, { runId: "w-2", dueAt: 20, prompt: "go2", resumes: 3 });
		const all = readAllParked(dir).sort((a, b) => a.runId.localeCompare(b.runId));
		expect(all.map((e) => e.runId)).toEqual(["w-1", "w-2"]);
		expect(all[0]).toMatchObject({ taskId: "TASK-1", worktreePath: "/wt/1", resumes: 1 });
		removeParked(dir, "w-1");
		expect(readAllParked(dir).map((e) => e.runId)).toEqual(["w-2"]);
	});

	it("returns empty when nothing is parked", () => {
		expect(readAllParked(dir)).toEqual([]);
		expect(existsSync(join(dir, "worker-parked"))).toBe(false);
	});
});

describe("human answers", () => {
	it("writes, reads, and clears an answer keyed by a ref", () => {
		writeAnswer(dir, "TASK-12", "keep the v1 endpoint", "2026-06-25T00:00:00Z");
		const all = readAnswers(dir);
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ ref: "TASK-12", answer: "keep the v1 endpoint" });
		clearAnswer(dir, "TASK-12");
		expect(readAnswers(dir)).toEqual([]);
	});

	it("sanitises the ref for the filename but preserves it in the record", () => {
		writeAnswer(dir, "owner/name#5", "go", "t");
		expect(readAnswers(dir)[0]?.ref).toBe("owner/name#5");
	});
});
