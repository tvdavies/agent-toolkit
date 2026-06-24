import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SlackBridge, type SlackTrigger, type WebSocketLike } from "./slack";

class FakeWS implements WebSocketLike {
	sent: string[] = [];
	private listeners: Record<string, ((e: any) => void)[]> = {};
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.emit("close", {});
	}
	addEventListener(type: string, listener: (e: any) => void) {
		(this.listeners[type] ??= []).push(listener);
	}
	emit(type: string, event: any) {
		for (const l of this.listeners[type] ?? []) l(event);
	}
}

type FetchCall = { url: string; init: any };

function makeFakeFetch(calls: FetchCall[]) {
	return async (url: string | URL | Request, init?: any) => {
		const u = String(url);
		calls.push({ url: u, init });
		const body =
			u.endsWith("apps.connections.open")
				? { ok: true, url: "wss://fake.slack" }
				: u.endsWith("chat.postMessage")
					? { ok: true }
					: { ok: false, error: "unknown" };
		return { json: async () => body } as unknown as Response;
	};
}

let bridge: SlackBridge;
let sockets: FakeWS[];
let calls: FetchCall[];
let triggers: SlackTrigger[];
let timers: { fn: () => void; ms: number }[];

beforeEach(() => {
	sockets = [];
	calls = [];
	triggers = [];
	timers = [];
	bridge = new SlackBridge({
		appToken: "xapp-1",
		botToken: "xoxb-1",
		slack: { allowedUsers: ["U_TOM"], botUserId: "U_BOT" },
		onTrigger: (t) => triggers.push(t),
		fetchFn: makeFakeFetch(calls),
		createWebSocket: () => {
			const ws = new FakeWS();
			sockets.push(ws);
			return ws;
		},
		setTimer: (fn, ms) => {
			timers.push({ fn, ms });
			return 0 as unknown as ReturnType<typeof setTimeout>;
		},
	});
});

afterEach(() => bridge.stop());

describe("SlackBridge", () => {
	it("opens a socket and maps an allowed message to a trigger, acking the envelope", async () => {
		await bridge.connect();
		expect(calls[0]?.url).toContain("apps.connections.open");
		const ws = sockets[0] as FakeWS;
		ws.emit("open", {});
		ws.emit("message", { data: JSON.stringify({ type: "hello" }) });
		ws.emit("message", {
			data: JSON.stringify({
				type: "events_api",
				envelope_id: "e1",
				payload: { event: { type: "message", text: "ship it", user: "U_TOM", channel: "C1", ts: "1.1" } },
			}),
		});
		expect(triggers).toHaveLength(1);
		expect(triggers[0]?.text).toBe("ship it");
		expect(triggers[0]?.origin.channel).toBe("C1");
		expect(ws.sent).toContain(JSON.stringify({ envelope_id: "e1" }));
	});

	it("ignores a non-allowed user but still acks", async () => {
		await bridge.connect();
		const ws = sockets[0] as FakeWS;
		ws.emit("message", {
			data: JSON.stringify({
				type: "events_api",
				envelope_id: "e2",
				payload: { event: { type: "message", text: "hi", user: "U_RANDO", channel: "C1", ts: "1" } },
			}),
		});
		expect(triggers).toHaveLength(0);
		expect(ws.sent).toContain(JSON.stringify({ envelope_id: "e2" }));
	});

	it("posts a reply to the originating thread", async () => {
		await bridge.connect();
		const ok = await bridge.postReply({ kind: "slack", channel: "C1", threadTs: "1.1", user: "U_TOM" }, "done");
		expect(ok).toBe(true);
		const post = calls.find((c) => c.url.endsWith("chat.postMessage"));
		expect(post).toBeDefined();
		const body = JSON.parse(post?.init.body);
		expect(body).toMatchObject({ channel: "C1", text: "done", thread_ts: "1.1" });
	});

	it("reconnects after a disconnect envelope", async () => {
		await bridge.connect();
		const ws = sockets[0] as FakeWS;
		ws.emit("message", { data: JSON.stringify({ type: "disconnect" }) });
		expect(timers).toHaveLength(1);
		timers[0]?.fn(); // run the scheduled reconnect
		const opens = calls.filter((c) => c.url.endsWith("apps.connections.open"));
		expect(opens).toHaveLength(2);
	});
});
