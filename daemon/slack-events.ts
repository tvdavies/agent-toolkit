/**
 * Slack event → trigger mapping (pure).
 *
 * Shared by the Socket Mode bridge and the /slack/events webhook. Applies the
 * allowlist (the security boundary, since the agent runs --yolo), ignores the
 * bot's own and non-substantive messages, and produces a trigger carrying the
 * Slack origin so a reply can be routed back to the thread.
 */

export type SlackConfig = {
	/** Slack user ids allowed to talk to the agent. */
	allowedUsers: string[];
	/** The bot's own user id, to ignore its messages. */
	botUserId?: string;
};

export type SlackOrigin = {
	kind: "slack";
	channel: string;
	threadTs?: string;
	user: string;
};

export type MappedSlackEvent =
	| { kind: "trigger"; text: string; origin: SlackOrigin }
	| { kind: "ignore"; reason: string };

type SlackEvent = {
	type?: string;
	subtype?: string;
	text?: string;
	user?: string;
	channel?: string;
	ts?: string;
	thread_ts?: string;
	bot_id?: string;
};

/** Strip a leading `<@BOTID>` mention from app_mention text. */
function stripMention(text: string): string {
	return text.replace(/^\s*<@[^>]+>\s*/, "").trim();
}

/** Map a Slack event payload to a trigger or an ignore reason. */
export function mapSlackEvent(event: SlackEvent, config: SlackConfig): MappedSlackEvent {
	if (event.type !== "message" && event.type !== "app_mention") {
		return { kind: "ignore", reason: `unsupported type: ${event.type}` };
	}
	if (event.subtype) return { kind: "ignore", reason: `subtype: ${event.subtype}` };
	if (event.bot_id) return { kind: "ignore", reason: "bot message" };
	if (!event.user) return { kind: "ignore", reason: "no user" };
	if (config.botUserId && event.user === config.botUserId) {
		return { kind: "ignore", reason: "own message" };
	}
	if (!config.allowedUsers.includes(event.user)) {
		return { kind: "ignore", reason: "user not allowed" };
	}
	const text = (event.type === "app_mention" ? stripMention(event.text ?? "") : event.text ?? "").trim();
	if (text === "") return { kind: "ignore", reason: "empty text" };
	if (!event.channel) return { kind: "ignore", reason: "no channel" };

	return {
		kind: "trigger",
		text,
		origin: {
			kind: "slack",
			channel: event.channel,
			threadTs: event.thread_ts ?? event.ts,
			user: event.user,
		},
	};
}
