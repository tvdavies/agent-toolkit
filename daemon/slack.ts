/**
 * Slack Socket Mode bridge.
 *
 * Socket Mode opens an OUTBOUND WebSocket to Slack — no inbound port or public
 * tunnel, which is exactly right for a personal machine behind NAT. Built on
 * Node's global `WebSocket` and `fetch` (both injectable) so there is no Slack
 * SDK dependency and the bridge is fully testable with fakes.
 *
 * Flow: apps.connections.open (app token) -> WSS -> ack every envelope ->
 * map events to triggers (allowlist applied in ./slack-events) -> reply to a
 * thread via chat.postMessage (bot token).
 */

import { backoffDelay } from "./backoff.ts";
import { mapSlackEvent, type SlackConfig, type SlackOrigin } from "./slack-events.ts";

export interface WebSocketLike {
	send(data: string): void;
	close(): void;
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
}

export type SlackTrigger = { text: string; source: "slack"; origin: SlackOrigin };

/** Minimal fetch surface the bridge needs (the global fetch satisfies it). */
export type FetchLike = (
	input: string | URL,
	init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ json(): Promise<unknown> }>;

export type SlackBridgeOptions = {
	appToken: string;
	botToken: string;
	slack: SlackConfig;
	onTrigger: (trigger: SlackTrigger) => void;
	fetchFn?: FetchLike;
	createWebSocket?: (url: string) => WebSocketLike;
	setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	logger?: (message: string) => void;
};

const SLACK_API = "https://slack.com/api";

export class SlackBridge {
	private readonly o: SlackBridgeOptions;
	private readonly fetchFn: FetchLike;
	private readonly createWebSocket: (url: string) => WebSocketLike;
	private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	private ws: WebSocketLike | undefined;
	private stopped = false;
	private failures = 0;

	constructor(options: SlackBridgeOptions) {
		this.o = options;
		this.fetchFn = options.fetchFn ?? (fetch as unknown as FetchLike);
		this.createWebSocket =
			options.createWebSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
		this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	}

	/** Open the Socket Mode connection. */
	async connect(): Promise<void> {
		this.stopped = false;
		await this.openSocket();
	}

	stop(): void {
		this.stopped = true;
		this.ws?.close();
		this.ws = undefined;
	}

	/** Post a message to a channel (optionally threaded). */
	async postMessage(channel: string, text: string, threadTs?: string): Promise<boolean> {
		const res = await this.fetchFn(`${SLACK_API}/chat.postMessage`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${this.o.botToken}`,
				"content-type": "application/json; charset=utf-8",
			},
			body: JSON.stringify({ channel, text, thread_ts: threadTs }),
		});
		const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
		if (!data.ok) this.o.logger?.(`[slack] postMessage failed: ${data.error ?? "unknown"}`);
		return data.ok === true;
	}

	/** Post a reply into the originating Slack thread. */
	postReply(origin: SlackOrigin, text: string): Promise<boolean> {
		return this.postMessage(origin.channel, text, origin.threadTs);
	}

	private async openSocket(): Promise<void> {
		const res = await this.fetchFn(`${SLACK_API}/apps.connections.open`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${this.o.appToken}`,
				"content-type": "application/x-www-form-urlencoded",
			},
		});
		const data = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
		if (!data.ok || !data.url) {
			this.o.logger?.(`[slack] apps.connections.open failed: ${data.error ?? "unknown"}`);
			this.scheduleReconnect();
			return;
		}
		const ws = this.createWebSocket(data.url);
		this.ws = ws;
		ws.addEventListener("open", () => this.o.logger?.("[slack] socket open"));
		ws.addEventListener("message", (event) => this.onMessage(String(event?.data ?? "")));
		ws.addEventListener("close", () => {
			if (!this.stopped) this.scheduleReconnect();
		});
		ws.addEventListener("error", () => this.o.logger?.("[slack] socket error"));
	}

	private onMessage(raw: string): void {
		let envelope: { type?: string; envelope_id?: string; payload?: any };
		try {
			envelope = JSON.parse(raw);
		} catch {
			return;
		}
		// Ack every envelope that carries an id (Slack requires prompt acks).
		if (envelope.envelope_id) this.ws?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));

		if (envelope.type === "hello") {
			this.failures = 0;
			this.o.logger?.("[slack] connected");
			return;
		}
		if (envelope.type === "disconnect") {
			this.ws?.close();
			return;
		}
		if (envelope.type === "events_api" && envelope.payload?.event) {
			const mapped = mapSlackEvent(envelope.payload.event, this.o.slack);
			if (mapped.kind === "trigger") {
				this.o.onTrigger({ text: mapped.text, source: "slack", origin: mapped.origin });
			}
		}
	}

	private scheduleReconnect(): void {
		if (this.stopped) return;
		this.failures += 1;
		const delay = backoffDelay(this.failures, { baseMs: 1000, maxMs: 30_000 });
		this.o.logger?.(`[slack] reconnecting in ${delay}ms`);
		this.setTimer(() => {
			if (!this.stopped) void this.openSocket();
		}, delay);
	}
}
