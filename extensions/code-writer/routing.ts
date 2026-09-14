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

export const ROUTING_ADDENDUM = `

${ROUTING_MARKER}
## Code-writer routing (session preference)

The user enabled delegation-preferred mode with \`/code-writer on\`. This is a routing preference for you, not a sandbox: your own tools still work, so honour it deliberately.

- Route source and test edits to the \`code-writer\` subagent: \`subagent({ agent: "code-writer", task: "<coherent bounded task>", context: "fresh", async: true })\`. Write a complete task (working directory, allowed files, desired behaviour, constraints, acceptance criteria), not a list of prewritten edit calls. Do not pass a per-call \`model\`; the role's configured hierarchy owns model selection and quota fallback.
- Keep investigation, decisions, test execution, review and validation in this session. The writer has no shell and cannot run tests; treat its handoff as unverified until you check it.
- Never silently fall back to editing code yourself. If the writer is unavailable, fails, or the task is unsuitable, say so and ask the user before editing directly; tiny non-code edits explicitly requested by the user are the exception.
- Native fallback only rotates models on retryable provider/quota failures before the child uses any tool. After tool activity, a failed run keeps its partial work: report the run and worktree state, inspect and preserve the diff, then issue a new, explicit continuation task for the remaining work on a remaining approved model. Do not replay completed changes and do not resume a retained child expecting a different model.
- The user can opt out at any time with \`/code-writer off\` or by explicitly asking you to edit directly for a specific change.`;

export function appendRoutingPolicy(systemPrompt: string, preferred: boolean): string {
	if (!preferred || systemPrompt.includes(ROUTING_MARKER)) return systemPrompt;
	return `${systemPrompt}${ROUTING_ADDENDUM}`;
}
