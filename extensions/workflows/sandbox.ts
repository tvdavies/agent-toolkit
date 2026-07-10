import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PREFIX = "\u001ePI_WORKFLOW:";
const MAX_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_REQUESTS = 10_000;
const KILL_GRACE_MS = 750;
const DEFAULT_SANDBOX_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export interface SandboxBudgetSnapshot {
	total: number | null;
	spent: number;
	remaining: number | null;
}

export interface SandboxHost {
	agent(payload: { prompt?: unknown; opts?: unknown }): Promise<{ value: unknown; budget?: SandboxBudgetSnapshot }>;
	phase(payload: { title?: unknown }): Promise<unknown>;
	log(payload: { message?: unknown }): Promise<unknown>;
	workflow(payload: { nameOrRef?: unknown; args?: unknown }): Promise<{ value: unknown; budget?: SandboxBudgetSnapshot }>;
}

export interface SandboxRunOptions {
	source: string;
	fileName: string;
	args: unknown;
	budget: SandboxBudgetSnapshot;
	host: SandboxHost;
	signal: AbortSignal;
	timeoutMs?: number;
	/** Abort/drain host capabilities when the sandbox exits without a valid completion. */
	onFailure?: (error: Error) => void;
}

export class WorkflowSandboxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowSandboxError";
	}
}

function sandboxRunnerPath(): string {
	return fileURLToPath(new URL("./sandbox-runner.mjs", import.meta.url));
}

function firstExisting(paths: string[]): string | undefined {
	return paths.find((candidate) => fs.existsSync(candidate));
}

function bwrapPath(): string {
	const configured = process.env.PI_WORKFLOW_BWRAP?.trim();
	const candidate = configured || firstExisting(["/usr/bin/bwrap", "/bin/bwrap"]);
	if (!candidate || !fs.existsSync(candidate)) {
		throw new WorkflowSandboxError("Secure workflow execution requires bubblewrap (bwrap). Install it or use a supported declarative workflow runtime; unsafe in-process JavaScript execution is disabled.");
	}
	return candidate;
}

function bindIfPresent(args: string[], source: string, target = source): void {
	if (fs.existsSync(source)) args.push("--ro-bind", source, target);
}

function spawnSandbox(): ChildProcessWithoutNullStreams {
	if (process.platform !== "linux") {
		throw new WorkflowSandboxError("Secure JavaScript workflows currently require Linux with bubblewrap. Unsafe fallback execution is disabled.");
	}
	const runner = sandboxRunnerPath();
	if (!fs.existsSync(runner)) throw new WorkflowSandboxError(`Workflow sandbox runner is missing: ${runner}`);
	const args = ["--unshare-all", "--die-with-parent", "--new-session"];
	bindIfPresent(args, "/usr");
	bindIfPresent(args, "/lib");
	bindIfPresent(args, "/lib64");
	bindIfPresent(args, "/bin");
	args.push(
		"--ro-bind", process.execPath, "/node",
		"--ro-bind", runner, "/runner.mjs",
		"--proc", "/proc",
		"--dev", "/dev",
		"--tmpfs", "/tmp",
		"--chdir", "/tmp",
		"--clearenv",
		"--setenv", "PATH", "/usr/bin:/bin",
		"/node",
		"--permission",
		"--allow-fs-read=/runner.mjs",
		"--max-old-space-size=128",
		"--max-semi-space-size=8",
		"/runner.mjs",
	);
	return spawn(bwrapPath(), args, {
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
		env: {},
		windowsHide: true,
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function killProcessGroup(child: ChildProcessWithoutNullStreams): void {
	if (child.exitCode !== null || child.killed) return;
	try { process.kill(-(child.pid ?? 0), "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
	const timer = setTimeout(() => {
		if (child.exitCode !== null) return;
		try { process.kill(-(child.pid ?? 0), "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
	}, KILL_GRACE_MS);
	timer.unref?.();
}

function writeResponse(child: ChildProcessWithoutNullStreams, token: string, id: string, ok: boolean, value: unknown): void {
	if (!child.stdin.writable) return;
	const message = ok
		? { kind: "response", token, id, ok: true, result: value }
		: { kind: "response", token, id, ok: false, error: errorMessage(value) };
	child.stdin.write(`${JSON.stringify(message)}\n`);
}

/** Execute workflow JavaScript in a disposable process with no host filesystem, network,
 * environment, subprocess, or worker authority. The only capabilities are authenticated RPC
 * requests handled by SandboxHost.
 */
export async function runWorkflowSandbox(options: SandboxRunOptions): Promise<unknown> {
	if (options.signal.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new WorkflowSandboxError("Workflow was aborted before sandbox launch.");
	if (Buffer.byteLength(options.source, "utf8") > MAX_PROTOCOL_LINE_BYTES / 2) throw new WorkflowSandboxError("Workflow script is too large for the sandbox protocol.");
	const child = spawnSandbox();
	const token = crypto.randomBytes(24).toString("hex");
	let stdout = "";
	let stderr = "";
	let settled = false;
	let requestCount = 0;
	let protocolError: Error | undefined;
	let completedValue: unknown;
	let completionReceived = false;
	const pendingRequestIds = new Set<string>();
	const pendingHandlers = new Set<Promise<void>>();
	const seenRequestIds = new Set<string>();

	const abort = () => killProcessGroup(child);
	options.signal.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => {
		protocolError = new WorkflowSandboxError(`Workflow sandbox exceeded ${options.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS}ms.`);
		killProcessGroup(child);
	}, options.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS);
	timeout.unref?.();

	const processLine = (line: string) => {
		const marker = `${PREFIX}${token}:`;
		if (!line.startsWith(marker)) return;
		let message: any;
		try { message = JSON.parse(line.slice(marker.length)); }
		catch { protocolError = new WorkflowSandboxError("Workflow sandbox emitted malformed protocol JSON."); killProcessGroup(child); return; }
		if (message?.kind === "complete") {
			if (completionReceived || pendingRequestIds.size > 0) {
				protocolError = new WorkflowSandboxError("Workflow sandbox attempted to complete with duplicate or outstanding capability requests.");
				killProcessGroup(child);
				return;
			}
			completionReceived = true;
			completedValue = message.value;
			return;
		}
		if (message?.kind === "error") {
			protocolError = new WorkflowSandboxError(`Workflow script failed: ${typeof message.error === "string" ? message.error : "unknown error"}`);
			return;
		}
		if (message?.kind !== "request" || typeof message.id !== "string" || typeof message.method !== "string") {
			protocolError = new WorkflowSandboxError("Workflow sandbox emitted an invalid protocol message.");
			killProcessGroup(child);
			return;
		}
		if (completionReceived || seenRequestIds.has(message.id)) {
			protocolError = new WorkflowSandboxError("Workflow sandbox emitted a request after completion or reused a request id.");
			killProcessGroup(child);
			return;
		}
		seenRequestIds.add(message.id);
		requestCount++;
		if (requestCount > MAX_REQUESTS) {
			protocolError = new WorkflowSandboxError(`Workflow exceeded the sandbox request limit (${MAX_REQUESTS}).`);
			killProcessGroup(child);
			return;
		}
		const handler = options.host[message.method as keyof SandboxHost] as ((payload: any) => Promise<unknown>) | undefined;
		if (typeof handler !== "function") {
			writeResponse(child, token, message.id, false, new WorkflowSandboxError(`Unknown workflow capability: ${message.method}`));
			return;
		}
		pendingRequestIds.add(message.id);
		let handlerTask!: Promise<void>;
		handlerTask = Promise.resolve().then(() => handler(message.payload ?? {})).then(
			(result) => {
				pendingRequestIds.delete(message.id);
				writeResponse(child, token, message.id, true, result);
			},
			(error) => {
				pendingRequestIds.delete(message.id);
				writeResponse(child, token, message.id, false, error);
			},
		).finally(() => pendingHandlers.delete(handlerTask));
		pendingHandlers.add(handlerTask);
	};

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
		if (Buffer.byteLength(stdout, "utf8") > MAX_PROTOCOL_LINE_BYTES * 2) {
			protocolError = new WorkflowSandboxError("Workflow sandbox stdout exceeded the protocol buffer limit.");
			killProcessGroup(child);
			return;
		}
		for (;;) {
			const newline = stdout.indexOf("\n");
			if (newline < 0) break;
			const line = stdout.slice(0, newline);
			stdout = stdout.slice(newline + 1);
			if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
				protocolError = new WorkflowSandboxError("Workflow sandbox emitted an oversized protocol line.");
				killProcessGroup(child);
				break;
			}
			processLine(line);
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384); });

	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	const init = {
		kind: "init",
		token,
		source: options.source,
		fileName: path.basename(options.fileName),
		args: options.args,
		budget: options.budget,
	};
	child.stdin.write(`${JSON.stringify(init)}\n`);

	try {
		const ended = await exit;
		settled = true;
		let terminalError = protocolError;
		if (!terminalError && (!completionReceived || ended.code !== 0)) {
			const detail = stderr.trim() ? `: ${stderr.trim().split("\n").slice(-4).join("\n")}` : "";
			terminalError = new WorkflowSandboxError(`Workflow sandbox exited before completing (code ${ended.code}, signal ${ended.signal ?? "none"})${detail}`);
		}
		if (terminalError) options.onFailure?.(terminalError);
		// A run is not terminal while an admitted host capability can still mutate artifacts.
		// Failure notification aborts those capabilities first; then this drain makes terminal
		// persistence truthful even for a sandbox that throws after fire-and-forget agent().
		if (pendingHandlers.size > 0) await Promise.allSettled([...pendingHandlers]);
		if (options.signal.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new WorkflowSandboxError("Workflow was aborted.");
		if (terminalError) throw terminalError;
		return completedValue;
	} finally {
		clearTimeout(timeout);
		options.signal.removeEventListener("abort", abort);
		if (!settled) killProcessGroup(child);
		try { child.stdin.end(); } catch { /* closed */ }
	}
}
