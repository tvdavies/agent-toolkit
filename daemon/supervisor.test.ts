import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileInbox, type Trigger } from "./inbox";
import { RpcClient } from "./rpc-client";
import { lastAssistantText, Supervisor } from "./supervisor";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-pi.mjs");

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sup-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await sleep(20);
	}
}

class FakeClient extends EventEmitter {
	started = false;
	submitted: string[] = [];
	pid = 4321;
	start() {
		this.started = true;
	}
	submit(text: string) {
		this.submitted.push(text);
	}
	async stop() {
		this.started = false;
	}
	get running() {
		return this.started;
	}
	isStreaming() {
		return false;
	}
}

describe("Supervisor (unit, fake client + injected timers)", () => {
	it("forwards drained triggers to the client and records them", () => {
		let pending: Trigger[] = [{ id: "1", text: "do-it", source: "cli" }];
		const clients: FakeClient[] = [];
		const forwarded: Trigger[] = [];
		const sup = new Supervisor({
			createClient: () => {
				const c = new FakeClient();
				clients.push(c);
				return c as unknown as RpcClient;
			},
			inbox: {
				drain() {
					const t = pending;
					pending = [];
					return t;
				},
			},
			statusPath: join(dir, "status.json"),
			pollMs: 0,
			statusMs: 0,
			now: () => 1000,
			onForward: (t) => forwarded.push(t),
		});
		sup.start();
		sup.pollInbox();
		expect(clients[0]?.submitted).toEqual(["do-it"]);
		expect(forwarded).toHaveLength(1);
		expect(existsSync(join(dir, "status.json"))).toBe(true);
	});

	it("pairs a slack-origin trigger with the next agent_end and replies", () => {
		let pending: Trigger[] = [
			{ id: "1", text: "hello", origin: { kind: "slack", channel: "C1", threadTs: "t1", user: "U" } },
		];
		const clients: FakeClient[] = [];
		const replies: { origin: any; text: string }[] = [];
		const sup = new Supervisor({
			createClient: () => {
				const c = new FakeClient();
				clients.push(c);
				return c as unknown as RpcClient;
			},
			inbox: {
				drain() {
					const t = pending;
					pending = [];
					return t;
				},
			},
			statusPath: join(dir, "status.json"),
			pollMs: 0,
			statusMs: 0,
			now: () => 1000,
			onReply: (origin, text) => replies.push({ origin, text }),
		});
		sup.start();
		sup.pollInbox();
		clients[0]?.emit("agent_end", {
			messages: [{ role: "assistant", content: [{ type: "text", text: "done!" }] }],
		});
		expect(replies).toHaveLength(1);
		expect(replies[0]?.text).toBe("done!");
		expect(replies[0]?.origin.channel).toBe("C1");
	});

	it("pauses forwarding (does not drain) when the gate is closed", () => {
		let drained = 0;
		const clients: FakeClient[] = [];
		const sup = new Supervisor({
			createClient: () => {
				const c = new FakeClient();
				clients.push(c);
				return c as unknown as RpcClient;
			},
			inbox: {
				drain() {
					drained += 1;
					return [{ id: "1", text: "x" }];
				},
			},
			statusPath: join(dir, "status.json"),
			pollMs: 0,
			statusMs: 0,
			now: () => 1000,
			gate: () => true,
		});
		sup.start();
		sup.pollInbox();
		expect(drained).toBe(0);
		expect(clients[0]?.submitted).toEqual([]);
	});

	it("respawns with backoff after the client exits", () => {
		const timers: { fn: () => void; ms: number }[] = [];
		let created = 0;
		const clients: FakeClient[] = [];
		const sup = new Supervisor({
			createClient: () => {
				created += 1;
				const c = new FakeClient();
				clients.push(c);
				return c as unknown as RpcClient;
			},
			inbox: { drain: () => [] },
			statusPath: join(dir, "status.json"),
			pollMs: 0,
			statusMs: 0,
			now: () => 1000,
			setTimer: (fn, ms) => {
				timers.push({ fn, ms });
				return 0 as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimer: () => {},
		});
		sup.start();
		expect(created).toBe(1);

		clients[0]?.emit("exit", 1, null);
		expect(timers).toHaveLength(1);
		expect(timers[0]?.ms).toBe(500); // first backoff

		timers[0]?.fn(); // run the scheduled respawn
		expect(created).toBe(2);

		const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
		expect(status.restarts).toBe(1);
	});
});

describe("lastAssistantText", () => {
	it("extracts the last assistant message's text", () => {
		expect(
			lastAssistantText([
				{ role: "user", content: "hi" },
				{ role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "answer" }] },
			]),
		).toBe("answer");
		expect(lastAssistantText([{ role: "assistant", content: "plain" }])).toBe("plain");
		expect(lastAssistantText([])).toBeUndefined();
	});
});

describe("Supervisor e2e (real client + fake-pi + FileInbox)", () => {
	it("routes an appended trigger through to the agent and writes status", async () => {
		const logPath = join(dir, "fake-pi.log");
		const inbox = new FileInbox(join(dir, "inbox.jsonl"));
		const statusPath = join(dir, "status.json");
		let client: RpcClient | undefined;
		const sup = new Supervisor({
			createClient: () => {
				client = new RpcClient({
					command: process.execPath,
					args: [FIXTURE],
					env: { ...process.env, FAKE_PI_LOG: logPath },
				});
				return client;
			},
			inbox,
			statusPath,
			pollMs: 0,
			statusMs: 0,
		});
		sup.start();
		inbox.append({ text: "through-the-supervisor", source: "cli" });
		sup.pollInbox();

		await waitFor(
			() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("through-the-supervisor"),
		);
		expect(readFileSync(logPath, "utf8")).toContain("PROMPT through-the-supervisor");
		const status = JSON.parse(readFileSync(statusPath, "utf8"));
		expect(status.healthy).toBe(true);
		expect(status.lastTriggerText).toBe("through-the-supervisor");

		await sup.stop();
	});
});
