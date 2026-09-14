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

	it("allows explicitly requested chat batches through the confirmed tool, not autonomous launches or fallbacks", () => {
		const prompt = appendDelegationPolicy("BASE");
		expect(prompt).toContain("### User-confirmed handoff");
		expect(prompt).toContain("user explicitly asks in chat");
		expect(prompt).toContain("`handoff_sessions`");
		expect(prompt).toContain("visible human confirmation");
		expect(prompt).toContain("1–6 requested sessions in one batch");
		expect(prompt).toContain("Model invocation is allowed; autonomous spawning is not");
		expect(prompt).toContain("not prerequisites for chat use");
		expect(prompt).toContain("cannot be replaced by a model-supplied approval flag");
		expect(prompt).toContain("Do not expand the requested session count or scope");
		expect(prompt).toContain("Cancellation or partial failure stops the batch");
		expect(prompt).toContain("prepares read-only and waits");
		expect(prompt).toContain("A local file or URL is context, not launch authority");
		expect(prompt).toContain("Do not synthesise the command or confirmation");
		expect(prompt).toContain("failed/denied subagent or workflow fallback");
		expect(prompt).toContain("Do not launch Pi directly through shell tools");
		expect(prompt).toContain("uncertain startup requires human inspection");
		expect(prompt).toContain("metadata-only, not agent communication");
		expect(prompt).toContain("never rename the containing tmux session");
	});

	it("does not duplicate the policy when another hook already injected it", () => {
		const once = appendDelegationPolicy("BASE");
		const twice = appendDelegationPolicy(once);

		expect(twice).toBe(once);
		expect(twice.split(DELEGATION_POLICY_MARKER)).toHaveLength(2);
	});
});
