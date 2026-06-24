/**
 * End-to-end test: RpcClient drives the fake-pi fixture as a real subprocess,
 * over real stdio with strict-LF framing. Proves prompt delivery, agent_end
 * tracking, and the extension-UI auto-cancel path without a model.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient } from "./rpc-client";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-pi.mjs");

let dir: string;
let logPath: string;
let client: RpcClient;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rpc-"));
	logPath = join(dir, "fake-pi.log");
});

afterEach(async () => {
	await client?.stop(1000);
	rmSync(dir, { recursive: true, force: true });
});

function startClient() {
	client = new RpcClient({
		command: process.execPath,
		args: [FIXTURE],
		env: { ...process.env, FAKE_PI_LOG: logPath },
	});
	client.start();
	return client;
}

describe("RpcClient e2e (fake-pi)", () => {
	it("delivers a prompt and observes agent_end", async () => {
		startClient();
		client.submit("hello world");
		await once(client, "agent_end");
		expect(readFileSync(logPath, "utf8")).toContain("PROMPT hello world");
		expect(client.isStreaming()).toBe(false);
	});

	it("auto-cancels an extension UI dialog so the agent does not block", async () => {
		startClient();
		client.submit("ASKUI");
		await once(client, "agent_end");
		expect(readFileSync(logPath, "utf8")).toContain("UIRESP cancelled");
	});

	it("correlates a request with its response", async () => {
		client = new RpcClient({
			command: process.execPath,
			args: [FIXTURE],
			env: { ...process.env, FAKE_PI_LOG: logPath, FAKE_PI_COST: "2.5" },
		});
		client.start();
		const resp = (await client.request({ type: "get_session_stats" })) as { data?: { cost?: number } };
		expect(resp?.data?.cost).toBe(2.5);
	});

	it("stops the child cleanly", async () => {
		startClient();
		client.submit("hello");
		await once(client, "agent_end");
		await client.stop(2000);
		expect(client.running).toBe(false);
	});
});
