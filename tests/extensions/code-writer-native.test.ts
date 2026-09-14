/**
 * Opt-in check against the installed native pi-subagents package's pure
 * candidate/scope/project-root functions. It launches no agents or models.
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
const INSPECTED_VERSION = "0.66.0";

describe.skipIf(!nativeRoot)("code-writer native pi-subagents contract (opt-in)", () => {
	let scratch: string;
	let previousExclusions: string | undefined;
	beforeAll(() => {
		scratch = mkdtempSync(join(tmpdir(), "code-writer-native-"));
		// Keep the native exclusion cache out of the real home for the duration of this suite only.
		previousExclusions = process.env.PI_MODEL_EXCLUSIONS_PATH;
		process.env.PI_MODEL_EXCLUSIONS_PATH = join(scratch, "exclusions.json");
	});
	afterAll(() => {
		if (previousExclusions === undefined) delete process.env.PI_MODEL_EXCLUSIONS_PATH;
		else process.env.PI_MODEL_EXCLUSIONS_PATH = previousExclusions;
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	it("targets the inspected native version", () => {
		const pkg = JSON.parse(readFileSync(join(nativeRoot!, "package.json"), "utf8"));
		expect(pkg.name).toBe("pi-subagents");
		if (pkg.version !== INSPECTED_VERSION) console.warn(`code-writer was inspected against pi-subagents ${INSPECTED_VERSION}; installed ${pkg.version}`);
	});

	it("feeds the serialised override into native buildModelCandidates in the requested order and inside both scopes", async () => {
		const fallback = await import(join(nativeRoot!, "src/runs/shared/model-fallback.ts"));
		const scope = await import(join(nativeRoot!, "src/runs/shared/model-scope.ts"));
		const hierarchy = parseHierarchy(["anthropic-claude-code/claude-fable-5-1", "openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna:low"]);
		const globalAllow = ["inherit", "anthropic-claude-code/claude-fable-5-1", "openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna"];
		const plan = planSettingsUpdate({ subagents: { modelScope: { enforce: true, strict: true, allow: globalAllow } } }, hierarchy, { anthropicProviderExtensionPath: "/toolkit/extensions/anthropic-claude-code.ts" });
		const modelScope = scope.parseModelScopeConfig((plan.settings.subagents as any).modelScope, { filePath: "settings.json" });
		const scopes = scope.resolveModelScopesForAgent(modelScope, "code-writer", { provider: "openai-codex", id: "gpt-6-astra" });
		expect(scopes.map((rule: { origin: string }) => rule.origin)).toEqual(["modelScope", "modelScope.agents.code-writer"]);
		const registry = ["anthropic-claude-code/claude-fable-5-1", "openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"].map((fullId) => {
			const [provider, id] = fullId.split("/") as [string, string];
			return { provider, id, fullId };
		});
		const candidates = fallback.buildModelCandidates(plan.override.model as string, plan.override.fallbackModels as string[], registry, undefined, { scope: scopes, origin: "configured" });
		expect(candidates).toEqual(["anthropic-claude-code/claude-fable-5-1", "openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna:low"]);
		expect(() => fallback.buildModelCandidates(plan.override.model as string, ["openai-codex/gpt-5.6-sol"], registry, undefined, { scope: scopes, origin: "configured" })).toThrow("outside the configured subagent model scope");
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
		const plan = planSettingsUpdate({}, parseHierarchy(["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna"]), { anthropicProviderExtensionPath: "/toolkit/extensions/anthropic-claude-code.ts" });
		const parsed = scope.parseModelScopeConfig((plan.settings.subagents as any).modelScope, meta);
		expect(parsed.agents["code-writer"]).toEqual({ enforce: true, strict: true, allow: ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna"] });
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

	it("documents that native fallback is limited to retryable failures before tool activity", async () => {
		const fallback = await import(join(nativeRoot!, "src/runs/shared/model-fallback.ts"));
		expect(fallback.isRetryableModelFailureAttempt({ error: "usage limit reached (429)", toolCount: 0, messages: [] })).toBe(true);
		expect(fallback.isRetryableModelFailureAttempt({ error: "usage limit reached (429)", toolCount: 1, messages: [] })).toBe(false);
		expect(fallback.isRetryableModelFailure("bun test failed (exit 1): 3 tests failed")).toBe(false);
	});
});
