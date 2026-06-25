/**
 * Park extension — lets a worker wait and resume itself.
 *
 * A `pi -p` worker exits at the end of its turn, so it cannot honour its own
 * in-process timer. Two tools record what to do, end the turn, and let the
 * daemon's worker pool resume the exact same session (`--continue`) with full
 * context:
 *  - `park({ prompt, seconds })` — wait for an external change (CI, a review),
 *    resumed by the dueAt timer.
 *  - `needs_human({ question })` — the worker is blocked on a human decision: the
 *    pool PUSHES the question (escalation) and parks the session until a person
 *    answers (dashboard / Slack / `toolkit-trigger --answer`), then resumes it
 *    with the answer injected. A long safety timer backstops a no-answer case.
 *
 * Loaded into workers via -e (workers run --no-extensions). Outside a worker
 * session it is inert.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { stateDir } from "../extensions/lib/decisions.ts";
import { clampParkSeconds, writeParkRequest } from "../extensions/lib/park.ts";

/** How long a needs_human park waits for an answer before the safety timer wakes it. */
const NEEDS_HUMAN_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const parkSchema = Type.Object({
	prompt: Type.String({
		description:
			"What to do when resumed — runs as your next message with full prior context (e.g. 'Re-check PR #4988: pull new CodeRabbit threads and CI status; address anything new; if still pending, park again.').",
	}),
	seconds: Type.Optional(Type.Number({ description: "How long to wait before resuming (clamped 30–3600). Default 180." })),
	minutes: Type.Optional(Type.Number({ description: "Convenience: minutes to wait (added to seconds)." })),
	reason: Type.Optional(Type.String({ description: "Short note on what you are waiting for." })),
});
type ParkInput = Static<typeof parkSchema>;

export default function parkExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "park",
		label: "park (wait + resume)",
		description:
			"Wait for an external change (CI, a code review, a deploy) and resume THIS session later with full context. Use to poll without holding the process open. After calling park, STOP — end your turn immediately; you will be resumed automatically at the due time with the prompt you provide. Only works inside a worker session.",
		promptSnippet: "Wait, then resume this session",
		parameters: parkSchema,
		async execute(_id, params: ParkInput) {
			const result = (text: string, details: Record<string, unknown>) => ({
				content: [{ type: "text" as const, text }],
				details,
			});
			const runId = process.env.AGENT_TOOLKIT_WORKER_RUN_ID;
			if (!runId) {
				return result("park is only available inside a worker session.", { ok: false });
			}
			const delay = clampParkSeconds((params.minutes ?? 0) * 60 + (params.seconds ?? 0) || 0);
			const dueAt = Date.now() + delay * 1000;
			writeParkRequest(stateDir(), { runId, dueAt, prompt: params.prompt, reason: params.reason });
			return result(
				`Parked for ${delay}s (resume at ${new Date(dueAt).toISOString()}). End your turn now — you will be resumed automatically with full context and your prompt.`,
				{ ok: true, dueAt, delay },
			);
		},
	});

	const needsHumanSchema = Type.Object({
		question: Type.String({
			description:
				"The specific decision or information you need from the human, with enough context to answer it (e.g. 'PR #4988: the reviewer asks whether to keep the legacy /v1 endpoint or drop it — the ticket is ambiguous. Keep or drop?').",
		}),
	});
	type NeedsHumanInput = Static<typeof needsHumanSchema>;

	pi.registerTool({
		name: "needs_human",
		label: "needs human (block + ask)",
		description:
			"You are blocked on something only a human can decide (a judgement call, missing access, an ambiguous requirement). State the question clearly; it is pushed to the user immediately and THIS session is parked until they answer, then resumed with their answer in context. After calling needs_human, STOP — end your turn. Use this instead of guessing on a consequential decision. Only works inside a worker session.",
		promptSnippet: "Block and ask the human a question",
		parameters: needsHumanSchema,
		async execute(_id, params: NeedsHumanInput) {
			const result = (text: string, details: Record<string, unknown>) => ({
				content: [{ type: "text" as const, text }],
				details,
			});
			const runId = process.env.AGENT_TOOLKIT_WORKER_RUN_ID;
			if (!runId) {
				return result("needs_human is only available inside a worker session.", { ok: false });
			}
			const dueAt = Date.now() + NEEDS_HUMAN_TIMEOUT_MS;
			writeParkRequest(stateDir(), {
				runId,
				dueAt,
				awaitingAnswer: true,
				question: params.question,
				reason: "awaiting human answer",
				// Used only if the safety timer fires with no answer.
				prompt:
					"No human answer arrived within the wait window. Re-assess: if it is now safe to proceed with your best judgement, do so; otherwise call needs_human again with a sharper question, or stop and report what is still blocking.",
			});
			return result(
				"Question pushed to the human; this session is parked until they answer. End your turn now — you will be resumed with their answer.",
				{ ok: true, awaitingAnswer: true },
			);
		},
	});
}
