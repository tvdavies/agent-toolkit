import { describe, expect, it } from "bun:test";
import delegationPolicyExtension, {
	appendDelegationPolicy,
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

	it("does not duplicate the policy when another hook already injected it", () => {
		const once = appendDelegationPolicy("BASE");
		const twice = appendDelegationPolicy(once);

		expect(twice).toBe(once);
		expect(twice.split(DELEGATION_POLICY_MARKER)).toHaveLength(2);
	});
});
