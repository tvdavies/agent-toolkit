/**
 * Session-scoped "delegation-preferred" routing mode. This is prompt policy
 * for the parent model, not a sandbox: it never blocks or removes tools.
 */

export const ROUTING_ENTRY = "toolkit.code-writer/routing-v1";
export const ROUTING_MARKER = "<!-- code-writer-routing -->";

export type RoutingState = { preferred: boolean; changedAt: number };

/** Where an active routing preference comes from: an explicit session decision or the inherited user default. */
export type RoutingSource = "session" | "default";

/**
 * Effective routing for the active branch. An explicit session entry always
 * wins (true or false); only a branch without one inherits the stored user
 * default, and an inherited default that cannot activate is reported with a
 * reason and treated as off. The default is never materialised as an entry.
 */
export interface RoutingResolution {
	/** Last valid explicit decision on the active branch, if any. */
	session?: RoutingState;
	/** Stored user default as read (false when absent or unreadable). */
	storedDefault: boolean;
	/** Why an enabled stored default cannot take effect here, or why it could not be read. */
	defaultProblem?: string;
	preferred: boolean;
	source: RoutingSource | "none";
}

export function resolveRouting(session: RoutingState | undefined, storedDefault: boolean, defaultProblem?: string): RoutingResolution {
	if (session) return { session, storedDefault, defaultProblem, preferred: session.preferred, source: "session" };
	if (storedDefault && !defaultProblem) return { storedDefault, preferred: true, source: "default" };
	return { storedDefault, defaultProblem, preferred: false, source: "none" };
}

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

/** Truthful opening sentence for each source; the rest of the addendum is identical. */
export const ROUTING_OPENING: Record<RoutingSource, string> = {
	session: "The user enabled delegation-preferred mode for this session with `/code-writer on`.",
	default: "Delegation-preferred mode is inherited from the user's stored default (`/code-writer default on`); no explicit `/code-writer on` or `off` choice has been made on this session branch.",
};

/** Shared policy text following the source-specific opening. */
const ROUTING_ADDENDUM_BODY = `
What stays in this session: product and architecture decisions, coordination, command and test execution, and final acceptance. Delegate enough reading to avoid duplicating work; do not impose a scout-plan-write-review ceremony on every change.

- Bounded reading (callers, coverage, a named review question) may go to \`${ROUTING_ROLES.evidence[0]}\` or \`${ROUTING_ROLES.evidence[1]}\`. They return evidence only, never approval or a decision.
- \`${ROUTING_ROLES.mechanical}\` is ONLY for mechanical edits: settled behaviour, an explicit file scope, an existing pattern to propagate exactly, and cheap verification. Examples: renames, exact-pattern propagation, fixture or import updates, a straightforward test the task fully specifies. If you are unsure whether work is mechanical, it is not; send it to the writer.
- Substantive implementation and tests, and any coding task needing judgement beyond that mechanical gate, go to the \`${ROUTING_ROLES.writer}\` subagent: \`subagent({ agent: "${ROUTING_ROLES.writer}", task: "<coherent bounded task>", context: "fresh", async: true })\`. Write a complete task (working directory, allowed files, desired behaviour, constraints, acceptance criteria), not a list of prewritten edit calls. Do not pass a per-call \`model\`; the role's configured hierarchy owns model selection and quota fallback. The same applies to every role above: fresh context, no per-call model pin.
- Independent review via \`${ROUTING_ROLES.reviewer}\` is for consequential changes when it is useful or required, not an obligatory stage for every patch. Its findings inform your acceptance; they do not replace it.
- One writer per checkout: never run two editing roles in the same worktree at once.
- Choose roles from the agents actually available in this session. If a named role is unavailable, unsuitable, or fails, report that and ask the user; never substitute a cheaper worker for writer work. Never silently fall back to editing code yourself; tiny non-code edits explicitly requested by the user are the exception.
- None of these roles has a shell or runs tests; treat every handoff as unverified until you check it.
- Native fallback only rotates models on retryable provider/quota failures before the child uses any tool. After tool activity, a failed run keeps its partial work: report the run and worktree state, inspect and preserve the diff, then issue a new, explicit continuation task for the remaining work on a remaining approved model. Do not replay completed changes and do not resume a retained child expecting a different model.
- The user can opt out at any time with \`/code-writer off\` (a session choice that also overrides an inherited default) or by explicitly asking you to edit directly for a specific change.`;

export function routingAddendum(source: RoutingSource): string {
	return `

${ROUTING_MARKER}
## Code-writer routing (${source === "session" ? "session preference" : "inherited default preference"})

${ROUTING_OPENING[source]} This is a routing preference for you, not a sandbox or an enforced complexity classifier: your own tools still work, so honour it deliberately and describe your routing choice honestly.
${ROUTING_ADDENDUM_BODY}`;
}

/** The addendum as appended for an explicit session decision. */
export const ROUTING_ADDENDUM = routingAddendum("session");

export function appendRoutingPolicy(systemPrompt: string, preferred: boolean, source: RoutingSource = "session"): string {
	if (!preferred || systemPrompt.includes(ROUTING_MARKER)) return systemPrompt;
	return `${systemPrompt}${routingAddendum(source)}`;
}
