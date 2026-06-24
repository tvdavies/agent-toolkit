/**
 * Integration test for the heartbeat extension via a fake ExtensionAPI: marker
 * detection + checklist/silence-rule injection, the heartbeat_note tool
 * (escalation + handled suppression), and the silent "nothing to report" log.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecent } from "../lib/decisions";
import { buildHeartbeatPrompt } from "./protocol";

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
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: (n: string, o: any) => commands.set(n, o),
		sendUserMessage() {},
	};
	return { pi, tools, commands, handlers };
}

const ctx = { hasUI: false, isIdle: () => true, ui: { notify() {} } } as any;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hb-"));
	process.env.AGENT_TOOLKIT_STATE_DIR = join(dir, "state");
	process.env.AGENT_TOOLKIT_HEARTBEAT = join(dir, "HEARTBEAT.md");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.AGENT_TOOLKIT_STATE_DIR;
	delete process.env.AGENT_TOOLKIT_HEARTBEAT;
});

async function load() {
	const mod = await import("./index");
	const fake = makeFakePi();
	mod.default(fake.pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
	const before = fake.handlers.get("before_agent_start")?.[0] as AnyFn;
	const agentEnd = fake.handlers.get("agent_end")?.[0] as AnyFn;
	return { ...fake, before, agentEnd };
}

describe("heartbeat extension", () => {
	it("injects the checklist + silence rule only for heartbeat prompts", async () => {
		const { before } = await load();
		const hb = (await before(
			{ type: "before_agent_start", prompt: buildHeartbeatPrompt(), systemPrompt: "BASE" },
			ctx,
		)) as { systemPrompt: string };
		expect(hb.systemPrompt).toContain("SILENCE RULE");
		expect(hb.systemPrompt).toContain("Checklist (HEARTBEAT.md)");

		const normal = await before(
			{ type: "before_agent_start", prompt: "just a normal request", systemPrompt: "BASE" },
			ctx,
		);
		expect(normal).toBeUndefined();
	});

	it("escalates on attention, suppresses handled items, and logs", async () => {
		const { before, tools } = await load();
		await before(
			{ type: "before_agent_start", prompt: buildHeartbeatPrompt(), systemPrompt: "BASE" },
			ctx,
		);
		const res = await tools.get("heartbeat_note").execute(
			"t1",
			{ summary: "PR 4811 is failing CI", attention: true, handled: ["pr-4811"] },
			undefined,
			undefined,
			ctx,
		);
		expect(res.details.ok).toBe(true);
		expect(readRecent().some((d) => d.kind === "escalate" && d.summary.includes("4811"))).toBe(true);

		// A later heartbeat lists the handled item so it is not re-flagged.
		const next = (await before(
			{ type: "before_agent_start", prompt: buildHeartbeatPrompt(), systemPrompt: "BASE" },
			ctx,
		)) as { systemPrompt: string };
		expect(next.systemPrompt).toContain("Already handled");
		expect(next.systemPrompt).toContain("pr-4811");
	});

	it("logs 'nothing to report' silently when a heartbeat records no note", async () => {
		const { before, agentEnd } = await load();
		await before(
			{ type: "before_agent_start", prompt: buildHeartbeatPrompt(), systemPrompt: "BASE" },
			ctx,
		);
		await agentEnd({ type: "agent_end", messages: [] }, ctx);
		const logPath = join(dir, "state", "heartbeat-log.md");
		expect(existsSync(logPath)).toBe(true);
		expect(readFileSync(logPath, "utf8")).toContain("nothing to report");
		// Silence: no escalation decision was recorded for an all-clear run.
		expect(readRecent().some((d) => d.kind === "escalate")).toBe(false);
	});

	it("registers the heartbeat_note tool and /heartbeat command", async () => {
		const { tools, commands } = await load();
		expect(tools.has("heartbeat_note")).toBe(true);
		expect(commands.has("heartbeat")).toBe(true);
	});
});
