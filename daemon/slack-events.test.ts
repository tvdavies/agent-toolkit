import { describe, expect, it } from "bun:test";
import { mapSlackEvent, type SlackConfig } from "./slack-events";

const config: SlackConfig = { allowedUsers: ["U_TOM"], botUserId: "U_BOT" };

describe("mapSlackEvent", () => {
	it("maps an allowed user's message to a trigger with origin", () => {
		const r = mapSlackEvent(
			{ type: "message", text: "ship it", user: "U_TOM", channel: "C1", ts: "111.1" },
			config,
		);
		expect(r.kind).toBe("trigger");
		if (r.kind === "trigger") {
			expect(r.text).toBe("ship it");
			expect(r.origin).toEqual({ kind: "slack", channel: "C1", threadTs: "111.1", user: "U_TOM" });
		}
	});

	it("uses thread_ts when present", () => {
		const r = mapSlackEvent(
			{ type: "message", text: "hi", user: "U_TOM", channel: "C1", ts: "222.2", thread_ts: "111.1" },
			config,
		);
		if (r.kind === "trigger") expect(r.origin.threadTs).toBe("111.1");
	});

	it("strips the mention from app_mention", () => {
		const r = mapSlackEvent(
			{ type: "app_mention", text: "<@U_BOT> do the thing", user: "U_TOM", channel: "C1", ts: "1.1" },
			config,
		);
		if (r.kind === "trigger") expect(r.text).toBe("do the thing");
	});

	it("ignores non-allowed users, the bot, subtypes, and empties", () => {
		expect(mapSlackEvent({ type: "message", text: "x", user: "U_RANDO", channel: "C1", ts: "1" }, config).kind).toBe("ignore");
		expect(mapSlackEvent({ type: "message", text: "x", user: "U_BOT", channel: "C1", ts: "1" }, config).kind).toBe("ignore");
		expect(mapSlackEvent({ type: "message", text: "x", bot_id: "B1", channel: "C1", ts: "1" }, config).kind).toBe("ignore");
		expect(mapSlackEvent({ type: "message", subtype: "message_changed", user: "U_TOM", channel: "C1", ts: "1" }, config).kind).toBe("ignore");
		expect(mapSlackEvent({ type: "message", text: "  ", user: "U_TOM", channel: "C1", ts: "1" }, config).kind).toBe("ignore");
		expect(mapSlackEvent({ type: "reaction_added", user: "U_TOM" }, config).kind).toBe("ignore");
	});
});
