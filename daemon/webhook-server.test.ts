import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type IngestedTrigger, WebhookServer } from "./webhook-server";

let server: WebhookServer;
let port: number;
let triggers: IngestedTrigger[];

beforeEach(async () => {
	triggers = [];
	server = new WebhookServer({
		config: { sharedSecret: "shh", slackSigningSecret: "sign-me", slack: { allowedUsers: ["U_TOM"] } },
		onTrigger: (t) => triggers.push(t),
		port: 0, // ephemeral
	});
	port = await server.start();
});

afterEach(async () => {
	await server.stop();
});

const url = (path: string) => `http://127.0.0.1:${port}${path}`;

describe("WebhookServer", () => {
	it("accepts an authorised /trigger and ingests it", async () => {
		const res = await fetch(url("/trigger"), {
			method: "POST",
			headers: { "x-toolkit-secret": "shh", "content-type": "application/json" },
			body: JSON.stringify({ text: "do the thing" }),
		});
		expect(res.status).toBe(200);
		expect(triggers).toHaveLength(1);
		expect(triggers[0]?.text).toBe("do the thing");
		expect(triggers[0]?.source).toBe("webhook");
	});

	it("rejects a wrong secret with 401 and ingests nothing", async () => {
		const res = await fetch(url("/trigger"), {
			method: "POST",
			headers: { "x-toolkit-secret": "nope" },
			body: "{}",
		});
		expect(res.status).toBe(401);
		expect(triggers).toHaveLength(0);
	});

	it("echoes a Slack url_verification challenge", async () => {
		const res = await fetch(url("/slack/events"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "url_verification", challenge: "xyz" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ challenge: "xyz" });
	});

	it("404s an unknown path", async () => {
		const res = await fetch(url("/nope"), { method: "POST", body: "" });
		expect(res.status).toBe(404);
	});
});
