/**
 * Integration test for the guardrails extension: drives the tool_call hook and
 * /guard command through a fake ExtensionAPI and asserts block/allow decisions
 * and decision-spine records, with no model or real Pi runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecent } from "../lib/decisions";

type AnyFn = (...args: unknown[]) => unknown;

function makeFakePi() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, AnyFn[]>();
	const pi = {
		on(event: string, handler: AnyFn) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool() {},
		registerCommand(name: string, opts: any) {
			commands.set(name, opts);
		},
	};
	return { pi, commands, handlers };
}

const headless = { hasUI: false, ui: { notify() {}, async confirm() { return false; } } } as any;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "guard-ext-"));
	process.env.AGENT_TOOLKIT_STATE_DIR = dir;
	process.env.AGENT_TOOLKIT_AUTONOMY = "high";
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.AGENT_TOOLKIT_STATE_DIR;
	delete process.env.AGENT_TOOLKIT_AUTONOMY;
});

async function load() {
	const mod = await import("./index");
	const fake = makeFakePi();
	mod.default(fake.pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
	const toolCall = fake.handlers.get("tool_call")?.[0] as AnyFn;
	return { ...fake, toolCall };
}

function bash(command: string) {
	return { type: "tool_call", toolName: "bash", toolCallId: "t", input: { command } };
}

describe("guardrails tool_call hook", () => {
	it("blocks a banned operation even headless under high autonomy", async () => {
		const { toolCall } = await load();
		const result = (await toolCall(bash("rm -rf /"), headless)) as { block?: boolean; reason?: string };
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("rm-rf-root");
		expect(readRecent().some((d) => d.kind === "guardrail-block")).toBe(true);
	});

	it("allows a confirm-tier op under high autonomy and logs notify-after", async () => {
		const { toolCall } = await load();
		const result = await toolCall(bash("npm publish"), headless);
		expect(result).toBeUndefined();
		expect(readRecent().some((d) => d.kind === "guardrail-allow")).toBe(true);
	});

	it("does not interfere with or log benign commands", async () => {
		const { toolCall } = await load();
		expect(await toolCall(bash("ls -la"), headless)).toBeUndefined();
		expect(readRecent()).toHaveLength(0);
	});

	it("gates the notify tier when autonomy is lowered to conservative (headless)", async () => {
		const { toolCall, commands } = await load();
		await commands.get("guard").handler("level conservative", headless);
		const result = (await toolCall(bash("git push origin feature/x"), headless)) as {
			block?: boolean;
		};
		expect(result?.block).toBe(true);
	});
});
