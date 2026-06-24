/**
 * Integration test for the brain extension wiring. Drives the extension through
 * a fake ExtensionAPI (no model, no real Pi runtime) against a tmpdir bundle, so
 * it exercises the real tool execute paths and the recall injection handler.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type AnyFn = (...args: unknown[]) => unknown;

function makeFakePi() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, AnyFn[]>();
	const pi = {
		on(event: string, handler: AnyFn) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, opts: any) {
			commands.set(name, opts);
		},
		appendEntry() {},
		sendUserMessage() {},
		sendMessage() {},
	};
	return { pi, tools, commands, handlers };
}

const ctx = { hasUI: false, ui: { notify() {} } } as any;
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "brain-ext-"));
	process.env.AGENT_TOOLKIT_BRAIN_ROOT = root;
	process.env.AGENT_TOOLKIT_BRAIN_RECALL = "on";
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.AGENT_TOOLKIT_BRAIN_ROOT;
});

async function loadExtension() {
	// The factory reads brain root + recall mode from env on each call, so a
	// cached module is fine — just (re)invoke default with the current env set.
	const mod = await import("./index");
	const fake = makeFakePi();
	mod.default(fake.pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
	return fake;
}

describe("brain extension wiring", () => {
	it("registers the expected tools and command", async () => {
		const { tools, commands } = await loadExtension();
		expect([...tools.keys()].sort()).toEqual([
			"brain_forget",
			"brain_query",
			"brain_remember",
		]);
		expect(commands.has("brain")).toBe(true);
	});

	it("remembers a concept and recalls it via brain_query", async () => {
		const { tools } = await loadExtension();
		const remember = tools.get("brain_remember");
		const res = await remember.execute(
			"t1",
			{
				type: "Decision",
				title: "Model routing",
				text: "Escalate models mid-conversation but never downgrade.",
				tags: ["routing"],
			},
			undefined,
			undefined,
			ctx,
		);
		expect(res.details.ok).toBe(true);

		const query = tools.get("brain_query");
		const hit = await query.execute(
			"t2",
			{ query: "downgrade routing" },
			undefined,
			undefined,
			ctx,
		);
		expect(hit.content[0].text).toContain("Model routing");
	});

	it("injects the memory addendum and a recall block on before_agent_start", async () => {
		const { tools, handlers } = await loadExtension();
		await tools
			.get("brain_remember")
			.execute(
				"t1",
				{ type: "Person", title: "Tom", text: "Prefers concise answers." },
				undefined,
				undefined,
				ctx,
			);
		const before = handlers.get("before_agent_start")?.[0];
		expect(before).toBeDefined();
		const out = (await before?.(
			{ type: "before_agent_start", prompt: "what does Tom prefer", systemPrompt: "BASE" },
			ctx,
		)) as { systemPrompt: string };
		expect(out.systemPrompt).toContain("Persistent Memory (Brain)");
		expect(out.systemPrompt).toContain("Relevant memories from your brain:");
		expect(out.systemPrompt).toContain("Tom");
	});

	it("does not inject a recall block when recall is disabled", async () => {
		process.env.AGENT_TOOLKIT_BRAIN_RECALL = "off";
		const { tools, handlers } = await loadExtension();
		await tools
			.get("brain_remember")
			.execute("t1", { type: "Note", title: "x", text: "secret-token-xyz" }, undefined, undefined, ctx);
		const before = handlers.get("before_agent_start")?.[0];
		const out = (await before?.(
			{ type: "before_agent_start", prompt: "secret-token-xyz", systemPrompt: "BASE" },
			ctx,
		)) as { systemPrompt: string };
		expect(out.systemPrompt).not.toContain("Relevant memories from your brain:");
	});
});
