import { describe, expect, it } from "bun:test";
import { createBm25SearchIndex, queryTerms, scoreNote } from "./search-adapter";

describe("queryTerms", () => {
	it("lowercases, drops stopwords + short tokens, dedupes", () => {
		expect(queryTerms("How do I restart the daemon?")).toEqual(["restart", "daemon"]);
		expect(queryTerms("worker worker POOL")).toEqual(["worker", "pool"]);
		expect(queryTerms("a an the to of")).toEqual([]);
	});
});

describe("scoreNote", () => {
	const terms = ["restart", "daemon"];
	it("rewards term coverage over single-term spam", () => {
		const covers = scoreNote("restart the daemon cleanly", "x.md", terms);
		const spam = scoreNote("daemon daemon daemon daemon daemon", "x.md", terms);
		expect(covers).toBeGreaterThan(spam); // matching both terms beats spamming one
	});
	it("returns 0 when no term matches", () => {
		expect(scoreNote("totally unrelated content", "x.md", terms)).toBe(0);
	});
	it("folds plurals/singulars so 'tests' matches 'test'", () => {
		expect(scoreNote("always run bun test for the suite", "x.md", ["tests"])).toBeGreaterThan(0);
		expect(scoreNote("the daemons are restarting", "x.md", ["daemon"])).toBeGreaterThan(0);
	});
	it("gives a filename-match bonus", () => {
		const inName = scoreNote("some text", "restart-daemon.md", terms);
		expect(inName).toBeGreaterThan(0);
	});
});

// Minimal fake store: just the list+read the adapter uses.
function fakeStore(files: Record<string, string>) {
	return {
		async list(prefix: string) {
			return Object.keys(files)
				.filter((p) => p.startsWith(prefix))
				.map((p) => ({ path: p, isDir: false }));
		},
		async read(path: string) {
			if (!(path in files)) throw new Error("not found");
			return Buffer.from(files[path] ?? "");
		},
	};
}

describe("createBm25SearchIndex", () => {
	it("returns top-k notes scoped by prefix, ranked by relevance", async () => {
		const store = fakeStore({
			"memory/global/restart.md": "Restart the daemon with systemctl --user restart agent-toolkit.",
			"memory/global/tests.md": "Always run bun test for the suite, never npm.",
			"memory/global/MEMORY.md": "index — should be skipped",
			"memory/projects/tom/other.md": "unrelated project note about restart in another scope",
		});
		const index = createBm25SearchIndex(store as never);
		const hits = await index.search("how do I restart the daemon?", undefined, { k: 5, scope: "global", actorId: "tom" });
		expect(hits.length).toBe(1); // only the global restart note (MEMORY.md skipped, other scope excluded)
		expect(hits[0]?.path).toBe("memory/global/restart.md");
		expect(hits[0]?.score).toBeGreaterThan(0);
	});

	it("returns [] for an empty scope or a stopword-only query", async () => {
		const index = createBm25SearchIndex(fakeStore({}) as never);
		expect(await index.search("restart", undefined, { k: 5, scope: "agent", actorId: "tom" })).toEqual([]);
		const store = createBm25SearchIndex(fakeStore({ "memory/global/x.md": "content" }) as never);
		expect(await store.search("the a to of", undefined, { k: 5, scope: "global", actorId: "tom" })).toEqual([]);
	});
});
