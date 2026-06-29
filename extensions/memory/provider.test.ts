import { describe, expect, it } from "bun:test";
import { conformExtraction, normaliseBaseURL, slugify, stripJsonObjectMode } from "./provider";

describe("normaliseBaseURL", () => {
	it("trims a trailing /v1 (the provider appends /v1/chat/completions)", () => {
		expect(normaliseBaseURL("http://localhost:1234/v1")).toBe("http://localhost:1234");
		expect(normaliseBaseURL("http://localhost:1234/v1/")).toBe("http://localhost:1234");
		expect(normaliseBaseURL("http://localhost:1234")).toBe("http://localhost:1234");
		expect(normaliseBaseURL("https://host/api/v1")).toBe("https://host/api");
	});
});

describe("stripJsonObjectMode", () => {
	it("removes jsonMode and a json_object responseFormat (LM Studio rejects them)", () => {
		expect(stripJsonObjectMode({ jsonMode: true, maxTokens: 100 })).toEqual({ maxTokens: 100 });
		expect(stripJsonObjectMode({ responseFormat: { type: "json_object" }, temperature: 0 })).toEqual({ temperature: 0 });
	});
	it("leaves text/json_schema modes and other fields intact", () => {
		expect(stripJsonObjectMode({ responseFormat: { type: "json_schema" }, x: 1 })).toEqual({ responseFormat: { type: "json_schema" }, x: 1 });
		expect(stripJsonObjectMode({ maxTokens: 50, temperature: 0 })).toEqual({ maxTokens: 50, temperature: 0 });
	});
});

describe("slugify", () => {
	it("makes a filesystem-safe slug from a name", () => {
		expect(slugify("Restart the Daemon!")).toBe("restart-the-daemon");
		expect(slugify("worker_pool / location")).toBe("worker-pool-location");
		expect(slugify("***")).toBe("memory");
	});
});

describe("conformExtraction", () => {
	it("fills missing/empty filenames, deriving from name", () => {
		const out = JSON.parse(conformExtraction(JSON.stringify([{ name: "Restart the daemon", filename: "", content: "x" }, { name: "Run tests", content: "y" }])));
		expect(out[0].filename).toBe("restart-the-daemon.md");
		expect(out[1].filename).toBe("run-tests.md");
	});
	it("coerces array/empty content to a non-empty string (nuextract emits content arrays)", () => {
		// content array is all-empty → falls back to description.
		const out = JSON.parse(conformExtraction(JSON.stringify([{ name: "Tests", filename: "tests.md", description: "Run bun test.", content: [{ why: "", how: "" }] }])));
		expect(out[0].content).toBe("Run bun test.");
		// content array with text → flattened.
		const out2 = JSON.parse(conformExtraction(JSON.stringify([{ name: "X", filename: "x.md", content: [{ why: "because" }, "and also"] }])));
		expect(out2[0].content).toContain("because");
		expect(out2[0].content).toContain("and also");
	});
	it("handles the { memories: [...] } wrapper", () => {
		const out = JSON.parse(conformExtraction(JSON.stringify({ memories: [{ name: "Worker pool location", filename: "", content: "daemon/worker-pool.ts" }] })));
		expect(out.memories[0].filename).toBe("worker-pool-location.md");
	});
	it("does NOT overwrite a model-provided filename or string content", () => {
		const out = JSON.parse(conformExtraction(JSON.stringify([{ name: "X", filename: "custom.md", content: "keep me" }])));
		expect(out[0].filename).toBe("custom.md");
		expect(out[0].content).toBe("keep me");
	});
	it("leaves non-extraction content (reflection JSON, prose) unchanged", () => {
		const reflection = JSON.stringify({ outcome: "success", summary: "did the thing", heuristics: [] });
		expect(conformExtraction(reflection)).toBe(reflection);
		expect(conformExtraction("just some prose, no json")).toBe("just some prose, no json");
	});
});
