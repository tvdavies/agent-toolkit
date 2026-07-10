import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createAgentWorktree, finalizeAgentWorktree, persistRun, preparePersistedRunWorkflow, prepareWorkflow, type RunState } from "./index.ts";
import { isInside, sandboxCommand, workflowChildCommandBlockReason } from "./child-guard.ts";
import { runWorkflowSandbox, type SandboxHost } from "./sandbox.ts";
import { AbortableScheduler } from "./scheduler.ts";
import { extractMeta, validateScript } from "./script-format.ts";
import { atomicWriteFile } from "./store.ts";
import { confineAgentConfig, renderSessionTail } from "./runner.ts";
import { cleanupStructuredOutputRuntime, createStructuredOutputRuntime, readStructuredOutput } from "pi-subagents/src/runs/shared/structured-output.ts";

const budget = { total: null, spent: 0, remaining: null };
const host: SandboxHost = {
	async agent(payload) { return { value: `host:${String(payload.prompt)}`, budget }; },
	async phase() { return {}; },
	async log() { return {}; },
	async workflow() { throw new Error("not declared"); },
};

function source(body: string): string {
	return `export const meta = { name: "sandbox-test", description: "test" };\n${body}\n`;
}

describe("workflow sandbox", () => {
	test("executes orchestration through authenticated host capabilities", async () => {
		const controller = new AbortController();
		const result = await runWorkflowSandbox({
			source: source('phase("scan"); const value = await agent("hello"); return value;'),
			fileName: "test.js",
			args: undefined,
			budget,
			host,
			signal: controller.signal,
			timeoutMs: 5_000,
		});
		expect(result).toBe("host:hello");
	});

	test("does not complete while fire-and-forget host requests are still running", async () => {
		let finished = false;
		const delayedHost: SandboxHost = {
			...host,
			async agent() {
				await new Promise((resolve) => setTimeout(resolve, 100));
				finished = true;
				return { value: "late", budget };
			},
		};
		const started = Date.now();
		const result = await runWorkflowSandbox({
			source: source('void agent("late"); return "done";'),
			fileName: "outstanding.js",
			args: undefined,
			budget,
			host: delayedHost,
			signal: new AbortController().signal,
			timeoutMs: 5_000,
		});
		expect(result).toBe("done");
		expect(finished).toBe(true);
		expect(Date.now() - started).toBeGreaterThanOrEqual(90);
	});

	test("sandbox failure drains already-admitted host requests before rejecting", async () => {
		let finished = false;
		const delayedHost: SandboxHost = {
			...host,
			async agent() {
				await new Promise((resolve) => setTimeout(resolve, 100));
				finished = true;
				return { value: "late", budget };
			},
		};
		const started = Date.now();
		const attempt = runWorkflowSandbox({
			source: source('void agent("late"); await Promise.resolve(); throw new Error("script boom");'),
			fileName: "error-with-pending.js",
			args: undefined,
			budget,
			host: delayedHost,
			signal: new AbortController().signal,
			timeoutMs: 5_000,
		});
		await expect(attempt).rejects.toThrow("script boom");
		expect(finished).toBe(true);
		expect(Date.now() - started).toBeGreaterThanOrEqual(90);
	});

	test("parent rejects forged completion while a host request is pending", async () => {
		const delayedHost: SandboxHost = {
			...host,
			async agent() {
				await new Promise((resolve) => setTimeout(resolve, 100));
				return { value: "late", budget };
			},
		};
		const attempt = runWorkflowSandbox({
			source: source(`
const proc = agent.constructor.constructor("return process")();
const originalWrite = proc.stdout.write.bind(proc.stdout);
let stolenToken = "";
proc.stdout.write = (chunk, ...rest) => {
  const match = String(chunk).match(/^\\u001ePI_WORKFLOW:([^:]+):/);
  if (match) stolenToken = match[1];
  return originalWrite(chunk, ...rest);
};
void agent("late");
await Promise.resolve();
originalWrite("\\u001ePI_WORKFLOW:" + stolenToken + ":{\\"kind\\":\\"complete\\",\\"value\\":\\"forged\\"}\\n");
return "done";
`),
			fileName: "forged-completion.js",
			args: undefined,
			budget,
			host: delayedHost,
			signal: new AbortController().signal,
			timeoutMs: 5_000,
		});
		await expect(attempt).rejects.toThrow("outstanding capability requests");
	});

	test("constructor escape reaches only the disposable empty environment", async () => {
		const previous = process.env.PI_WORKFLOW_TEST_SECRET;
		process.env.PI_WORKFLOW_TEST_SECRET = "host-secret";
		try {
			const result = await runWorkflowSandbox({
				source: source('return agent.constructor.constructor("return JSON.stringify({ secret: process.env.PI_WORKFLOW_TEST_SECRET, execPath: process.execPath })")();'),
				fileName: "escape.js",
				args: undefined,
				budget,
				host,
				signal: new AbortController().signal,
				timeoutMs: 5_000,
			});
			expect(JSON.parse(String(result))).toEqual({ execPath: "/node" });
		} finally {
			if (previous === undefined) delete process.env.PI_WORKFLOW_TEST_SECRET;
			else process.env.PI_WORKFLOW_TEST_SECRET = previous;
		}
	});

	test("escaped filesystem access cannot read host files", async () => {
		const result = await runWorkflowSandbox({
			source: source(`
const hostFs = agent.constructor.constructor("return process.getBuiltinModule('node:fs')")();
try { hostFs.readFileSync('/etc/passwd', 'utf8'); return 'leaked'; }
catch { return 'denied'; }
`),
			fileName: "fs-escape.js",
			args: undefined,
			budget,
			host,
			signal: new AbortController().signal,
			timeoutMs: 5_000,
		});
		expect(result).toBe("denied");
	});

	test("busy loops are killed without blocking the parent event loop", async () => {
		const controller = new AbortController();
		let heartbeat = 0;
		const interval = setInterval(() => heartbeat++, 20);
		const timer = setTimeout(() => controller.abort(new Error("test abort")), 150);
		try {
			await expect(runWorkflowSandbox({
				source: source("while (true) {}"),
				fileName: "busy.js",
				args: undefined,
				budget,
				host,
				signal: controller.signal,
				timeoutMs: 5_000,
			})).rejects.toThrow("test abort");
			expect(heartbeat).toBeGreaterThan(2);
		} finally {
			clearInterval(interval);
			clearTimeout(timer);
		}
	});
});

describe("workflow hardening primitives", () => {
	test("lexical validation rejects known constructor escapes", () => {
		const malicious = source('return agent.constructor.constructor("return process")();');
		expect(validateScript(malicious).join("\n")).toContain("constructor");
	});

	test("meta parsing rejects executable object features", () => {
		expect(() => extractMeta("export const meta = { name: makeName() };\nreturn 1;")).toThrow();
		expect(() => extractMeta("export const meta = { name: 'x', ...other };\nreturn 1;")).toThrow();
		expect(() => extractMeta("export const meta = { name: 'x', get description() { return 'x' } };\nreturn 1;")).toThrow();
	});

	test("abort-aware scheduler never admits an aborted queued task", async () => {
		const scheduler = new AbortableScheduler(1);
		const first = new AbortController();
		const release = await scheduler.acquire(first.signal);
		const second = new AbortController();
		const queued = scheduler.acquire(second.signal);
		expect(scheduler.queuedCount).toBe(1);
		second.abort(new Error("cancel queued"));
		await expect(queued).rejects.toThrow("cancel queued");
		release();
		expect(scheduler.activeCount).toBe(0);
		expect(scheduler.queuedCount).toBe(0);
	});

	test("native structured output validates values larger than the display limit", () => {
		const runtime = createStructuredOutputRuntime({
			type: "object",
			required: ["blob"],
			properties: { blob: { type: "string", minLength: 60_000 } },
			additionalProperties: false,
		});
		try {
			fs.writeFileSync(runtime.outputPath, JSON.stringify({ blob: "x".repeat(60_000) }));
			const result = readStructuredOutput(runtime);
			expect(result.error).toBeUndefined();
			expect((result.value as { blob: string }).blob).toHaveLength(60_000);
		} finally {
			cleanupStructuredOutputRuntime(runtime);
		}
	});

	test("atomic writes never expose a partial replacement", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-store-"));
		const file = path.join(dir, "state.json");
		await Promise.all(Array.from({ length: 20 }, (_, index) => atomicWriteFile(file, JSON.stringify({ index, payload: "x".repeat(10_000) }))));
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(parsed.index).toBeGreaterThanOrEqual(0);
		expect(parsed.payload).toHaveLength(10_000);
	});

	test("reruns use persisted dependency bytes rather than current mutable files", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-dependencies-"));
		const workflowDir = path.join(cwd, ".pi", "workflows");
		fs.mkdirSync(workflowDir, { recursive: true });
		const dependencyPath = path.join(workflowDir, "dep.ts");
		const rootPath = path.join(workflowDir, "root.ts");
		const originalDependency = 'export const meta = { version: 2, name: "dep" };\nreturn "original";\n';
		const rootSource = 'export const meta = { version: 2, name: "root", dependencies: ["dep"] };\nreturn workflow("dep");\n';
		fs.writeFileSync(dependencyPath, originalDependency);
		fs.writeFileSync(rootPath, rootSource);
		const prepared = await prepareWorkflow({ name: "root", path: rootPath, scope: "project", hash: "" } as any, cwd);
		const runDir = path.join(cwd, ".pi", "workflow-runs", "saved");
		fs.mkdirSync(path.join(runDir, "dependencies"), { recursive: true });
		fs.writeFileSync(path.join(runDir, "script.js"), prepared.source);
		fs.writeFileSync(path.join(runDir, "dependencies", "dep.js"), prepared.dependencies.get("dep")!.source);
		const run = {
			id: "saved", name: "root", workflowPath: rootPath, scope: "project", hash: prepared.approvalHash,
			cwd, args: "", status: "succeeded", startedAt: Date.now(), phases: [], agents: [], runDir, meta: prepared.meta,
		} as RunState;
		fs.writeFileSync(dependencyPath, 'export const meta = { version: 2, name: "dep" };\nreturn "mutated";\n');
		const rerun = await preparePersistedRunWorkflow(run);
		expect(rerun.dependencies.get("dep")?.source).toBe(originalDependency);
		expect(rerun.approvalHash).toBe(prepared.approvalHash);
	});

	test("concurrent persistence produces a monotonic journal and valid latest snapshot", async () => {
		const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-persist-"));
		const run = {
			id: "persist-run", name: "test", workflowPath: "/virtual/test.js", scope: "script", hash: "hash",
			cwd: runDir, args: "", status: "running", startedAt: Date.now(), phases: [], agents: [], runDir, eventSeq: 0,
		} as RunState;
		await Promise.all(Array.from({ length: 100 }, (_, index) => persistRun(run, { type: "test", index })));
		const events = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
		const state = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
		expect(state.eventSeq).toBe(100);
	});

	test("workflow children drop inherited extensions and custom or direct-write tools", () => {
		const confined = confineAgentConfig({
			name: "unsafe", description: "", systemPrompt: "", tools: ["*"], extensions: ["/tmp/host-write.ts"],
			mcpDirectTools: ["host-write"], defaultReads: ["/etc/passwd"], output: "/tmp/leak",
		} as any);
		expect(confined.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(confined.extensions).toHaveLength(1);
		expect(confined.extensions?.[0]).toContain("child-guard.ts");
		expect(confined.mcpDirectTools).toEqual([]);
		expect(confined.defaultReads).toEqual([]);
		expect(confined.output).toBeUndefined();
		const explicit = confineAgentConfig({ name: "unsafe", description: "", systemPrompt: "" } as any, ["read", "write", "edit", "host_write", "bash"]);
		expect(explicit.tools).toEqual(["read", "bash"]);
	});

	test("workflow children retain only the catastrophic command safety floor", () => {
		expect(workflowChildCommandBlockReason("gh pr merge 123 --squash")).toContain("gh-pr-merge");
		expect(workflowChildCommandBlockReason("git push --force origin main")).toContain("git-force-push-protected");
		expect(workflowChildCommandBlockReason("git push origin main")).toContain("git-push-protected");
		expect(workflowChildCommandBlockReason("git checkout main && git push")).toContain("git-bare-push-protected");
		expect(workflowChildCommandBlockReason("git checkout main && git push origin HEAD")).toContain("git-push-protected");
		expect(workflowChildCommandBlockReason('bash -c "git push origin main"')).toContain("git-push-protected");
		expect(workflowChildCommandBlockReason("sh -c 'git push origin HEAD'")).toContain("git-push-protected");
		expect(workflowChildCommandBlockReason("git -C . push origin main")).toContain("git-push-protected");
		expect(workflowChildCommandBlockReason("git push origin feature/x && git -C . push origin main")).toContain("git-push-protected");
		expect(workflowChildCommandBlockReason("git push origin feature/autonomous-workflow")).toBeUndefined();
		expect(workflowChildCommandBlockReason("git push origin HEAD:feature/autonomous-workflow")).toBeUndefined();
		expect(workflowChildCommandBlockReason("npm test")).toBeUndefined();
	});

	test("child path and bash guards block absolute writes outside the isolated repository", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-guard-root-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-guard-outside-"));
		const target = path.join(outside, "target.txt");
		fs.writeFileSync(target, "safe\n");
		fs.symlinkSync(target, path.join(root, "escape-link"));
		expect(isInside(root, target)).toBe(false);
		expect(isInside(root, path.join(root, "escape-link"))).toBe(false);
		const inside = path.join(root, "inside.txt");
		const guarded = sandboxCommand(`test ! -e ${JSON.stringify(target)} && printf confined > ${JSON.stringify(inside)}`, root, root);
		expect(guarded).toContain("--unshare-all");
		expect(guarded).toContain("--clearenv");
		expect(guarded).not.toContain("--ro-bind / /");
		execFileSync("/bin/bash", ["-lc", guarded], { stdio: "pipe" });
		expect(fs.readFileSync(target, "utf8")).toBe("safe\n");
		expect(fs.readFileSync(inside, "utf8")).toBe("confined");
	});

	test("duplicate labels receive unique worktrees and never mutate the original checkout", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-repo-"));
		fs.writeFileSync(path.join(root, ".gitignore"), ".pi/\n");
		fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
		fs.writeFileSync(path.join(root, "tracked.txt"), "dirty launch state\n");
		const originalBranch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
		const runDir = path.join(root, ".pi", "workflow-runs", "test-run");
		fs.mkdirSync(runDir, { recursive: true });
		const launchPatch = execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root, encoding: "utf8" });
		const launchPatchPath = path.join(runDir, "repository-launch.diff");
		fs.writeFileSync(launchPatchPath, launchPatch);
		const run = {
			id: "test-run", name: "test", workflowPath: "/virtual/test.js", scope: "script", hash: "hash",
			cwd: root, args: "", status: "running", startedAt: Date.now(), phases: [], agents: [], runDir, eventSeq: 0,
			repositorySnapshot: {
				root, relativeCwd: ".", head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
				trackedPatchPath: launchPatchPath, trackedPatchHash: createHash("sha256").update(launchPatch).digest("hex"),
				untrackedNames: [], hash: "snapshot",
			},
		} as RunState;
		const firstRecord = { id: "agent-0001", label: "duplicate", agent: "worker", status: "running", startedAt: Date.now() } as any;
		const secondRecord = { id: "agent-0002", label: "duplicate", agent: "worker", status: "running", startedAt: Date.now() } as any;
		const first = await createAgentWorktree(run, firstRecord, root);
		fs.writeFileSync(path.join(root, "tracked.txt"), "changed after launch\n");
		const second = await createAgentWorktree(run, secondRecord, root);
		expect(first.path).not.toBe(second.path);
		expect(fs.readFileSync(path.join(first.path, "tracked.txt"), "utf8")).toBe("dirty launch state\n");
		expect(fs.readFileSync(path.join(second.path, "tracked.txt"), "utf8")).toBe("dirty launch state\n");
		fs.writeFileSync(path.join(first.path, "tracked.txt"), "agent change\n");
		const hostEscapeMarker = path.join(os.tmpdir(), `workflow-git-filter-escape-${process.pid}`);
		fs.rmSync(hostEscapeMarker, { force: true });
		execFileSync("git", ["config", "filter.workflow-pwn.clean", `sh -c 'printf escaped > ${hostEscapeMarker}; cat'`], { cwd: first.path });
		fs.writeFileSync(path.join(first.path, ".gitattributes"), "*.pwn filter=workflow-pwn\n");
		fs.writeFileSync(path.join(first.path, "trigger.pwn"), "trigger\n");
		const firstResult = await finalizeAgentWorktree(run, firstRecord, first);
		expect(fs.existsSync(hostEscapeMarker)).toBe(false);
		expect(firstResult.preserved).toBe(true);
		const reviewRecord = { id: "agent-0003", label: "review", agent: "reviewer", status: "running", startedAt: Date.now() } as any;
		const review = await createAgentWorktree(run, reviewRecord, root, [firstResult.diffPath!]);
		expect(fs.readFileSync(path.join(review.path, "tracked.txt"), "utf8")).toBe("agent change\n");
		const reviewResult = await finalizeAgentWorktree(run, reviewRecord, review);
		const secondResult = await finalizeAgentWorktree(run, secondRecord, second);
		expect(reviewResult.preserved).toBe(false);
		expect(secondResult.preserved).toBe(false);
		expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe("changed after launch\n");
		expect(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim()).toBe(originalBranch);
		fs.rmSync(first.path, { recursive: true, force: true });

		const failedRecord = { id: "agent-9999", label: "broken", agent: "worker", status: "running", startedAt: Date.now() } as any;
		run.repositorySnapshot!.trackedPatchHash = "corrupt";
		await expect(createAgentWorktree(run, failedRecord, root)).rejects.toThrow("integrity check");
		const leakedPath = path.join(os.homedir(), ".pi", "agent", "workflow-workspaces", run.id, failedRecord.id);
		expect(fs.existsSync(leakedPath)).toBe(false);
	});

	test("transcript tails bound I/O and omit old content", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-tail-"));
		const file = path.join(dir, "session.jsonl");
		const entry = (text: string) => `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
		fs.writeFileSync(file, entry("old-marker") + " ".repeat(300_000) + "\n" + entry("last-marker"));
		const tail = renderSessionTail(file, 20);
		expect(tail).toContain("last-marker");
		expect(tail).not.toContain("old-marker");
	});
});
