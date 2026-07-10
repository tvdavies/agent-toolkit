import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DELEGATION_POLICY_MARKER = "<!-- agent-delegation-policy -->";

export const DELEGATION_POLICY_ADDENDUM = `

${DELEGATION_POLICY_MARKER}
## Agent delegation boundary

Delegate agent work only through the \`subagent\` tool or \`workflow_run\`. Use \`subagent\` for a focused delegated task and \`workflow_run\` for orchestrated, multi-step, parallel, or independently verified work.

Never use \`interactive_shell\`, \`bash\`, or another general shell tool to launch, invoke, communicate with, or delegate to an AI agent harness, including Pi, Claude Code, Codex, Cursor, Gemini, or Aider. This prohibition covers CLIs, wrappers, modules, APIs, and interactive, hands-free, dispatch, monitor, or background processes. Use \`interactive_shell\` only for non-agent interactive processes. If neither approved delegation tool can satisfy the task, work inline or ask the user instead of bypassing this boundary.`;

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
