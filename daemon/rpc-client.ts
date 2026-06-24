/**
 * RpcClient — drives a `pi --mode rpc` child process over stdio.
 *
 * Owns the strict-LF JSONL framing (see ./framing), tracks streaming state from
 * agent_start/agent_end so triggers are delivered as `prompt` when idle and
 * `follow_up` when busy, and answers the extension UI sub-protocol so the agent
 * never blocks on an unanswered dialog (default: auto-cancel, which is safe under
 * high autonomy where guardrails do not prompt).
 *
 * The child process is injectable (`spawn`) so it can be driven against the
 * fake-pi fixture in tests without a real model.
 */

import {
	type ChildProcess,
	type SpawnOptions,
	spawn as nodeSpawn,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { encodeCommand, JsonlFramer, parseLine } from "./framing.ts";

export type RpcEvent = { type: string; [key: string]: unknown };

/** Answer an extension UI dialog request; return undefined to auto-cancel. */
export type UiResponder = (request: RpcEvent) => Record<string, unknown> | undefined;

type SpawnLike = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => ChildProcess;

export type RpcClientOptions = {
	command: string;
	args: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	spawn?: SpawnLike;
	/** Answer dialog UI requests (select/confirm/input/editor). */
	uiResponder?: UiResponder;
	/** Observe fire-and-forget UI requests (notify/setStatus/...). */
	onUiNotify?: (request: RpcEvent) => void;
	logger?: (message: string) => void;
};

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export class RpcClient extends EventEmitter {
	private child: ChildProcess | undefined;
	private streaming = false;
	private reqSeq = 0;
	private readonly framer = new JsonlFramer();
	private readonly options: RpcClientOptions;

	constructor(options: RpcClientOptions) {
		super();
		this.options = options;
	}

	/** Spawn the child and wire stdio. */
	start(): void {
		const spawnFn = this.options.spawn ?? nodeSpawn;
		const child = spawnFn(this.options.command, this.options.args, {
			cwd: this.options.cwd,
			env: this.options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.streaming = false;

		child.stdout?.on("data", (chunk: Buffer) => {
			for (const line of this.framer.push(chunk)) this.handleLine(line);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			this.options.logger?.(`[pi stderr] ${chunk.toString().trimEnd()}`);
		});
		child.on("error", (err) => this.emit("error", err));
		child.on("exit", (code, signal) => {
			for (const line of this.framer.flush()) this.handleLine(line);
			this.child = undefined;
			this.streaming = false;
			this.emit("exit", code, signal);
		});
	}

	/** Whether the child is alive. */
	get running(): boolean {
		return this.child !== undefined;
	}

	/** Whether the agent is mid-run. */
	isStreaming(): boolean {
		return this.streaming;
	}

	/** Process id of the child, if running. */
	get pid(): number | undefined {
		return this.child?.pid;
	}

	/** Deliver work: a fresh prompt when idle, a follow-up when busy. */
	submit(text: string): void {
		if (this.streaming) {
			this.send({ type: "prompt", message: text, streamingBehavior: "followUp" });
		} else {
			this.send({ type: "prompt", message: text });
		}
	}

	/** Send a raw RPC command. */
	send(command: Record<string, unknown>): void {
		this.child?.stdin?.write(encodeCommand(command));
	}

	/** Send a command and resolve with its id-correlated response (or undefined on timeout). */
	request(command: Record<string, unknown>, timeoutMs = 10_000): Promise<RpcEvent | undefined> {
		this.reqSeq += 1;
		const id = `req-${this.reqSeq}`;
		return new Promise((resolve) => {
			const onResponse = (event: RpcEvent) => {
				if ((event as { id?: string }).id === id) {
					cleanup();
					resolve(event);
				}
			};
			const cleanup = () => {
				this.off("response", onResponse);
				clearTimeout(timer);
			};
			const timer = setTimeout(() => {
				cleanup();
				resolve(undefined);
			}, timeoutMs);
			this.on("response", onResponse);
			this.send({ ...command, id });
		});
	}

	/** Abort any running turn, then terminate the child (SIGKILL fallback). */
	async stop(timeoutMs = 5000): Promise<void> {
		const child = this.child;
		if (!child) return;
		try {
			this.send({ type: "abort" });
		} catch {
			// ignore — we are tearing down anyway
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, timeoutMs);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			child.kill("SIGTERM");
		});
	}

	private handleLine(line: string): void {
		const event = parseLine<RpcEvent>(line);
		if (!event || typeof event.type !== "string") return;

		if (event.type === "extension_ui_request") {
			this.handleUiRequest(event);
			return;
		}
		if (event.type === "agent_start") this.streaming = true;
		if (event.type === "agent_end") this.streaming = false;

		this.options.logger?.(`[pi event] ${event.type}`);
		this.emit("event", event);
		this.emit(event.type, event);
	}

	private handleUiRequest(request: RpcEvent): void {
		const method = String(request.method ?? "");
		if (!DIALOG_METHODS.has(method)) {
			this.options.onUiNotify?.(request);
			return;
		}
		const id = request.id;
		const answer = this.options.uiResponder?.(request);
		this.send(
			answer
				? { type: "extension_ui_response", id, ...answer }
				: { type: "extension_ui_response", id, cancelled: true },
		);
	}
}
