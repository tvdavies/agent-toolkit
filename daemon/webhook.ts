/**
 * Webhook request handling (pure).
 *
 * Two endpoints, both verified:
 *  - POST /trigger        — generic webhook, authorised by a shared-secret header.
 *  - POST /slack/events   — Slack Events API, authorised by HMAC signature, with
 *                           url_verification challenge support.
 *
 * Socket Mode (see ./slack) is the preferred Slack path (no inbound port); this
 * HTTP path exists for non-Slack signals and for Slack-via-Events-API setups.
 * The server (./webhook-server) binds 127.0.0.1 and applies these decisions.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { mapSlackEvent, type SlackConfig, type SlackOrigin } from "./slack-events.ts";

export type WebhookConfig = {
	/** Shared secret required on POST /trigger via the x-toolkit-secret header. */
	sharedSecret?: string;
	/** Slack signing secret for verifying POST /slack/events. */
	slackSigningSecret?: string;
	slack?: SlackConfig;
	/** Max clock skew for Slack timestamps, seconds. */
	maxSkewSec?: number;
};

export type WebhookRequest = {
	method: string;
	path: string;
	headers: Record<string, string | undefined>;
	body: string;
	now?: number;
};

export type WebhookResult =
	| { kind: "trigger"; text: string; source: string; origin?: SlackOrigin }
	| { kind: "challenge"; challenge: string }
	| { kind: "ignore"; reason: string }
	| { kind: "reject"; status: number; message: string };

/** Constant-time string compare that tolerates length differences. */
function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

export function isFreshTimestamp(timestamp: string, now: number, maxSkewSec = 300): boolean {
	const ts = Number(timestamp);
	if (!Number.isFinite(ts)) return false;
	return Math.abs(now / 1000 - ts) <= maxSkewSec;
}

/** Verify a Slack request signature (v0=HMAC-SHA256 of `v0:ts:body`). */
export function verifySlackSignature(opts: {
	signingSecret: string;
	timestamp: string;
	body: string;
	signature: string;
}): boolean {
	const base = `v0:${opts.timestamp}:${opts.body}`;
	const digest = createHmac("sha256", opts.signingSecret).update(base).digest("hex");
	return safeEqual(`v0=${digest}`, opts.signature);
}

export function handleWebhook(req: WebhookRequest, config: WebhookConfig): WebhookResult {
	if (req.method.toUpperCase() !== "POST") {
		return { kind: "reject", status: 405, message: "method not allowed" };
	}
	const now = req.now ?? Date.now();

	if (req.path === "/trigger") {
		if (!config.sharedSecret) return { kind: "reject", status: 503, message: "webhook secret not configured" };
		const provided = req.headers["x-toolkit-secret"] ?? "";
		if (!safeEqual(provided, config.sharedSecret)) {
			return { kind: "reject", status: 401, message: "bad secret" };
		}
		const text = extractText(req.body);
		if (!text) return { kind: "reject", status: 400, message: "missing text" };
		return { kind: "trigger", text, source: "webhook" };
	}

	if (req.path === "/slack/events") {
		const parsed = parseJson(req.body);
		if (parsed && parsed.type === "url_verification" && typeof parsed.challenge === "string") {
			return { kind: "challenge", challenge: parsed.challenge };
		}
		if (!config.slackSigningSecret) {
			return { kind: "reject", status: 503, message: "slack signing secret not configured" };
		}
		const timestamp = req.headers["x-slack-request-timestamp"] ?? "";
		const signature = req.headers["x-slack-signature"] ?? "";
		if (!isFreshTimestamp(timestamp, now, config.maxSkewSec)) {
			return { kind: "reject", status: 401, message: "stale timestamp" };
		}
		if (!verifySlackSignature({ signingSecret: config.slackSigningSecret, timestamp, body: req.body, signature })) {
			return { kind: "reject", status: 401, message: "bad signature" };
		}
		if (!parsed || parsed.type !== "event_callback" || !parsed.event) {
			return { kind: "ignore", reason: "not an event_callback" };
		}
		const mapped = mapSlackEvent(parsed.event, config.slack ?? { allowedUsers: [] });
		if (mapped.kind === "ignore") return mapped;
		return { kind: "trigger", text: mapped.text, source: "slack", origin: mapped.origin };
	}

	return { kind: "reject", status: 404, message: "not found" };
}

function parseJson(body: string): any {
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
}

function extractText(body: string): string {
	const parsed = parseJson(body);
	if (parsed && typeof parsed.text === "string") return parsed.text.trim();
	return body.trim();
}
