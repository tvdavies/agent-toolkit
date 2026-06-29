import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrainEngine } from "./engine";

/** A fake @jeffs-brain Provider: returns canned extraction JSON so the round-trip is
 *  deterministic + offline (no LM Studio). extract() only calls complete(). */
function fakeProvider(extractionJson: string) {
	let lastSystem = "";
	const resp = (content: string) => ({ content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 20 }, stopReason: "end_turn" as const });
	return {
		name: () => "fake",
		modelName: () => "fake-model",
		supportsStructuredDecoding: () => false,
		async complete(req: { system?: string }) {
			lastSystem = req.system ?? "";
			// Extraction prompt → return facts; anything else → empty.
			return resp(/extract/i.test(lastSystem) || /memor/i.test(lastSystem) || /fact/i.test(lastSystem) ? extractionJson : "");
		},
		async *stream() {},
		async structured() {
			return extractionJson;
		},
	};
}

const EXTRACTION = JSON.stringify({
	memories: [
		{ action: "create", filename: "", name: "Run the test suite", description: "Always run bun test for the suite, never npm.", type: "project", scope: "global", content: "Always run `bun test` for the suite; never npm.", index_entry: "Run bun test for the suite." },
		{ action: "create", filename: "", name: "Restart the daemon", description: "Restart the daemon with systemctl --user restart agent-toolkit.", type: "project", scope: "global", content: "Restart the daemon: `systemctl --user restart agent-toolkit`.", index_entry: "Restart the daemon with systemctl." },
		{ action: "create", filename: "", name: "Worker pool location", description: "The worker pool lives in daemon/worker-pool.ts, not extensions.", type: "project", scope: "global", content: "The worker pool is `daemon/worker-pool.ts`, not under extensions/.", index_entry: "Worker pool is daemon/worker-pool.ts." },
	],
});

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mem-engine-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("createBrainEngine round-trip (fake provider)", () => {
	it("extracts memories then recalls them by a natural-language query", async () => {
		const engine = await createBrainEngine({ root, actorId: "tom", scope: "agent", git: false, provider: fakeProvider(EXTRACTION) });
		const messages = [
			{ role: "user", content: "In agent-skills always run bun test, never npm. Restart the daemon with systemctl --user restart agent-toolkit." },
			{ role: "assistant", content: "Understood." },
			{ role: "user", content: "The worker pool is daemon/worker-pool.ts, not extensions." },
			{ role: "assistant", content: "Noted." },
		];
		const extracted = await engine.extract(messages, { sessionId: "t1" });
		expect(extracted.length).toBe(3);

		const restart = await engine.recall("how do I restart the daemon?");
		expect(restart.count).toBeGreaterThan(0);
		expect(restart.block.toLowerCase()).toContain("systemctl");

		const tests = await engine.recall("what command runs the test suite?");
		expect(tests.count).toBeGreaterThan(0);
		expect(tests.block.toLowerCase()).toContain("bun test");

		const pool = await engine.recall("where does the worker pool live?");
		expect(pool.block.toLowerCase()).toContain("worker-pool.ts");
	});

	it("redacts secrets in the messages before extraction reaches the store", async () => {
		// Capture what the provider actually receives.
		let seen = "";
		const provider = {
			name: () => "fake",
			modelName: () => "fake",
			supportsStructuredDecoding: () => false,
			async complete(req: { messages?: Array<{ content?: string }>; system?: string }) {
				seen += (req.messages ?? []).map((m) => m.content ?? "").join("\n") + (req.system ?? "");
				return { content: "[]", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" as const };
			},
			async *stream() {},
			async structured() {
				return "[]";
			},
		};
		const engine = await createBrainEngine({ root, actorId: "tom", git: false, provider });
		// token assembled from parts so no contiguous secret pattern is committed.
		const secretToken = ["sk-", "ant-", "a".repeat(24)].join("");
		await engine.extract([
			{ role: "user", content: `my key is API_KEY=supersecret12345 and token ${secretToken}` },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "and another line" },
			{ role: "assistant", content: "ok" },
		], { sessionId: "t2" });
		expect(seen).not.toContain("supersecret12345");
		expect(seen).not.toContain(secretToken);
		expect(seen).toContain("[REDACTED]");
	});

	it("recall returns empty (no throw) against an empty brain", async () => {
		const engine = await createBrainEngine({ root, actorId: "tom", git: false, provider: fakeProvider("[]") });
		const r = await engine.recall("anything at all");
		expect(r.count).toBe(0);
		expect(r.block).toBe("");
	});
});
