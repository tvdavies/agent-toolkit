import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorker, type WorkerSpec, workerArgs, workerEnv } from "./worker";

let dir: string;

/** Write an executable stub that stands in for the pi binary. */
function stub(body: string): string {
	const path = join(dir, "pi-stub.sh");
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

const spec = (over: Partial<WorkerSpec>): WorkerSpec => ({
	id: "run-1",
	prompt: "do the task",
	sessionDir: join(dir, "sessions"),
	cwd: dir,
	piBin: join(dir, "pi-stub.sh"),
	...over,
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "worker-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("workerArgs", () => {
	it("runs non-interactive, extension-free, in the given session dir", () => {
		const args = workerArgs(spec({ model: "openai/gpt-5.5" }));
		expect(args).toContain("-p");
		expect(args).toContain("--no-extensions");
		expect(args.slice(args.indexOf("--session-dir"), args.indexOf("--session-dir") + 2)).toEqual([
			"--session-dir",
			join(dir, "sessions"),
		]);
		expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "openai/gpt-5.5"]);
		expect(args[args.length - 1]).toBe("do the task"); // prompt is last
	});
});

describe("workerEnv", () => {
	it("strips daemon secrets but keeps PATH/HOME/provider keys/config", () => {
		const env = workerEnv({
			PATH: "/bin",
			HOME: "/home/x",
			ANTHROPIC_API_KEY: "k",
			AGENT_TOOLKIT_STATE_DIR: "/s",
			SLACK_BOT_TOKEN: "s",
			WEBHOOK_SECRET: "w",
			SLACK_SIGNING_SECRET: "ss",
			AGENT_TOOLKIT_DASHBOARD_TOKEN: "d",
		});
		expect(env.PATH).toBe("/bin");
		expect(env.HOME).toBe("/home/x");
		expect(env.ANTHROPIC_API_KEY).toBe("k");
		expect(env.AGENT_TOOLKIT_STATE_DIR).toBe("/s");
		expect(env.SLACK_BOT_TOKEN).toBeUndefined();
		expect(env.WEBHOOK_SECRET).toBeUndefined();
		expect(env.SLACK_SIGNING_SECRET).toBeUndefined();
		expect(env.AGENT_TOOLKIT_DASHBOARD_TOKEN).toBeUndefined();
	});
});

describe("runWorker", () => {
	it("captures output and reports success on exit 0", async () => {
		stub('echo "WORKER OUTPUT"');
		const result = await runWorker(spec({})).done;
		expect(result.ok).toBe(true);
		expect(result.code).toBe(0);
		expect(result.outputText).toBe("WORKER OUTPUT");
		expect(result.timedOut).toBe(false);
	});

	it("reports failure and captures stderr on a non-zero exit", async () => {
		stub('echo "boom" 1>&2\nexit 3');
		const result = await runWorker(spec({})).done;
		expect(result.ok).toBe(false);
		expect(result.code).toBe(3);
		expect(result.errorText).toContain("boom");
	});

	it("kills and flags a run that exceeds the timeout", async () => {
		stub("sleep 5");
		const result = await runWorker(spec({ timeoutMs: 200 })).done;
		expect(result.timedOut).toBe(true);
		expect(result.ok).toBe(false);
	});

	it("reports failure when the binary cannot be spawned", async () => {
		const result = await runWorker(spec({ piBin: join(dir, "does-not-exist") })).done;
		expect(result.ok).toBe(false);
		expect(result.code).toBeNull();
	});
});
