/**
 * Smoke test for the observe extension: loads the module under the runtime,
 * registers /status, and renders a pane from empty state — proving the wiring
 * and the read-only gatherers tolerate a fresh system.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "observe-"));
	process.env.AGENT_TOOLKIT_STATE_DIR = join(dir, "state");
	process.env.AGENT_TOOLKIT_BRAIN_ROOT = join(dir, "brain");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.AGENT_TOOLKIT_STATE_DIR;
	delete process.env.AGENT_TOOLKIT_BRAIN_ROOT;
});

describe("observe extension", () => {
	it("registers /status and renders a pane from empty state", async () => {
		const mod = await import("./index");
		const commands = new Map<string, any>();
		const pi = {
			on() {},
			registerTool() {},
			registerCommand: (name: string, opts: any) => commands.set(name, opts),
		};
		mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

		expect(commands.has("status")).toBe(true);

		let pane = "";
		const ctx = {
			cwd: dir,
			sessionManager: { getEntries: () => [] },
			ui: { notify: (msg: string) => (pane = msg) },
		} as any;
		await commands.get("status").handler("", ctx);

		expect(pane).toContain("Agent Toolkit — status");
		expect(pane).toContain("Daemon:    not running");
		expect(pane).toContain("Brain:     not initialised");
	});
});
