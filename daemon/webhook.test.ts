import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { handleWebhook, verifySlackSignature, type WebhookConfig } from "./webhook";

const config: WebhookConfig = {
	sharedSecret: "shh",
	slackSigningSecret: "sign-me",
	slack: { allowedUsers: ["U_TOM"], botUserId: "U_BOT" },
};

function slackRequest(body: string, secret: string, now: number) {
	const timestamp = String(Math.floor(now / 1000));
	const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
	return {
		method: "POST",
		path: "/slack/events",
		headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${digest}` },
		body,
		now,
	};
}

describe("handleWebhook — /trigger", () => {
	it("accepts a correct shared secret and extracts text", () => {
		const r = handleWebhook(
			{ method: "POST", path: "/trigger", headers: { "x-toolkit-secret": "shh" }, body: '{"text":"go"}' },
			config,
		);
		expect(r).toEqual({ kind: "trigger", text: "go", source: "webhook" });
	});

	it("rejects a wrong secret", () => {
		const r = handleWebhook(
			{ method: "POST", path: "/trigger", headers: { "x-toolkit-secret": "nope" }, body: "{}" },
			config,
		);
		expect(r).toMatchObject({ kind: "reject", status: 401 });
	});

	it("rejects non-POST", () => {
		expect(
			handleWebhook({ method: "GET", path: "/trigger", headers: {}, body: "" }, config),
		).toMatchObject({ kind: "reject", status: 405 });
	});
});

describe("handleWebhook — /slack/events", () => {
	const now = 1_700_000_000_000;

	it("answers url_verification with the challenge", () => {
		const r = handleWebhook(
			{
				method: "POST",
				path: "/slack/events",
				headers: {},
				body: JSON.stringify({ type: "url_verification", challenge: "abc" }),
			},
			config,
		);
		expect(r).toEqual({ kind: "challenge", challenge: "abc" });
	});

	it("accepts a validly-signed allowed message", () => {
		const body = JSON.stringify({
			type: "event_callback",
			event: { type: "message", text: "deploy", user: "U_TOM", channel: "C1", ts: "1.1" },
		});
		const r = handleWebhook(slackRequest(body, "sign-me", now), config);
		expect(r.kind).toBe("trigger");
		if (r.kind === "trigger") {
			expect(r.text).toBe("deploy");
			expect(r.source).toBe("slack");
			expect(r.origin?.channel).toBe("C1");
		}
	});

	it("rejects a bad signature", () => {
		const body = JSON.stringify({ type: "event_callback", event: { type: "message", text: "x", user: "U_TOM", channel: "C1", ts: "1" } });
		const req = slackRequest(body, "WRONG-SECRET", now);
		expect(handleWebhook(req, config)).toMatchObject({ kind: "reject", status: 401 });
	});

	it("rejects a stale timestamp", () => {
		const body = JSON.stringify({ type: "event_callback", event: {} });
		const req = slackRequest(body, "sign-me", now - 10 * 60 * 1000); // 10m old vs now
		expect(handleWebhook({ ...req, now }, config)).toMatchObject({ kind: "reject", status: 401 });
	});
});

describe("verifySlackSignature", () => {
	it("verifies a known signature", () => {
		const body = "hello";
		const timestamp = "100";
		const digest = createHmac("sha256", "sign-me").update(`v0:${timestamp}:${body}`).digest("hex");
		expect(
			verifySlackSignature({ signingSecret: "sign-me", timestamp, body, signature: `v0=${digest}` }),
		).toBe(true);
		expect(
			verifySlackSignature({ signingSecret: "sign-me", timestamp, body, signature: "v0=deadbeef" }),
		).toBe(false);
	});
});

describe("handleWebhook — unknown path", () => {
	it("404s", () => {
		expect(
			handleWebhook({ method: "POST", path: "/nope", headers: {}, body: "" }, config),
		).toMatchObject({ kind: "reject", status: 404 });
	});
});
