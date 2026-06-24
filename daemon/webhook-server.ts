/**
 * Webhook HTTP server — a tiny loopback-only listener that turns verified HTTP
 * requests into triggers (see ./webhook for the pure decision logic).
 *
 * Binds 127.0.0.1 by default: the only network attack surface is local, and
 * requests are still authenticated (shared secret or Slack signature). Slack is
 * better served by the Socket Mode bridge (no inbound port); this exists for
 * generic webhooks and Events-API setups.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handleWebhook, type WebhookConfig } from "./webhook.ts";

export type IngestedTrigger = {
	text: string;
	source: string;
	origin?: { kind: string; channel?: string; threadTs?: string; user?: string };
};

export type WebhookServerOptions = {
	config: WebhookConfig;
	onTrigger: (trigger: IngestedTrigger) => void;
	host?: string;
	port?: number;
	/** Max request body bytes (defence against abuse). */
	maxBodyBytes?: number;
	logger?: (message: string) => void;
};

const DEFAULT_MAX_BODY = 1_000_000;

export class WebhookServer {
	private server: Server | undefined;
	private readonly o: WebhookServerOptions;

	constructor(options: WebhookServerOptions) {
		this.o = options;
	}

	/** Start listening; resolves with the bound port. */
	start(): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => this.handle(req, res));
			server.on("error", reject);
			server.listen(this.o.port ?? 8787, this.o.host ?? "127.0.0.1", () => {
				const address = server.address();
				const port = typeof address === "object" && address ? address.port : (this.o.port ?? 0);
				this.o.logger?.(`[webhook] listening on ${this.o.host ?? "127.0.0.1"}:${port}`);
				resolve(port);
			});
			this.server = server;
		});
	}

	stop(): Promise<void> {
		return new Promise((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
			this.server = undefined;
		});
	}

	get port(): number | undefined {
		const address = this.server?.address();
		return typeof address === "object" && address ? address.port : undefined;
	}

	private handle(req: IncomingMessage, res: ServerResponse): void {
		const chunks: Buffer[] = [];
		let size = 0;
		let aborted = false;
		const limit = this.o.maxBodyBytes ?? DEFAULT_MAX_BODY;

		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				aborted = true;
				this.respond(res, 413, { error: "payload too large" });
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});

		req.on("end", () => {
			if (aborted) return;
			const body = Buffer.concat(chunks).toString("utf8");
			const path = new URL(req.url ?? "/", "http://localhost").pathname;
			const headers = lowerHeaders(req.headers);
			const result = handleWebhook({ method: req.method ?? "GET", path, headers, body }, this.o.config);

			switch (result.kind) {
				case "trigger":
					this.o.onTrigger({ text: result.text, source: result.source, origin: result.origin });
					this.respond(res, 200, { ok: true });
					return;
				case "challenge":
					this.respond(res, 200, { challenge: result.challenge });
					return;
				case "ignore":
					this.respond(res, 200, { ok: true, ignored: result.reason });
					return;
				case "reject":
					this.respond(res, result.status, { error: result.message });
					return;
			}
		});
	}

	private respond(res: ServerResponse, status: number, body: unknown): void {
		res.statusCode = status;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(body));
	}
}

function lowerHeaders(headers: IncomingMessage["headers"]): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(headers)) {
		out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
	}
	return out;
}
