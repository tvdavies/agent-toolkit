/**
 * Supervisor — the dumb babysitter that keeps the resident agent alive and fed.
 *
 * Responsibilities (and nothing more — zero LLM logic):
 *  - spawn the RPC client; respawn with exponential backoff on exit, resetting
 *    the backoff after a stable run;
 *  - drain the trigger inbox on a poll and forward each trigger to the agent;
 *  - write daemon-status.json so /status and the dashboard can see health.
 *
 * Timers and clock are injectable so restart/backoff behaviour is tested
 * deterministically without real waits.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { backoffDelay } from "./backoff.ts";
import type { Trigger, TriggerOrigin } from "./inbox.ts";
import type { RpcClient } from "./rpc-client.ts";

/** Extract the concatenated text of the last assistant message in a run. */
export function lastAssistantText(messages: unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i] as { role?: string; content?: unknown };
		if (message?.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content.trim() || undefined;
		if (Array.isArray(message.content)) {
			const text = message.content
				.filter((part: any) => part?.type === "text")
				.map((part: any) => String(part.text ?? ""))
				.join("")
				.trim();
			return text || undefined;
		}
	}
	return undefined;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export type SupervisorOptions = {
	createClient: () => RpcClient;
	inbox: { drain(): Trigger[] };
	statusPath: string;
	instance?: string;
	/** Inbox poll interval (ms). 0 disables the auto-poll (tests call pollInbox). */
	pollMs?: number;
	/** Status-write interval (ms). 0 disables the periodic write. */
	statusMs?: number;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => TimerHandle;
	clearTimer?: (handle: TimerHandle) => void;
	/** Hook invoked for each forwarded trigger (e.g. to record a decision). */
	onForward?: (trigger: Trigger) => void;
	/** Post a reply for a trigger that had an origin (e.g. a Slack thread). */
	onReply?: (origin: TriggerOrigin, text: string) => void;
	/** When it returns true, forwarding is paused (e.g. the daily spend cap). */
	gate?: () => boolean;
	/** A run longer than this (ms) resets the restart backoff. */
	stableResetMs?: number;
};

type LastTrigger = { text: string; source?: string; at: string };

export class Supervisor {
	private readonly o: Required<
		Omit<SupervisorOptions, "onForward" | "instance" | "onReply" | "gate">
	> &
		Pick<SupervisorOptions, "onForward" | "instance" | "onReply" | "gate">;
	private client: RpcClient | undefined;
	private readonly pendingOrigins: TriggerOrigin[] = [];
	private stopping = false;
	private restarts = 0;
	private consecutiveFailures = 0;
	private startedAtMs = 0;
	private lastTrigger: LastTrigger | undefined;
	private pollHandle: TimerHandle | undefined;
	private statusHandle: TimerHandle | undefined;
	private restartHandle: TimerHandle | undefined;

	constructor(options: SupervisorOptions) {
		this.o = {
			createClient: options.createClient,
			inbox: options.inbox,
			statusPath: options.statusPath,
			pollMs: options.pollMs ?? 1000,
			statusMs: options.statusMs ?? 10_000,
			now: options.now ?? Date.now,
			setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
			clearTimer: options.clearTimer ?? ((h) => clearTimeout(h)),
			stableResetMs: options.stableResetMs ?? 60_000,
			onForward: options.onForward,
			onReply: options.onReply,
			gate: options.gate,
			instance: options.instance,
		};
	}

	start(): void {
		this.stopping = false;
		this.spawnClient();
		if (this.o.pollMs > 0) {
			this.pollHandle = setInterval(() => this.pollInbox(), this.o.pollMs);
		}
		if (this.o.statusMs > 0) {
			this.statusHandle = setInterval(() => this.writeStatus(), this.o.statusMs);
		}
		this.writeStatus();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		if (this.pollHandle) clearInterval(this.pollHandle);
		if (this.statusHandle) clearInterval(this.statusHandle);
		if (this.restartHandle) this.o.clearTimer(this.restartHandle);
		await this.client?.stop();
		this.client = undefined;
		this.writeStatus();
	}

	/** Drain the inbox and forward each trigger. Public for deterministic tests. */
	pollInbox(): void {
		// Paused (e.g. over the daily spend cap): leave triggers queued in the
		// inbox so they are picked up once forwarding resumes.
		if (this.o.gate?.()) return;
		const fresh = this.o.inbox.drain();
		if (fresh.length === 0) return;
		for (const trigger of fresh) {
			this.client?.submit(trigger.text);
			if (trigger.origin) this.pendingOrigins.push(trigger.origin);
			this.lastTrigger = {
				text: trigger.text,
				source: trigger.source,
				at: trigger.ts ?? new Date(this.o.now()).toISOString(),
			};
			this.o.onForward?.(trigger);
		}
		this.writeStatus();
	}

	private spawnClient(): void {
		const client = this.o.createClient();
		this.client = client;
		this.startedAtMs = this.o.now();
		client.on("exit", () => this.handleExit());
		client.on("agent_end", (event: unknown) => this.handleAgentEnd(event));
		client.start();
	}

	/** On run completion, post a reply for the oldest pending origin (FIFO). */
	private handleAgentEnd(event: unknown): void {
		this.writeStatus();
		const onReply = this.o.onReply;
		if (!onReply || this.pendingOrigins.length === 0) return;
		const origin = this.pendingOrigins.shift();
		const messages = (event as { messages?: unknown[] })?.messages ?? [];
		const text = lastAssistantText(messages);
		if (origin && text) onReply(origin, text);
	}

	private handleExit(): void {
		this.client = undefined;
		if (this.stopping) return;
		this.restarts += 1;
		const uptime = this.o.now() - this.startedAtMs;
		this.consecutiveFailures =
			uptime >= this.o.stableResetMs ? 1 : this.consecutiveFailures + 1;
		const delay = backoffDelay(this.consecutiveFailures);
		this.writeStatus();
		this.restartHandle = this.o.setTimer(() => {
			if (!this.stopping) this.spawnClient();
		}, delay);
	}

	private writeStatus(): void {
		const status = {
			instance: this.o.instance,
			pid: this.client?.pid,
			startedAt: new Date(this.startedAtMs || this.o.now()).toISOString(),
			restarts: this.restarts,
			healthy: this.client?.running ?? false,
			...(this.lastTrigger ? { lastTrigger: this.lastTrigger.at, lastTriggerText: this.lastTrigger.text } : {}),
		};
		try {
			mkdirSync(dirname(this.o.statusPath), { recursive: true });
			writeFileSync(this.o.statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
		} catch {
			// status is best-effort observability
		}
	}
}
