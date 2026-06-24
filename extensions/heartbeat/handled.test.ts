import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandledStore } from "./handled";

const NOW = 1_000_000;
let dir: string;
let store: HandledStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "handled-"));
	store = new HandledStore(join(dir, "handled.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("HandledStore", () => {
	it("marks an item handled within its TTL", () => {
		store.add("pr-42", 1000, "looked at it", NOW);
		expect(store.isHandled("pr-42", NOW + 500)).toBe(true);
		expect(store.isHandled("pr-42", NOW + 2000)).toBe(false); // expired
		expect(store.isHandled("other", NOW + 100)).toBe(false);
	});

	it("lists only live entries", () => {
		store.add("a", 1000, undefined, NOW);
		store.add("b", 5000, undefined, NOW);
		const live = store.list(NOW + 2000).map((e) => e.key);
		expect(live).toEqual(["b"]);
	});

	it("upserts rather than duplicating a key", () => {
		store.add("k", 1000, "first", NOW);
		store.add("k", 5000, "second", NOW);
		const entries = store.list(NOW + 100);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.note).toBe("second");
	});

	it("prunes expired entries", () => {
		store.add("a", 1000, undefined, NOW);
		store.add("b", 5000, undefined, NOW);
		expect(store.prune(NOW + 2000)).toBe(1);
		expect(store.list(NOW + 2000).map((e) => e.key)).toEqual(["b"]);
	});

	it("returns nothing for an absent store", () => {
		expect(new HandledStore(join(dir, "missing.json")).list(NOW)).toEqual([]);
	});
});
