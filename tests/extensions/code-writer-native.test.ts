/**
 * Opt-in check against the installed native pi-subagents package's pure
 * discovery/scope/project-root functions. It launches no agents or models.
 * Enable with:
 *
 *   CODE_WRITER_NATIVE_ROOT=~/.pi/agent/npm/node_modules/pi-subagents bun test tests/extensions/code-writer-native.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseHierarchy } from "../../extensions/code-writer/hierarchy";
import { assertSupportedSubagentSettings, findConfiguredProjectRoot, planSettingsUpdate } from "../../extensions/code-writer/settings";

const configuredRoot = process.env.CODE_WRITER_NATIVE_ROOT?.replace(/^~(?=\/|$)/, homedir());
const nativeRoot = configuredRoot && existsSync(join(configuredRoot, "package.json")) ? configuredRoot : undefined;
const INSPECTED_VERSION = "0.68.0";

describe.skipIf(!nativeRoot)("code-writer native pi-subagents contract (opt-in)", () => {
	let scratch: string;
	let previousExclusions: string | undefined;
	let previousAgentDir: string | undefined;
	beforeAll(() => {
		scratch = mkdtempSync(join(tmpdir(), "code-writer-native-"));
		// Keep the native exclusion cache out of the real home for the duration of this suite only.
		previousExclusions = process.env.PI_MODEL_EXCLUSIONS_PATH;
		process.env.PI_MODEL_EXCLUSIONS_PATH = join(scratch, "exclusions.json");
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
		mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	});
	afterAll(() => {
		if (previousExclusions === undefined) delete process.env.PI_MODEL_EXCLUSIONS_PATH;
		else process.env.PI_MODEL_EXCLUSIONS_PATH = previousExclusions;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	it("targets the inspected native version", () => {
		const pkg = JSON.parse(readFileSync(join(nativeRoot!, "package.json"), "utf8"));
		expect(pkg.name).toBe("pi-subagents");
		if (pkg.version !== INSPECTED_VERSION) console.warn(`code-writer was inspected against pi-subagents ${INSPECTED_VERSION}; installed ${pkg.version}`);
	});

	it("loads the serialised single-model override natively and enforces both scopes", async () => {
		const agents = await import(join(nativeRoot!, "src/agents/agents.ts"));
		const scope = await import(join(nativeRoot!, "src/runs/shared/model-scope.ts"));
		const hierarchy = parseHierarchy(["anthropic-claude-code/claude-fable-5-1:medium"]);
		const globalAllow = ["inherit", "anthropic-claude-code/claude-fable-5-1", "openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna"];
		const plan = planSettingsUpdate({ subagents: { modelScope: { enforce: true, strict: true, allow: globalAllow } } }, hierarchy, { anthropicProviderExtensionPath: "/toolkit/extensions/anthropic-claude-code.ts" });
		const modelScope = scope.parseModelScopeConfig((plan.settings.subagents as any).modelScope, { filePath: "settings.json" });
		const scopes = scope.resolveModelScopesForAgent(modelScope, "code-writer", { provider: "openai-codex", id: "gpt-6-astra" });
		expect(scopes.map((rule: { origin: string }) => rule.origin)).toEqual(["modelScope", "modelScope.agents.code-writer"]);
		expect(Object.hasOwn(plan.override, "fallbackModels")).toBe(false);
		for (const rule of scopes) expect(scope.checkModelScope(plan.override.model, rule, "configured")).toBeUndefined();
		expect(scope.checkModelScope("openai-codex/gpt-6-astra", scopes[1], "configured")?.severity).toBe("error");
		const repo = join(scratch, "discovery");
		mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
		writeFileSync(join(repo, ".pi", "agents", "code-writer.md"), "---\nname: code-writer\ndescription: Synthetic writer\n---\nSynthetic test role.\n");
		writeFileSync(join(repo, ".pi", "settings.json"), JSON.stringify(plan.settings));
		const discovered = agents.discoverAgents(repo, "project");
		expect(discovered.agents.find((agent: { name: string }) => agent.name === "code-writer")).toMatchObject({ model: hierarchy.primary.model, thinking: "medium" });
	});

	it("resolves a global inherit pattern the same way native does", async () => {
		const scope = await import(join(nativeRoot!, "src/runs/shared/model-scope.ts"));
		const config = scope.parseModelScopeConfig({ enforce: true, strict: true, allow: ["inherit"] }, { filePath: "settings.json" });
		const resolved = scope.resolveModelScopesForAgent(config, "code-writer", { provider: "openai-codex", id: "gpt-5.6-sol" });
		expect(resolved[0].allow).toEqual(["openai-codex/gpt-5.6-sol"]);
		expect(scope.checkModelScope("openai-codex/gpt-5.6-sol", resolved[0], "inherited")).toBeUndefined();
		expect(scope.checkModelScope("openai-codex/gpt-6-astra", resolved[0], "inherited")?.severity).toBe("error");
	});

	it("rejects scope-key collisions that native's trimming parser would resolve by last-wins, and accepts the written rule", async () => {
		const scope = await import(join(nativeRoot!, "src/runs/shared/model-scope.ts"));
		const meta = { filePath: "settings.json" };
		// Native: padded duplicate silently replaces the canonical writer rule.
		const collision = { enforce: true, strict: true, allow: ["*"], agents: { "code-writer": { allow: ["openai-codex/gpt-6-astra"] }, " code-writer ": { allow: ["*"] } } };
		expect(scope.parseModelScopeConfig(collision, meta).agents["code-writer"].allow).toEqual(["*"]);
		expect(() => assertSupportedSubagentSettings({ subagents: { modelScope: collision } }, "settings.json")).toThrow("unique agent names after trimming");
		expect(() => assertSupportedSubagentSettings({ subagents: { modelScope: { allow: ["*"], agents: { " code-writer": { allow: ["*"] } } } } }, "settings.json")).toThrow("untrimmed 'code-writer' key");
		// The rule this feature writes parses natively to exactly the same allow-list.
		const plan = planSettingsUpdate({}, parseHierarchy(["openai-codex/gpt-6-astra"]), { anthropicProviderExtensionPath: "/toolkit/extensions/anthropic-claude-code.ts" });
		const parsed = scope.parseModelScopeConfig((plan.settings.subagents as any).modelScope, meta);
		expect(parsed.agents["code-writer"]).toEqual({ enforce: true, strict: true, allow: ["openai-codex/gpt-6-astra"] });
	});

	it("matches native findConfiguredProjectRoot on ancestor and git-root fixtures", async () => {
		const agents = await import(join(nativeRoot!, "src/agents/agents.ts"));
		const repo = join(scratch, "repo");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repo, ".pi"), { recursive: true });
		mkdirSync(join(repo, "nested", ".pi"), { recursive: true });
		const deep = join(repo, "nested", "deep");
		mkdirSync(deep);
		for (const policy of [undefined, "nearest", "git-root"]) {
			writeFileSync(join(repo, "nested", ".pi", "settings.json"), JSON.stringify(policy ? { subagents: { projectRootResolution: policy } } : {}));
			expect(findConfiguredProjectRoot(deep), String(policy)).toBe(agents.findConfiguredProjectRoot(deep));
		}
		writeFileSync(join(repo, "nested", ".pi", "settings.json"), "{}");
		writeFileSync(join(repo, ".pi", "settings.json"), JSON.stringify({ subagents: { projectRootResolution: "git-root" } }));
		expect(findConfiguredProjectRoot(deep)).toBe(agents.findConfiguredProjectRoot(deep));
		expect(findConfiguredProjectRoot(join(scratch, "nowhere"))).toBe(agents.findConfiguredProjectRoot(join(scratch, "nowhere")));
	});

	it("native discovery rejects even false and empty legacy fallbackModels", async () => {
		const agents = await import(join(nativeRoot!, "src/agents/agents.ts"));
		for (const [index, fallbackModels] of [false, [], ["openai-codex/gpt-5.6-luna"]].entries()) {
			const repo = join(scratch, `legacy-${index}`);
			mkdirSync(join(repo, ".pi"), { recursive: true });
			writeFileSync(join(repo, ".pi", "settings.json"), JSON.stringify({ subagents: { agentOverrides: { scout: { model: "openai-codex/gpt-5.6-luna", fallbackModels } } } }));
			expect(() => agents.discoverAgents(repo, "project")).toThrow("uses removed field 'fallbackModels'");
		}
	});
});
