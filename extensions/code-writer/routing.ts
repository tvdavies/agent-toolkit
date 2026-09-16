/**
 * Session-scoped "delegation-preferred" routing mode. This is prompt policy
 * for the parent model, not a sandbox: it never blocks or removes tools.
 */

export const ROUTING_ENTRY = "toolkit.code-writer/routing-v1";
export const ROUTING_MARKER = "<!-- code-writer-routing -->";

export type RoutingState = { preferred: boolean; changedAt: number };

/**
 * Restore the last persisted routing decision from the entries of the active
 * branch only. Callers must pass `sessionManager.getBranch()`, not
 * `getEntries()`: the latter includes every tree branch, so a decision taken
 * on an abandoned branch would otherwise leak into the current one.
 */
export function readRoutingState(branch: readonly { type: string; customType?: string; data?: unknown }[]): RoutingState | undefined {
	let state: RoutingState | undefined;
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== ROUTING_ENTRY || typeof entry.data !== "object" || entry.data === null) continue;
		const data = entry.data as Record<string, unknown>;
		if (typeof data.preferred !== "boolean" || typeof data.changedAt !== "number" || !Number.isFinite(data.changedAt)) continue;
		state = { preferred: data.preferred, changedAt: data.changedAt };
	}
	return state;
}

/** Roles the addendum names besides the writer; each must exist in the current session's agent list before it is used. */
export const ROUTING_ROLES = {
	writer: "code-writer",
	mechanical: "routine-worker",
	evidence: ["review-evidence", "scout"],
	reviewer: "reviewer",
} as const;

export const ROUTING_ADDENDUM = `

${ROUTING_MARKER}
## Code-writer routing (session preference)

The user enabled delegation-preferred mode with \`/code-writer on\`. This is a routing preference for you, not a sandbox or an enforced complexity classifier: your own tools still work, so honour it deliberately and describe your routing choice honestly.

What stays in this session: product and architecture decisions, coordination, command and test execution, and final acceptance. Delegate enough reading to avoid duplicating work; do not impose a scout-plan-write-review ceremony on every change.

- Bounded reading (callers, coverage, a named review question) may go to \`${ROUTING_ROLES.evidence[0]}\` or \`${ROUTING_ROLES.evidence[1]}\`. They return evidence only, never approval or a decision.
- \`${ROUTING_ROLES.mechanical}\` is ONLY for mechanical edits: settled behaviour, an explicit file scope, an existing pattern to propagate exactly, and cheap verification. Examples: renames, exact-pattern propagation, fixture or import updates, a straightforward test the task fully specifies. If you are unsure whether work is mechanical, it is not; send it to the writer.
- Substantive implementation and tests, and any coding task needing judgement beyond that mechanical gate, go to the \`${ROUTING_ROLES.writer}\` subagent: \`subagent({ agent: "${ROUTING_ROLES.writer}", task: "<coherent bounded task>", context: "fresh", async: true })\`. Write a complete task (working directory, allowed files, desired behaviour, constraints, acceptance criteria), not a list of prewritten edit calls. Do not pass a per-call \`model\`; the role's configured hierarchy owns model selection and quota fallback. The same applies to every role above: fresh context, no per-call model pin.
- Independent review via \`${ROUTING_ROLES.reviewer}\` is for consequential changes when it is useful or required, not an obligatory stage for every patch. Its findings inform your acceptance; they do not replace it.
- One writer per checkout: never run two editing roles in the same worktree at once.
- Choose roles from the agents actually available in this session. If a named role is unavailable, unsuitable, or fails, report that and ask the user; never substitute a cheaper worker for writer work. Never silently fall back to editing code yourself; tiny non-code edits explicitly requested by the user are the exception.
- None of these roles has a shell or runs tests; treat every handoff as unverified until you check it.
- Native fallback only rotates models on retryable provider/quota failures before the child uses any tool. After tool activity, a failed run keeps its partial work: report the run and worktree state, inspect and preserve the diff, then issue a new, explicit continuation task for the remaining work on a remaining approved model. Do not replay completed changes and do not resume a retained child expecting a different model.
- The user can opt out at any time with \`/code-writer off\` or by explicitly asking you to edit directly for a specific change.`;

export function appendRoutingPolicy(systemPrompt: string, preferred: boolean): string {
	if (!preferred || systemPrompt.includes(ROUTING_MARKER)) return systemPrompt;
	return `${systemPrompt}${ROUTING_ADDENDUM}`;
}
