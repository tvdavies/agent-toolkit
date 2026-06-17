/**
 * /btw — ask a quick side question without interrupting the main conversation.
 *
 * Inspired by Claude Code's `/btw`. The side question is answered by a separate,
 * self-contained model call that is given the current conversation as background
 * context. The question and answer are rendered inline "in the flow" so you keep
 * your place, but they are filtered out of the main agent's LLM context so they
 * never pollute or steer the primary task.
 *
 * How it works:
 *  1. `/btw <question>` reads the current branch and flattens it into context text.
 *  2. A one-shot `complete()` call answers the question using that context.
 *  3. The Q&A is injected as a `custom` message (rendered inline, persisted in the
 *     transcript) via `pi.sendMessage`.
 *  4. A `context` handler strips those `custom` messages before each LLM call, so
 *     `convertToLlm` never sees them — the main agent's context stays clean.
 *
 * Place at ~/.pi/agent/extensions/btw.ts (global) or .pi/extensions/btw.ts (project).
 * Hot-reloadable with /reload.
 */

import { complete, type Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

const BTW_TYPE = "btw";

/** Max characters of conversation context to feed the side agent (keeps it quick + cheap). */
const MAX_CONTEXT_CHARS = 24_000;

const SYSTEM_PROMPT = `You are a helpful side assistant answering a quick "by the way" question.

You are given the transcript of an ongoing conversation between a user and a coding agent as background context, followed by the user's side question. The side question is a tangent: it does NOT change the main task and your answer will NOT be added to the agent's working context.

Guidelines:
- Answer the side question directly and concisely.
- Use the conversation as background only when it's relevant to the question.
- If the question is unrelated to the conversation, just answer it on its own.
- Prefer a short, focused answer. Use markdown when it helps (lists, code).
- Do not propose changes to the main task or tell the agent what to do next.`;

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type BranchEntry = {
	type: string;
	message?: { role?: string; content?: unknown };
};

const extractText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
};

const extractToolCalls = (content: unknown): string[] => {
	if (!Array.isArray(content)) return [];
	const calls: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		calls.push(`[called tool: ${block.name}]`);
	}
	return calls;
};

/** Flatten the current branch into a readable transcript, skipping our own btw entries. */
const buildConversationText = (entries: BranchEntry[]): string => {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;

		const lines: string[] = [];
		const text = extractText(entry.message.content).trim();
		if (text) lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
		if (role === "assistant") lines.push(...extractToolCalls(entry.message.content));
		if (lines.length > 0) sections.push(lines.join("\n"));
	}

	let joined = sections.join("\n\n");
	if (joined.length > MAX_CONTEXT_CHARS) {
		// Keep the most recent context (the tail is usually most relevant).
		joined = `…(earlier conversation trimmed)…\n\n${joined.slice(-MAX_CONTEXT_CHARS)}`;
	}
	return joined;
};

const buildUserPrompt = (conversation: string, question: string): string => {
	if (!conversation.trim()) return question;
	return [
		"<conversation>",
		conversation,
		"</conversation>",
		"",
		"Side question (by the way):",
		question,
	].join("\n");
};

/** Run the one-shot side completion. Returns answer text, or null if cancelled. */
const askSide = async (
	ctx: ExtensionCommandContext,
	question: string,
	signal: AbortSignal,
): Promise<string | null> => {
	const model = ctx.model!;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key for ${model.provider}/${model.id}`);

	const conversation = buildConversationText(
		ctx.sessionManager.getBranch() as BranchEntry[],
	);

	const messages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: buildUserPrompt(conversation, question) }],
			timestamp: Date.now(),
		},
	];

	const response = await complete(
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages },
		{ apiKey: auth.apiKey, headers: auth.headers, signal },
	);

	if (response.stopReason === "aborted") return null;

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
};

export default function (pi: ExtensionAPI) {
	// Render the inline btw card: question header + markdown answer.
	pi.registerMessageRenderer<{ question?: string }>(
		BTW_TYPE,
		(message, { expanded }, theme) => {
			const question = message.details?.question ?? "";
			const answer =
				typeof message.content === "string"
					? message.content
					: extractText(message.content);

			const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
			box.addChild(
				new Text(theme.fg("accent", theme.bold("💬 btw")), 0, 0),
			);
			if (question) {
				box.addChild(new Text(theme.fg("muted", theme.italic(question)), 0, 0));
			}
			box.addChild(new Markdown(answer || "(no answer)", 0, 1, getMarkdownTheme()));
			if (!expanded) {
				box.addChild(
					new Text(theme.fg("dim", "side question · not shared with the agent"), 0, 0),
				);
			}
			return box;
		},
	);

	// Strip btw side Q&A from the main agent's LLM context before every model call.
	// transformContext runs before convertToLlm, so these never reach the provider.
	pi.on("context", async (event) => {
		const filtered = event.messages.filter(
			(m) => !((m as { role?: string }).role === "custom" &&
				(m as { customType?: string }).customType === BTW_TYPE),
		);
		if (filtered.length === event.messages.length) return;
		return { messages: filtered };
	});

	pi.registerCommand("btw", {
		description:
			"Ask a quick side question (answered with conversation context, kept out of the main thread)",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /btw <your side question>", "warning");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// Don't race the main agent — wait for it to be idle before reading context.
			await ctx.waitForIdle();

			let answer: string | null = null;
			let failure: string | undefined;

			if (ctx.hasUI) {
				answer = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(
						tui,
						theme,
						`Thinking about your side question (${ctx.model!.id})…`,
					);
					loader.onAbort = () => done(null);
					askSide(ctx, question, loader.signal)
						.then(done)
						.catch((err) => {
							failure = err instanceof Error ? err.message : String(err);
							done(null);
						});
					return loader;
				});
			} else {
				try {
					answer = await askSide(
						ctx,
						question,
						ctx.signal ?? new AbortController().signal,
					);
				} catch (err) {
					failure = err instanceof Error ? err.message : String(err);
				}
			}

			if (failure) {
				ctx.ui.notify(`btw failed: ${failure}`, "error");
				return;
			}
			if (answer === null) {
				ctx.ui.notify("btw cancelled", "info");
				return;
			}
			if (!answer) {
				ctx.ui.notify("btw: empty answer", "warning");
				return;
			}

			// Inject inline. While idle this renders immediately and persists in the
			// transcript; the `context` handler keeps it out of the agent's LLM context.
			pi.sendMessage({
				customType: BTW_TYPE,
				content: answer,
				display: true,
				details: { question },
			});
		},
	});
}
