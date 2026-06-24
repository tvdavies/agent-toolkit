import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOkf } from "./okf";
import { BrainStore, tokenise } from "./store";

const FIXED = () => new Date("2026-06-24T12:00:00Z");

let root: string;
let store: BrainStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "brain-test-"));
	store = new BrainStore(root, { actor: "tester", now: FIXED });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("init", () => {
	it("scaffolds the OKF bundle and a git repo", () => {
		store.init();
		expect(store.isInitialised()).toBe(true);
		expect(existsSync(join(root, "schema-version.yaml"))).toBe(true);
		expect(existsSync(join(root, "README.md"))).toBe(true);
		expect(existsSync(join(root, "index.md"))).toBe(true);
		expect(existsSync(join(root, "log.md"))).toBe(true);
		expect(existsSync(join(root, "people", "index.md"))).toBe(true);
		expect(existsSync(join(root, ".git"))).toBe(true);
	});
});

describe("writeConcept", () => {
	beforeEach(() => store.init());

	it("mints a parseable OKF doc at a type-inferred path", () => {
		const { id, path, created } = store.writeConcept({
			type: "Person",
			title: "Tom Davies",
			description: "The user.",
			tags: ["user"],
			body: "# Notes\n\nPrefers concise answers.",
		});
		expect(created).toBe(true);
		expect(path).toBe("people/tom-davies.md");
		expect(id).toBe("people/tom-davies");
		const doc = parseOkf(readFileSync(join(root, path), "utf8"));
		expect(doc.frontmatter.type).toBe("Person");
		expect(doc.frontmatter.timestamp).toBe("2026-06-24T12:00:00.000Z");
		expect(doc.body).toContain("Prefers concise answers.");
	});

	it("disambiguates slug collisions deterministically", () => {
		const a = store.writeConcept({ type: "Note", title: "Same Name" });
		const b = store.writeConcept({ type: "Note", title: "Same Name" });
		expect(a.path).toBe("notes/same-name.md");
		expect(b.path).toBe("notes/same-name-2.md");
	});

	it("overwrites in place when given an explicit id", () => {
		store.writeConcept({ type: "Note", id: "notes/pinned", body: "v1" });
		const second = store.writeConcept({ type: "Note", id: "notes/pinned", body: "v2" });
		expect(second.created).toBe(false);
		expect(store.readConcept("notes/pinned")?.body).toContain("v2");
	});
});

describe("readConcept / forget", () => {
	beforeEach(() => store.init());

	it("reads a written concept and reports missing ones", () => {
		store.writeConcept({ type: "Note", id: "notes/x", body: "hi" });
		expect(store.readConcept("notes/x")?.body).toContain("hi");
		expect(store.readConcept("notes/missing")).toBeUndefined();
	});

	it("forgets an existing concept and logs it; returns false for missing", () => {
		store.writeConcept({ type: "Note", id: "notes/x", body: "hi" });
		expect(store.forget("notes/x")).toBe(true);
		expect(existsSync(join(root, "notes/x.md"))).toBe(false);
		expect(readFileSync(join(root, "log.md"), "utf8")).toContain("forgot notes/x");
		expect(store.forget("notes/x")).toBe(false);
	});
});

describe("appendLog", () => {
	beforeEach(() => store.init());

	it("appends a dated entry", () => {
		store.appendLog("did a thing");
		const log = readFileSync(join(root, "log.md"), "utf8");
		expect(log).toContain("2026-06-24T12:00:00.000Z — did a thing");
	});
});

describe("listConceptFiles", () => {
	beforeEach(() => store.init());

	it("returns concept files and excludes reserved index/log files", () => {
		store.writeConcept({ type: "Note", id: "notes/a" });
		store.writeConcept({ type: "Person", id: "people/b" });
		const files = store.listConceptFiles();
		expect(files).toContain("notes/a.md");
		expect(files).toContain("people/b.md");
		expect(files).not.toContain("index.md");
		expect(files).not.toContain("log.md");
		expect(files.some((f) => f.endsWith("/index.md"))).toBe(false);
	});
});

describe("search", () => {
	beforeEach(() => store.init());

	it("finds a concept by a body term via ripgrep", () => {
		store.writeConcept({
			type: "Decision",
			id: "decisions/routing",
			title: "Model routing",
			body: "Escalate models mid-conversation but never downgrade.",
		});
		store.writeConcept({ type: "Note", id: "notes/unrelated", body: "weather is nice" });
		const hits = store.search("downgrade routing");
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.conceptId).toBe("decisions/routing");
	});

	it("returns nothing for an all-stopword query", () => {
		expect(store.search("the a of")).toEqual([]);
	});
});

describe("commit", () => {
	beforeEach(() => store.init());

	it("commits pending changes and is a no-op when clean", async () => {
		store.writeConcept({ type: "Note", id: "notes/c", body: "x" });
		expect((await store.commit("brain: add note")).committed).toBe(true);
		expect((await store.commit("brain: noop")).committed).toBe(false);
	});
});

describe("tokenise", () => {
	it("drops stopwords, short tokens, and duplicates; caps length", () => {
		expect(tokenise("What is the Routing routing policy?")).toEqual(["routing", "policy"]);
		expect(tokenise("a")).toEqual([]);
	});
});
