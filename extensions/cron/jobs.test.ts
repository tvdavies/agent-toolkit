import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronJobStore } from "./jobs";

let dir: string;
let store: CronJobStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cronjobs-"));
	store = new CronJobStore(join(dir, "cron-jobs.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("CronJobStore", () => {
	it("starts empty and seeds the default heartbeat job", () => {
		expect(store.list()).toEqual([]);
		expect(store.seedDefaults()).toEqual(["heartbeat"]);
		expect(store.get("heartbeat")?.schedule).toBe("*/30 * * * *");
		// Seeding again is a no-op.
		expect(store.seedDefaults()).toEqual([]);
	});

	it("adds (upsert by id), gets, and removes jobs", () => {
		store.add({ id: "digest", schedule: "0 18 * * *", text: "[digest] go" });
		expect(store.get("digest")?.text).toBe("[digest] go");
		store.add({ id: "digest", schedule: "0 9 * * *", text: "[digest] morning" });
		expect(store.list()).toHaveLength(1);
		expect(store.get("digest")?.schedule).toBe("0 9 * * *");
		expect(store.remove("digest")).toBe(true);
		expect(store.remove("digest")).toBe(false);
		expect(store.list()).toEqual([]);
	});

	it("persists across instances", () => {
		store.add({ id: "x", schedule: "* * * * *", text: "[x]" });
		const reopened = new CronJobStore(join(dir, "cron-jobs.json"));
		expect(reopened.get("x")?.text).toBe("[x]");
	});
});
