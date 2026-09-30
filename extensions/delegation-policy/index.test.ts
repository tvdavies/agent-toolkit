import { describe, expect, it } from "bun:test";
import delegationPolicyExtension, {
	appendDelegationPolicy,
	DELEGATION_POLICY_ADDENDUM,
	DELEGATION_POLICY_MARKER,
} from "./index";

function fakePi() {
	const hooks: Record<string, (event: { prompt?: string; systemPrompt: string }) => unknown> = {};
	const api = {
		on(event: string, handler: (event: { prompt?: string; systemPrompt: string }) => unknown) {
			hooks[event] = handler;
		},
	};
	return { api: api as never, hooks };
}

describe("delegation policy extension", () => {
	it("injects the delegation boundary on every turn", () => {
		const pi = fakePi();
		delegationPolicyExtension(pi.api);
		const hook = pi.hooks.before_agent_start;
		if (!hook) throw new Error("before_agent_start hook not registered");

		const result = hook({ prompt: "", systemPrompt: "BASE" }) as { systemPrompt: string };

		expect(result.systemPrompt).toContain("BASE");
		expect(result.systemPrompt).toContain(DELEGATION_POLICY_MARKER);
		expect(result.systemPrompt).toContain("`subagent`");
		expect(result.systemPrompt).toContain("`workflow_run`");
		expect(result.systemPrompt).toContain("Never use `interactive_shell`");
		expect(result.systemPrompt).toContain("`bash`");
		expect(result.systemPrompt).toContain("another general shell tool");
		for (const harness of ["Pi", "Claude Code", "Codex", "Cursor", "Gemini", "Aider"]) {
			expect(result.systemPrompt).toContain(harness);
		}
		expect(result.systemPrompt).toContain("CLIs, wrappers, modules, APIs");
		expect(result.systemPrompt).toContain("non-agent interactive processes");
		expect(result.systemPrompt).toContain("work inline or ask the user");
	});

	it("approves only the native subagent and workflow routes", () => {
		const prompt = appendDelegationPolicy("BASE");

		expect(prompt).toContain("Delegate agent work only through the `subagent` tool or `workflow_run`.");
		expect(prompt).toContain("### No agent launches through shell");
		expect(prompt).not.toMatch(/Dispatch|Docket|docket/);
		expect(prompt).not.toContain("exception");
	});

	it("does not treat a failed route as permission to launch agents through shell", () => {
		expect(DELEGATION_POLICY_ADDENDUM).toContain("Never use `interactive_shell`, `bash`, or another general shell tool");
		expect(DELEGATION_POLICY_ADDENDUM).toContain("do not silently switch execution routes");
	});

	it("offers no session naming or manual session-launch route", () => {
		const prompt = appendDelegationPolicy("BASE");
		expect(prompt).not.toContain("### Session naming");
		expect(prompt).not.toContain("set_session_name");
		expect(prompt).not.toContain("handoff_sessions");
		expect(prompt).not.toContain("User-confirmed handoff");
		expect(prompt).not.toContain("/skill:handoff");
	});

	it("does not duplicate the policy when another hook already injected it", () => {
		const once = appendDelegationPolicy("BASE");
		const twice = appendDelegationPolicy(once);

		expect(twice).toBe(once);
		expect(twice.split(DELEGATION_POLICY_MARKER)).toHaveLength(2);
	});
});
