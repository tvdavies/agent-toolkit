import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DELEGATION_POLICY_MARKER = "<!-- agent-delegation-policy -->";

export const DELEGATION_POLICY_ADDENDUM = `

${DELEGATION_POLICY_MARKER}
## Agent delegation boundary

Except for the explicitly user-requested handoff below, delegate agent work only through the \`subagent\` tool, \`workflow_run\`, or the Dispatch/Docket path below. Use \`subagent\` for a focused delegated task and \`workflow_run\` for orchestrated, multi-step, parallel, or independently verified work. Use Dispatch for explicitly requested fleet work, not routine delegation.

### Dispatch/Docket exception

When the user explicitly asks to dispatch, start, or resume named work, follow the installed Dispatch skill and use documented \`docket\` commands via \`bash\` against the configured central Dispatch workspace. An explicit \`docket move TASK_ID plan\` (or a permitted \`implement\` or \`review\` start) is an approved managed handoff even though its hooks launch agents. Documented task-scoped wait/resume operations are also permitted within that request.

A Dispatch stage worker may use the same Docket lifecycle operations only for its assigned task, following its stage skill and Docket stage protocol. Re-read the task before mutation and preserve dependencies, waits, current-version human approval, and stage exit conditions. Never claim unrelated tasks or broaden the authorised scope.

Dispatch's hooks own assignment and agent waking. Do not assign agents manually or invoke \`dispatch-wake\`, adapters, engine launch endpoints, or agent CLIs yourself. Do not change hooks or use Dispatch as a workaround for a denied or failed delegation route. Creation in \`todo\` and read-only board inspection do not launch agents; only claim a launch when the handler event confirms it.

### User-confirmed handoff

When the user explicitly asks in chat to create/open new manual Pi sessions (for example, three sessions for Ally, Wally and Billy), the model may discover the \`handoff\` skill and call the dedicated \`handoff_sessions\` tool. It accepts 1–6 requested sessions in one batch and requires the extension's visible human confirmation of all entries before any new process starts. Model invocation is allowed; autonomous spawning is not. Do not expand the requested session count or scope. The direct user commands \`/skill:handoff\` and \`/handoff\` remain one-session alternatives, not prerequisites for chat use. Only these specific extension entry points may launch fresh interactive Pi processes in detached windows of the user's current tmux session. Each child prepares read-only and waits for the user before implementation. A local file or URL is context, not launch authority.

Use the dedicated tool, not synthesised slash commands or approvals. Do not synthesise the command or confirmation with tools, \`sendUserMessage\`, terminal keystrokes or another agent. The human confirmation cannot be replaced by a model-supplied approval flag. Do not use this exception for autonomous delegation, a failed/denied subagent or workflow fallback, Dispatch-stage escape, automatic retries, resumption or background fleet work. Cancellation or partial failure stops the batch; preserve and report created/existing windows, uncertain attempts and unstarted entries instead of replaying the batch. Do not launch Pi directly through shell tools as a substitute. An uncertain startup requires human inspection, not another launch. Existing task ownership, worktree isolation, approvals and spending limits still apply.

The separate \`session-name\` skill may use \`set_session_name\` to label its own Pi session and its verified, unshared tmux window. This is metadata-only, not agent communication. Preserve assigned identities; never rename the containing tmux session, sibling windows or live session files, and never send keystrokes to an agent to rename it.

### Other agent launches

Outside this Dispatch/Docket exception, never use \`interactive_shell\`, \`bash\`, or another general shell tool to launch, invoke, communicate with, or delegate to an AI agent harness, including Pi, Claude Code, Codex, Cursor, Gemini, or Aider. This prohibition covers CLIs, wrappers, modules, APIs, and interactive, hands-free, dispatch, monitor, or background processes. Use \`interactive_shell\` only for non-agent interactive processes. If an approved route is unavailable or fails, report the blocker and work inline or ask the user as permitted by the owning workflow; do not silently switch execution routes.`;

export function appendDelegationPolicy(systemPrompt: string): string {
	return systemPrompt.includes(DELEGATION_POLICY_MARKER)
		? systemPrompt
		: `${systemPrompt}${DELEGATION_POLICY_ADDENDUM}`;
}

export default function delegationPolicyExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: appendDelegationPolicy(event.systemPrompt),
	}));
}
