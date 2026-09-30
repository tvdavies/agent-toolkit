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
		expect(result.systemPrompt).toContain("never use `interactive_shell`");
		expect(result.systemPrompt).toContain("`bash`");
		expect(result.systemPrompt).toContain("another general shell tool");
		for (const harness of ["Pi", "Claude Code", "Codex", "Cursor", "Gemini", "Aider"]) {
			expect(result.systemPrompt).toContain(harness);
		}
		expect(result.systemPrompt).toContain("CLIs, wrappers, modules, APIs");
		expect(result.systemPrompt).toContain("non-agent interactive processes");
		expect(result.systemPrompt).toContain("work inline or ask the user");
	});

	it("permits an explicit Dispatch handoff through the managed Docket path", () => {
		const prompt = appendDelegationPolicy("BASE");

		expect(prompt).toContain("### Dispatch/Docket exception");
		expect(prompt).toContain("user explicitly asks to dispatch, start, or resume named work");
		expect(prompt).toContain("installed Dispatch skill");
		expect(prompt).toContain("documented `docket` commands via `bash`");
		expect(prompt).toContain("configured central Dispatch workspace");
		expect(prompt).toContain("`docket move TASK_ID plan`");
		expect(prompt).toContain("`implement` or `review`");
		expect(prompt).toContain("even though its hooks launch agents");
		expect(prompt).not.toContain("Delegate agent work only through the `subagent` tool or `workflow_run`.");
	});

	it("preserves the assigned worker's task and approval boundaries", () => {
		expect(DELEGATION_POLICY_ADDENDUM).toContain("Dispatch stage worker");
		expect(DELEGATION_POLICY_ADDENDUM).toContain("only for its assigned task");
		expect(DELEGATION_POLICY_ADDENDUM).toContain("stage skill and Docket stage protocol");
		expect(DELEGATION_POLICY_ADDENDUM).toContain("dependencies, waits, current-version human approval, and stage exit conditions");
		expect(DELEGATION_POLICY_ADDENDUM).toContain("Never claim unrelated tasks");
	});

	it("does not turn the Dispatch exception into a general shell-launch or fallback permission", () => {
		expect(DELEGATION_POLICY_ADDENDUM).toContain("Outside this Dispatch/Docket exception, never use");
		expect(DELEGATION_POLICY_ADDENDUM).toContain("Do not assign agents manually or invoke `dispatch-wake`, adapters, engine launch endpoints, or agent CLIs yourself");
		expect(DELEGATION_POLICY_ADDENDUM).toContain("Do not change hooks or use Dispatch as a workaround for a denied or failed delegation route");
		expect(DELEGATION_POLICY_ADDENDUM).toContain("do not silently switch execution routes");
	});

	it("distinguishes holding tasks from verified launches", () => {
		expect(DELEGATION_POLICY_ADDENDUM).toContain("Creation in `todo` and read-only board inspection do not launch agents");
		expect(DELEGATION_POLICY_ADDENDUM).toContain("only claim a launch when the handler event confirms it");
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
