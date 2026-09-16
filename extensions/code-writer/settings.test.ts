import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHierarchy } from "./hierarchy";
import {
	acquireSettingsLock, assertActivatable, assertSupportedSubagentSettings, findConfiguredProjectRoot, globalScopeViolations, LOCK_STALE_MS,
	MAX_SETTINGS_BYTES, planRoutingDefault, planSettingsUpdate, projectConflicts, projectSettingsPath, readRoutingDefault, readSettingsFile,
	readStoredWriterConfig, requiredProviderExtensions, ROUTING_DEFAULT_SETTING, settingsLockPath, updateSettingsFile,
} from "./settings";

const ANTHROPIC = "/toolkit/extensions/anthropic-claude-code.ts";
const EXAMPLE = parseHierarchy(["anthropic-claude-code/claude-fable-5-1"]);
const opts = (extra: Record<string, unknown> = {}) => ({ anthropicProviderExtensionPath: ANTHROPIC, ...extra });

/** Mirrors the shape of a realistic global settings file without any secrets. */
function existingSettings() {
	return {
		theme: "dark",
		defaultProvider: "openai-codex",
		defaultModel: "gpt-6-astra",
		packages: ["npm:pi-subagents"],
		subagents: {
			agentOverrides: {
				"routine-worker": { model: "openai-codex/gpt-5.6-luna", thinking: "medium", extensions: [], fast: false },
				worker: { model: "inherit", thinking: "high" },
			},
			modelScope: {
				enforce: true,
				strict: true,
				allow: ["inherit", "anthropic-claude-code/claude-fable-5-1", "anthropic-claude-code/claude-fable-5", "openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna"],
				agents: { "routine-worker": { allow: ["openai-codex/gpt-5.6-luna"] } },
			},
		},
		worktrees: { copyFiles: [".env"] },
	};
}

function writerScope(settings: Record<string, any>) {
	return settings.subagents.modelScope.agents["code-writer"];
}

describe("code-writer settings plan", () => {
	it("serialises the native override and strict per-agent scope while preserving unrelated config", () => {
		const current = existingSettings();
		const plan = planSettingsUpdate(current, EXAMPLE, opts());
		const subagents = plan.settings.subagents as Record<string, any>;
		expect(subagents.agentOverrides["code-writer"]).toEqual({
			model: "anthropic-claude-code/claude-fable-5-1",
			defaultContext: "fresh",
			fast: false,
			extensions: [ANTHROPIC],
		});
		expect(subagents.modelScope.agents["code-writer"]).toEqual({ enforce: true, strict: true, allow: ["anthropic-claude-code/claude-fable-5-1"] });
		expect(subagents.modelScope.allow).toEqual(current.subagents.modelScope.allow);
		expect(subagents.modelScope.enforce).toBe(true);
		expect(subagents.modelScope.agents["routine-worker"]).toEqual({ allow: ["openai-codex/gpt-5.6-luna"] });
		expect(subagents.agentOverrides["routine-worker"]).toEqual(current.subagents.agentOverrides["routine-worker"]);
		expect(subagents.agentOverrides.worker).toEqual({ model: "inherit", thinking: "high" });
		expect(plan.settings.theme).toBe("dark");
		expect(plan.settings.worktrees).toEqual({ copyFiles: [".env"] });
		expect(plan.warnings).toEqual([]);
	});

	it("replaces the selected model and owned scope without changing unrelated roles", () => {
		const first = planSettingsUpdate(existingSettings(), EXAMPLE, opts()).settings;
		const second = planSettingsUpdate(first, parseHierarchy(["openai-codex/gpt-6-astra"]), opts()).settings;
		expect((second.subagents as any).agentOverrides["code-writer"]).toEqual({ model: "openai-codex/gpt-6-astra", defaultContext: "fresh", fast: false, extensions: [] });
		expect(writerScope(second)).toEqual({ enforce: true, strict: true, allow: ["openai-codex/gpt-6-astra"] });
		expect((second.subagents as any).modelScope.allow).toEqual(existingSettings().subagents.modelScope.allow);
		expect((second.subagents as any).agentOverrides["routine-worker"]).toEqual(existingSettings().subagents.agentOverrides["routine-worker"]);
	});

	it("refuses multi-model plans and removes legacy fallback fields during explicit reconfiguration", () => {
		const current = existingSettings() as any;
		const before = JSON.stringify(current);
		expect(() => planSettingsUpdate(current, parseHierarchy(["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna"]), opts())).toThrow("supports one model per agent");
		expect(JSON.stringify(current)).toBe(before);
		for (const fallbackModels of [false, [], ["openai-codex/gpt-5.6-luna"]]) {
			current.subagents.agentOverrides["code-writer"] = { model: "openai-codex/gpt-6-astra", fallbackModels };
			const plan = planSettingsUpdate(current, EXAMPLE, opts());
			expect(Object.hasOwn(plan.override, "fallbackModels")).toBe(false);
			expect(current.subagents.agentOverrides["code-writer"].fallbackModels).toEqual(fallbackModels);
		}
	});

	it("writes a primary thinking level as the native thinking field and clears stale fields on reconfiguration", () => {
		const current = existingSettings() as any;
		current.subagents.agentOverrides["code-writer"] = { model: "openai-codex/gpt-5.6-sol", thinking: "high", fallbackModels: ["openai-codex/gpt-5.6-luna"], disabled: true, description: "kept" };
		const plan = planSettingsUpdate(current, parseHierarchy(["openai-codex/gpt-6-astra:medium"]), opts());
		expect(plan.override).toEqual({ description: "kept", model: "openai-codex/gpt-6-astra", thinking: "medium", defaultContext: "fresh", fast: false, extensions: [] });
	});

	it("creates only the required shape when no settings exist", () => {
		const plan = planSettingsUpdate({}, parseHierarchy(["openai-codex/gpt-6-astra"]), opts());
		expect(Object.keys(plan.settings)).toEqual(["subagents"]);
		expect(plan.settings.subagents).toEqual({
			agentOverrides: { "code-writer": { model: "openai-codex/gpt-6-astra", defaultContext: "fresh", fast: false, extensions: [] } },
			modelScope: { agents: { "code-writer": { enforce: true, strict: true, allow: ["openai-codex/gpt-6-astra"] } } },
		});
	});

	it("refuses to widen an enforced global allow-list and never warns about global enforce for the agent rule", () => {
		const hierarchy = parseHierarchy(["openai/gpt-5-mini"]);
		const parent = { parentModel: { provider: "openai-codex", id: "gpt-6-astra" } };
		expect(() => planSettingsUpdate(existingSettings(), hierarchy, opts(parent))).toThrow(/widening the existing global subagents.modelScope: openai\/gpt-5-mini is outside user modelScope.allow/);
		expect(() => planSettingsUpdate(existingSettings(), hierarchy, opts())).toThrow("no parent session model is available");
		const unenforced = existingSettings() as any;
		unenforced.subagents.modelScope.enforce = false;
		const plan = planSettingsUpdate(unenforced, hierarchy, opts());
		// Agent enforce:true is effective independently of the global flag, so nothing to warn about.
		expect(plan.warnings).toEqual([]);
		expect(writerScope(plan.settings)).toEqual({ enforce: true, strict: true, allow: ["openai/gpt-5-mini"] });
	});

	it("resolves a global inherit pattern to the parent model and refuses only when identity is unavailable", () => {
		const scope = { enforce: true, strict: true, allow: ["inherit", "openai-codex/gpt-5.6-luna"] };
		const hierarchy = parseHierarchy(["openai-codex/gpt-6-astra"]);
		expect(globalScopeViolations(hierarchy, scope, "user", { provider: "openai-codex", id: "gpt-6-astra" })).toEqual([]);
		expect(globalScopeViolations(hierarchy, scope, "user", { provider: "openai-codex", id: "gpt-5.6-sol" })).toEqual(["openai-codex/gpt-6-astra is outside user modelScope.allow (allow: inherit, openai-codex/gpt-5.6-luna)"]);
		expect(globalScopeViolations(hierarchy, scope, "user", undefined)).toEqual(["openai-codex/gpt-6-astra matches only via 'inherit' in user modelScope.allow, but no parent session model is available to resolve it"]);
		const plan = planSettingsUpdate({ subagents: { modelScope: scope } }, hierarchy, opts({ parentModel: { provider: "openai-codex", id: "gpt-6-astra" } }));
		// The allow-list keeps the literal inherit pattern; only the check resolved it.
		expect((plan.settings.subagents as any).modelScope.allow).toEqual(["inherit", "openai-codex/gpt-5.6-luna"]);
	});

	it("rejects models missing from the active registry without writing", () => {
		expect(() => planSettingsUpdate(existingSettings(), EXAMPLE, opts({ registryModels: ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna"] }))).toThrow("Not in this session's model registry: anthropic-claude-code/claude-fable-5-1");
	});

	it("refuses provider-scoped writer overrides in user or project settings with exact keys", () => {
		const user = existingSettings() as any;
		user.subagents.agentOverridesByProvider = { "openai-codex": { "code-writer": { fallbackModels: false }, worker: { model: "openai-codex/gpt-5.6-luna" } }, anthropic: { "code-writer": { extensions: [] } } };
		expect(() => planSettingsUpdate(user, EXAMPLE, opts())).toThrow("user subagents.agentOverridesByProvider.openai-codex.code-writer.fallbackModels, user subagents.agentOverridesByProvider.anthropic.code-writer.extensions");
		expect(() => planSettingsUpdate(existingSettings(), EXAMPLE, opts({ projectSettings: { subagents: { agentOverridesByProvider: { "openai-codex": { "code-writer": { model: "openai-codex/gpt-5.6-luna" } } } } } }))).toThrow("project subagents.agentOverridesByProvider.openai-codex.code-writer.model");
		// Provider maps for other agents are fine.
		const harmless = existingSettings() as any;
		harmless.subagents.agentOverridesByProvider = { "openai-codex": { worker: { model: "openai-codex/gpt-5.6-luna" } } };
		expect(planSettingsUpdate(harmless, EXAMPLE, opts()).settings.subagents).toMatchObject({ agentOverridesByProvider: harmless.subagents.agentOverridesByProvider });
	});

	it("fails on project overrides and on a replacing project scope unless it carries an equivalent strict writer rule", () => {
		expect(() => planSettingsUpdate(existingSettings(), EXAMPLE, opts({ projectSettings: { subagents: { agentOverrides: { "code-writer": { model: "openai-codex/gpt-5.6-luna" } } } } }))).toThrow("project subagents.agentOverrides.code-writer.model");
		expect(() => planSettingsUpdate(existingSettings(), EXAMPLE, opts({ projectSettings: { subagents: { modelScope: { enforce: true, allow: ["openai-codex/*"] } } } }))).toThrow("Project modelScope replaces the user scope and rejects the hierarchy");
		// Replacing permissive scope: the new strict writer rule would be inert -> refuse with instructions.
		const wide = { subagents: { modelScope: { enforce: true, allow: ["*"] } } };
		expect(() => planSettingsUpdate(existingSettings(), EXAMPLE, opts({ projectSettings: wide }))).toThrow(/would be ineffective\. Add to the project settings by hand: "subagents": \{ "modelScope": \{ "agents": \{ "code-writer": \{ "enforce": true, "strict": true, "allow": \["anthropic-claude-code\/claude-fable-5-1"\]/);
		expect(projectConflicts(EXAMPLE, wide).errors.join(" ")).toContain("Project files are never edited automatically");
		// Equivalent enforced strict writer rule (order-insensitive, inherits strict from global) is accepted with a warning.
		const equivalent = { subagents: { modelScope: { enforce: true, strict: true, allow: ["*"], agents: { "code-writer": { allow: ["anthropic-claude-code/claude-fable-5-1"] } } } } };
		const plan = planSettingsUpdate(existingSettings(), EXAMPLE, opts({ projectSettings: equivalent }));
		expect(plan.warnings.join(" ")).toContain("existing strict code-writer rule matches this hierarchy");
		// Not strict, or a superset, is not equivalent.
		const loose = { subagents: { modelScope: { enforce: true, allow: ["*"], agents: { "code-writer": { allow: ["anthropic-claude-code/claude-fable-5-1"] } } } } };
		expect(() => planSettingsUpdate(existingSettings(), EXAMPLE, opts({ projectSettings: loose }))).toThrow("would be ineffective");
		const superset = { subagents: { modelScope: { enforce: true, strict: true, allow: ["*"], agents: { "code-writer": { allow: ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-6-astra", "anthropic-claude-code/claude-fable-5-1", "openai-codex/gpt-5.6-sol"] } } } } };
		expect(() => planSettingsUpdate(existingSettings(), EXAMPLE, opts({ projectSettings: superset }))).toThrow("would be ineffective");
	});

	it("includes the owned Anthropic provider only and refuses unknown custom providers", () => {
		expect(requiredProviderExtensions(parseHierarchy(["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna"]), ANTHROPIC)).toEqual([]);
		expect(requiredProviderExtensions(parseHierarchy(["openai-codex/gpt-6-astra", "anthropic-claude-code/claude-fable-5", "anthropic-claude-code/claude-fable-5-1"]), ANTHROPIC)).toEqual([ANTHROPIC]);
		expect(() => requiredProviderExtensions(parseHierarchy(["openai-codex/gpt-6-astra", "baseten/model-a"]), ANTHROPIC)).toThrow("Provider 'baseten' is not a built-in Pi provider");
	});

	it("rejects unsupported relevant native schema in user and project settings rather than repairing it", () => {
		const cases: Array<[unknown, string]> = [
			[{ subagents: [] }, "'subagents'"],
			[{ subagents: { agentOverrides: "x" } }, "'subagents.agentOverrides'"],
			[{ subagents: { agentOverrides: { scout: 1 } } }, "'subagents.agentOverrides.scout'"],
			[{ subagents: { agentOverrides: { "code-writer": { fallbackModels: "x" } } } }, "'subagents.agentOverrides.code-writer.fallbackModels'"],
			[{ subagents: { agentOverrides: { "code-writer": { fast: "yes" } } } }, "'subagents.agentOverrides.code-writer.fast'"],
			[{ subagents: { agentOverrides: { "code-writer": { defaultContext: "later" } } } }, "'subagents.agentOverrides.code-writer.defaultContext'"],
			[{ subagents: { agentOverridesByProvider: [] } }, "'subagents.agentOverridesByProvider'"],
			[{ subagents: { agentOverridesByProvider: { openai: "x" } } }, "'subagents.agentOverridesByProvider.openai'"],
			[{ subagents: { agentOverridesByProvider: { openai: { "code-writer": { thinking: 3 } } } } }, "'subagents.agentOverridesByProvider.openai.code-writer.thinking'"],
			[{ subagents: { modelScope: { allow: "inherit" } } }, "'subagents.modelScope.allow'"],
			[{ subagents: { modelScope: { allow: [] } } }, "'subagents.modelScope.allow'"],
			[{ subagents: { modelScope: { allow: ["a/b"], enforce: "true" } } }, "'subagents.modelScope.enforce'"],
			[{ subagents: { modelScope: { allow: ["a/b"], strict: 1 } } }, "'subagents.modelScope.strict'"],
			[{ subagents: { modelScope: { enforce: true } } }, "non-empty 'allow' list when enforce is true"],
			[{ subagents: { modelScope: { agents: [] } } }, "'subagents.modelScope.agents'"],
			[{ subagents: { modelScope: { agents: { scout: { allow: [1] } } } } }, "'subagents.modelScope.agents.scout.allow'"],
			[{ subagents: { modelScope: { agents: { scout: { enforce: "no" } } } } }, "'subagents.modelScope.agents.scout.enforce'"],
			[{ subagents: { modelScope: { agents: { scout: { agents: {} } } } } }, "'subagents.modelScope.agents.scout.agents'"],
			[{ subagents: { projectRootResolution: "auto" } }, "'subagents.projectRootResolution'"],
			// Native trims scope keys; duplicates after trimming and padded writer keys are ambiguous.
			[{ subagents: { modelScope: { agents: { "code-writer": { allow: ["a/b"] }, " code-writer ": { allow: ["*"] } } } } }, "unique agent names after trimming"],
			[{ subagents: { modelScope: { agents: { " scout": { allow: ["a/b"] }, "scout ": { allow: ["*"] } } } } }, "later 'scout' rule would win"],
			[{ subagents: { modelScope: { agents: { " code-writer": { allow: ["*"] } } } } }, "an untrimmed 'code-writer' key"],
		];
		for (const [settings, fragment] of cases) {
			expect(() => planSettingsUpdate(settings, EXAMPLE, opts()), JSON.stringify(settings)).toThrow(fragment);
			expect(() => planSettingsUpdate(existingSettings(), EXAMPLE, opts({ projectSettings: settings })), `project ${JSON.stringify(settings)}`).toThrow(fragment);
		}
		expect(() => assertSupportedSubagentSettings({ subagents: { modelScope: { agents: { "": {} } } } }, "f")).toThrow("non-empty agent names");
		// Padded keys for other agents are native-legal and left alone.
		expect(() => planSettingsUpdate({ subagents: { modelScope: { agents: { " scout ": { allow: ["a/b"] } } } } }, EXAMPLE, opts())).not.toThrow();
		// Unrelated fields with odd values are left alone.
		expect(() => planSettingsUpdate({ subagents: { waitTool: 5, agentOverrides: { scout: { tools: 7 } } } }, EXAMPLE, opts())).not.toThrow();
	});

	it("validates preserved writer-specific fields against the native override parser's accepted types in every layer", () => {
		const invalid: Array<[Record<string, unknown>, string]> = [
			[{ tools: 7 }, "tools"], [{ tools: "all" }, "tools"], [{ tools: [1] }, "tools"],
			[{ inheritProjectContext: "yes" }, "inheritProjectContext"], [{ inheritGlobalContext: 1 }, "inheritGlobalContext"], [{ inheritSkills: "no" }, "inheritSkills"],
			[{ allowNestedSubagents: "true" }, "allowNestedSubagents"], [{ completionGuard: 0 }, "completionGuard"],
			[{ skills: "review" }, "skills"], [{ defaultReads: {} }, "defaultReads"], [{ excludeTools: true }, "excludeTools"],
			[{ subagentOnlyExtensions: "x" }, "subagentOnlyExtensions"], [{ mutationTools: 5 }, "mutationTools"],
			[{ description: "" }, "description"], [{ output: "" }, "output"], [{ outputMode: "stream" }, "outputMode"],
			[{ systemPromptMode: "prepend" }, "systemPromptMode"], [{ systemPrompt: 1 }, "systemPrompt"],
			[{ acceptanceRole: "reviewer" }, "acceptanceRole"], [{ toolBudget: 3 }, "toolBudget"],
		];
		for (const [fields, field] of invalid) {
			const user = existingSettings() as any;
			user.subagents.agentOverrides["code-writer"] = { model: "openai-codex/gpt-6-astra", ...fields };
			expect(() => planSettingsUpdate(user, EXAMPLE, opts()), JSON.stringify(fields)).toThrow(`'subagents.agentOverrides.code-writer.${field}'`);
			expect(() => planSettingsUpdate(existingSettings(), EXAMPLE, opts({ projectSettings: { subagents: { agentOverrides: { "code-writer": fields } } } })), `project ${JSON.stringify(fields)}`).toThrow(`'subagents.agentOverrides.code-writer.${field}'`);
			const provider = existingSettings() as any;
			provider.subagents.agentOverridesByProvider = { "openai-codex": { "code-writer": fields } };
			expect(() => planSettingsUpdate(provider, EXAMPLE, opts()), `provider ${JSON.stringify(fields)}`).toThrow(`'subagents.agentOverridesByProvider.openai-codex.code-writer.${field}'`);
		}
		// Native-accepted values, including false-clearing and tools "inherit", are preserved untouched.
		const accepted = { tools: "inherit", excludeTools: false, skills: ["review"], defaultReads: [], inheritProjectContext: false, inheritGlobalContext: true, inheritSkills: false, allowNestedSubagents: false, completionGuard: true, description: "writer", output: false, outputMode: "file-only", systemPromptMode: "append", systemPrompt: "", acceptanceRole: "writer", toolBudget: { maxCalls: 5 }, subagentOnlyExtensions: false, mutationTools: ["edit"] };
		const user = existingSettings() as any;
		user.subagents.agentOverrides["code-writer"] = { model: "openai-codex/gpt-6-astra", ...accepted };
		const plan = planSettingsUpdate(user, EXAMPLE, opts());
		expect((plan.settings.subagents as any).agentOverrides["code-writer"]).toMatchObject(accepted);
		const toolsFalse = existingSettings() as any;
		toolsFalse.subagents.agentOverrides["code-writer"] = { tools: false };
		expect((planSettingsUpdate(toolsFalse, EXAMPLE, opts()).settings.subagents as any).agentOverrides["code-writer"].tools).toBe(false);
		// Other agents' overrides are not validated (native reports them itself).
		expect(() => planSettingsUpdate({ subagents: { agentOverrides: { worker: { inheritProjectContext: "yes" } } } }, EXAMPLE, opts())).not.toThrow();
	});

	it("reports the stored configuration for status", () => {
		const plan = planSettingsUpdate(existingSettings(), EXAMPLE, opts());
		expect(readStoredWriterConfig(plan.settings)).toEqual({
			model: "anthropic-claude-code/claude-fable-5-1",
			extensions: [ANTHROPIC],
			agentAllow: ["anthropic-claude-code/claude-fable-5-1"],
			agentEnforce: true,
			agentStrict: true,
			globalAllow: existingSettings().subagents.modelScope.allow,
			globalEnforce: true,
			globalStrict: true,
			providerOverrideKeys: [],
		});
		expect(readStoredWriterConfig({})).toEqual({ providerOverrideKeys: [] });
		expect(readStoredWriterConfig({ subagents: { agentOverrides: { "code-writer": { model: "a/b", extensions: false } }, agentOverridesByProvider: { p: { "code-writer": { model: "x/y" } } } } })).toMatchObject({ extensions: false, providerOverrideKeys: ["user subagents.agentOverridesByProvider.p.code-writer.model"] });
	});
});

describe("code-writer routing default setting", () => {
	it("reads absent as false and only accepts a boolean flag inside an object namespace", () => {
		expect(ROUTING_DEFAULT_SETTING).toBe("codeWriter.routingDefault");
		expect(readRoutingDefault({})).toBe(false);
		expect(readRoutingDefault(existingSettings())).toBe(false);
		expect(readRoutingDefault({ codeWriter: {} })).toBe(false);
		expect(readRoutingDefault({ codeWriter: { other: 1 } })).toBe(false);
		expect(readRoutingDefault({ codeWriter: { routingDefault: false } })).toBe(false);
		expect(readRoutingDefault({ codeWriter: { routingDefault: true } })).toBe(true);
		expect(() => readRoutingDefault({ codeWriter: { routingDefault: "true" } })).toThrow("'codeWriter.routingDefault' value; expected a boolean");
		expect(() => readRoutingDefault({ codeWriter: { routingDefault: 1 } })).toThrow("expected a boolean");
		expect(() => readRoutingDefault({ codeWriter: { routingDefault: null } })).toThrow("expected a boolean");
		expect(() => readRoutingDefault({ codeWriter: true })).toThrow("'codeWriter' value; expected an object");
		expect(() => readRoutingDefault({ codeWriter: [] })).toThrow("expected an object");
		expect(() => readRoutingDefault([])).toThrow("must contain a JSON object");
		expect(() => readRoutingDefault(null)).toThrow("must contain a JSON object");
		expect(() => readRoutingDefault({ codeWriter: 1 })).toThrow("user settings.json has an unsupported 'codeWriter'");
	});

	it("plans only the owned flag, preserving unknown siblings and everything else, without validating the writer configuration", () => {
		const current = { ...existingSettings(), codeWriter: { experimental: { keep: true } } };
		const frozen = JSON.parse(JSON.stringify(current));
		const plan = planRoutingDefault(current, true);
		expect(plan).toEqual({ settings: { ...frozen, codeWriter: { experimental: { keep: true }, routingDefault: true } }, enabled: true, previous: false });
		expect(current).toEqual(frozen); // input untouched
		expect(plan.settings.subagents).toEqual(frozen.subagents);
		expect(planRoutingDefault({}, false)).toEqual({ settings: { codeWriter: { routingDefault: false } }, enabled: false, previous: false });
		expect(planRoutingDefault({ codeWriter: { routingDefault: true } }, false)).toEqual({ settings: { codeWriter: { routingDefault: false } }, enabled: false, previous: true });
		// Broken writer configuration is irrelevant to the plan (default off must remain possible).
		const broken = { subagents: { modelScope: { enforce: "yes" } }, codeWriter: { routingDefault: true } };
		expect(planRoutingDefault(broken, false).settings).toEqual({ subagents: { modelScope: { enforce: "yes" } }, codeWriter: { routingDefault: false } });
		// Unsupported namespace/flag shapes are refused rather than overwritten.
		expect(() => planRoutingDefault({ codeWriter: "on" }, true)).toThrow("expected an object");
		expect(() => planRoutingDefault({ codeWriter: { routingDefault: "true" } }, false)).toThrow("expected a boolean");
		expect(() => planRoutingDefault([], true)).toThrow("must contain a JSON object");
	});

	it("writes through the locked transaction, keeping indentation and unrelated concurrent edits", () => {
		const home = realpathSync(mkdtempSync(join(tmpdir(), "code-writer-default-")));
		try {
			const path = join(home, "settings.json");
			writeFileSync(path, `${JSON.stringify(existingSettings(), null, "\t")}\n`);
			const result = updateSettingsFile(path, (file) => planRoutingDefault(file.parsed, true));
			const written = readFileSync(path, "utf8");
			expect(written.startsWith("{\n\t\"theme\": \"dark\"")).toBe(true);
			expect(JSON.parse(written)).toEqual({ ...existingSettings(), codeWriter: { routingDefault: true } });
			expect(result.plan.previous).toBe(false);
			expect(readRoutingDefault(JSON.parse(written))).toBe(true);
			expect(readdirSync(home)).toEqual(["settings.json"]);
			mkdirSync(settingsLockPath(path));
			expect(() => updateSettingsFile(path, (file) => planRoutingDefault(file.parsed, false))).toThrow("locked by another Pi process");
			expect(readFileSync(path, "utf8")).toBe(written);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("code-writer activation check", () => {
	const PARENT = { provider: "openai-codex", id: "gpt-6-astra" };
	const stored = () => planSettingsUpdate(existingSettings(), EXAMPLE, opts()).settings as any;
	const check = (userSettings: unknown, projectSettings?: Record<string, unknown>) => assertActivatable({ userSettings, projectSettings, anthropicProviderExtensionPath: ANTHROPIC, parentModel: PARENT });

	it("accepts exactly what the models command wrote and reads the hierarchy back in order", () => {
		const result = check(stored());
		expect(result.hierarchy).toEqual(EXAMPLE);
		expect(result.warnings).toEqual([]);
	});

	it("refuses current configuration that native would not launch on the stored hierarchy, without planning a repair", () => {
		const mutate = (edit: (s: any) => void) => { const s = stored(); edit(s); return s; };
		expect(() => check({})).toThrow("No code-writer hierarchy is configured");
		expect(() => check(mutate((s) => { s.subagents.agentOverrides["code-writer"].disabled = true; }))).toThrow("disabled");
		for (const legacy of [false, [], ["openai-codex/gpt-6-astra"]]) {
			expect(() => check(mutate((s) => { s.subagents.agentOverrides["code-writer"].fallbackModels = legacy; }))).toThrow("removed field fallbackModels");
		}
		expect(() => check(mutate((s) => { s.subagents.agentOverrides["code-writer"].model = "gpt-6-astra"; }))).toThrow("not usable as written");
		expect(() => check(mutate((s) => { s.subagents.agentOverrides["code-writer"].extensions = []; }))).toThrow("lacks the provider extension");
		expect(() => check(mutate((s) => { s.subagents.agentOverrides["code-writer"].extensions = false; }))).toThrow("extensions to false");
		expect(() => check(mutate((s) => { delete s.subagents.agentOverrides["code-writer"].extensions; }))).toThrow("lacks the provider extension");
		expect(() => check(mutate((s) => { s.subagents.agentOverridesByProvider = { anthropic: { "code-writer": { model: "x/y" } } }; }))).toThrow("user subagents.agentOverridesByProvider.anthropic.code-writer.model");
		expect(() => check(mutate((s) => { s.subagents.modelScope.allow = ["openai-codex/*"]; }))).toThrow("outside the global scope");
		expect(() => check(mutate((s) => { delete s.subagents.modelScope.agents["code-writer"]; }))).toThrow("rule is missing, not enforced strict");
		expect(() => check(mutate((s) => { s.subagents.modelScope.agents["code-writer"].strict = false; }))).toThrow("rule is missing, not enforced strict");
		expect(() => check(mutate((s) => { s.subagents.modelScope.agents["code-writer"].allow.push("openai-codex/gpt-5.6-sol"); }))).toThrow("does not match the stored hierarchy");
		expect(() => check(mutate((s) => { s.subagents.modelScope.agents[" code-writer "] = { allow: ["*"] }; }))).toThrow("unique agent names after trimming");
		expect(() => check(mutate((s) => { s.subagents.agentOverrides["code-writer"].tools = 7; }))).toThrow("'subagents.agentOverrides.code-writer.tools'");
		// Every refusal names routing as unchanged.
		expect(() => check({})).toThrow("Routing is unchanged");
	});

	it("applies effective project settings the way configuration does", () => {
		expect(() => check(stored(), { subagents: { agentOverrides: { "code-writer": { model: "openai-codex/gpt-5.6-luna" } } } })).toThrow("project subagents.agentOverrides.code-writer.model");
		expect(() => check(stored(), { subagents: { agentOverridesByProvider: { "openai-codex": { "code-writer": { thinking: "low" } } } } })).toThrow("project subagents.agentOverridesByProvider.openai-codex.code-writer.thinking");
		expect(() => check(stored(), { subagents: { modelScope: { enforce: true, allow: ["*"] } } })).toThrow("would be ineffective");
		expect(() => check(stored(), { subagents: { projectRootResolution: "auto" } })).toThrow("'subagents.projectRootResolution'");
		const equivalent = { subagents: { modelScope: { enforce: true, strict: true, allow: ["*"], agents: { "code-writer": { allow: ["anthropic-claude-code/claude-fable-5-1"] } } } } };
		// With a replacing project scope, the user writer rule is irrelevant; the project rule decides.
		const s = stored();
		delete s.subagents.modelScope.agents["code-writer"];
		expect(check(s, equivalent).warnings.join(" ")).toContain("existing strict code-writer rule matches");
	});

	it("resolves a global inherit pattern with the parent model and refuses without one", () => {
		const s = stored();
		s.subagents.modelScope.allow = ["inherit"];
		expect(assertActivatable({ userSettings: s, anthropicProviderExtensionPath: ANTHROPIC, parentModel: { provider: "anthropic-claude-code", id: "claude-fable-5-1" } }).hierarchy).toEqual(EXAMPLE);
		expect(() => assertActivatable({ userSettings: s, anthropicProviderExtensionPath: ANTHROPIC })).toThrow("no parent session model is available");
	});
});

describe("code-writer native project root resolution", () => {
	let root: string;
	beforeEach(() => { root = mkdtempSync(join(tmpdir(), "code-writer-root-")); });
	afterEach(() => { rmSync(root, { recursive: true, force: true }); });

	it("finds the nearest ancestor .pi or .agents candidate", () => {
		mkdirSync(join(root, "repo", ".pi"), { recursive: true });
		mkdirSync(join(root, "repo", "packages", "app", "src"), { recursive: true });
		expect(findConfiguredProjectRoot(join(root, "repo", "packages", "app", "src"))).toBe(join(root, "repo"));
		expect(projectSettingsPath(join(root, "repo", "packages", "app"))).toBe(join(root, "repo", ".pi", "settings.json"));
		mkdirSync(join(root, "repo", "packages", "app", ".agents"));
		expect(findConfiguredProjectRoot(join(root, "repo", "packages", "app", "src"))).toBe(join(root, "repo", "packages", "app"));
		expect(findConfiguredProjectRoot(join(root, "elsewhere"))).toBeNull();
		expect(projectSettingsPath(root)).toBeNull();
	});

	it("honours git-root policy from a candidate and nearest policy from the nearest", () => {
		mkdirSync(join(root, "repo", ".git"), { recursive: true });
		mkdirSync(join(root, "repo", ".pi"));
		mkdirSync(join(root, "repo", "nested", ".pi"), { recursive: true });
		mkdirSync(join(root, "repo", "nested", "deep"));
		const nested = join(root, "repo", "nested", "deep");
		expect(findConfiguredProjectRoot(nested)).toBe(join(root, "repo", "nested"));
		writeFileSync(join(root, "repo", "nested", ".pi", "settings.json"), JSON.stringify({ subagents: { projectRootResolution: "git-root" } }));
		expect(findConfiguredProjectRoot(nested)).toBe(join(root, "repo"));
		writeFileSync(join(root, "repo", "nested", ".pi", "settings.json"), JSON.stringify({ subagents: { projectRootResolution: "nearest" } }));
		expect(findConfiguredProjectRoot(nested)).toBe(join(root, "repo", "nested"));
		// Policy declared on an ancestor still wins when the nearest is silent.
		writeFileSync(join(root, "repo", "nested", ".pi", "settings.json"), "{}");
		writeFileSync(join(root, "repo", ".pi", "settings.json"), JSON.stringify({ subagents: { projectRootResolution: "git-root" } }));
		expect(findConfiguredProjectRoot(nested)).toBe(join(root, "repo"));
		// git-root without any matching .git falls back to the nearest candidate.
		rmSync(join(root, "repo", ".git"), { recursive: true });
		expect(findConfiguredProjectRoot(nested)).toBe(join(root, "repo", "nested"));
	});

	it("fails closed on unsupported policy or malformed candidate settings", () => {
		mkdirSync(join(root, "repo", ".pi"), { recursive: true });
		writeFileSync(join(root, "repo", ".pi", "settings.json"), JSON.stringify({ subagents: { projectRootResolution: "auto" } }));
		expect(() => findConfiguredProjectRoot(join(root, "repo"))).toThrow("unsupported 'subagents.projectRootResolution'");
		writeFileSync(join(root, "repo", ".pi", "settings.json"), "{ nope");
		expect(() => projectSettingsPath(join(root, "repo"))).toThrow("not valid JSON");
	});
});

describe("code-writer settings transaction", () => {
	let home: string;
	beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), "code-writer-settings-"))); });
	afterEach(() => { rmSync(home, { recursive: true, force: true }); });
	const plan = (hierarchy = EXAMPLE) => (file: { parsed: unknown }) => planSettingsUpdate(file.parsed, hierarchy, opts());
	const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));

	it("creates a missing file atomically with only the required shape and no leftovers", () => {
		const path = join(home, ".pi", "agent", "settings.json");
		const result = updateSettingsFile(path, plan(parseHierarchy(["openai-codex/gpt-6-astra"])));
		expect(result.written).toBe(path);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(result.plan.settings);
		expect(leftovers(join(home, ".pi", "agent"))).toEqual([]);
	});

	it("leaves malformed bytes unchanged", () => {
		const path = join(home, "settings.json");
		for (const raw of ["{ not json\n", "[]\n", '{"subagents":{"modelScope":{"enforce":"yes","allow":["a/b"]}}}\n']) {
			writeFileSync(path, raw);
			expect(() => updateSettingsFile(path, plan())).toThrow();
			expect(readFileSync(path, "utf8")).toBe(raw);
			expect(leftovers(home)).toEqual([]);
		}
	});

	it("preserves indentation and unrelated keys", () => {
		const path = join(home, "settings.json");
		writeFileSync(path, `${JSON.stringify(existingSettings(), null, "\t")}\n`);
		const result = updateSettingsFile(path, plan());
		const written = readFileSync(path, "utf8");
		expect(written.startsWith("{\n\t\"theme\": \"dark\"")).toBe(true);
		expect(JSON.parse(written)).toEqual(result.plan.settings);
	});

	it("plans against the content read under the lock, so a concurrent change is not clobbered", () => {
		const path = join(home, "settings.json");
		writeFileSync(path, "{}\n");
		// Stale preview computed before the transaction must not be what gets written.
		const stale = planSettingsUpdate(readSettingsFile(path).parsed, EXAMPLE, opts());
		writeFileSync(path, '{"theme":"light"}\n');
		const result = updateSettingsFile(path, (file) => {
			expect(file.raw).toBe('{"theme":"light"}\n');
			return planSettingsUpdate(file.parsed, EXAMPLE, opts());
		});
		expect(result.plan.settings.theme).toBe("light");
		expect(stale.settings.theme).toBeUndefined();
		expect(JSON.parse(readFileSync(path, "utf8")).theme).toBe("light");
	});

	it("refuses any pre-existing lock, fresh or stale, and never removes it", () => {
		const path = join(home, "settings.json");
		writeFileSync(path, "{}\n");
		mkdirSync(settingsLockPath(path));
		expect(() => updateSettingsFile(path, plan())).toThrow("locked by another Pi process");
		expect(readFileSync(path, "utf8")).toBe("{}\n");
		expect(existsSync(settingsLockPath(path))).toBe(true);
		const old = new Date(Date.now() - 60_000);
		utimesSync(settingsLockPath(path), old, old);
		expect(() => updateSettingsFile(path, plan())).toThrow("locked by another Pi process");
		expect(existsSync(settingsLockPath(path))).toBe(true); // stale locks are the human's to remove
		expect(readFileSync(path, "utf8")).toBe("{}\n");
		expect(leftovers(home)).toEqual(["settings.json.lock"]);
	});

	it("does not commit or release when its lock was replaced by another owner", () => {
		const path = join(home, "settings.json");
		const lock = settingsLockPath(path);
		writeFileSync(path, "{}\n");
		const takeover = () => {
			// Simulates a successor treating our lock as stale: it removes it and creates its own with a different identity.
			rmdirSync(lock);
			mkdirSync(lock);
			const later = new Date(Date.now() + 5_000);
			utimesSync(lock, later, later);
		};
		expect(() => updateSettingsFile(path, (file) => { takeover(); return plan()(file); })).toThrow("was replaced or removed by another process");
		expect(readFileSync(path, "utf8")).toBe("{}\n");
		expect(existsSync(lock)).toBe(true); // the successor's lock is preserved
		expect(readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		rmdirSync(lock);
		// Lock removed with no successor: also refused, nothing recreated.
		expect(() => updateSettingsFile(path, (file) => { rmdirSync(lock); return plan()(file); })).toThrow("was replaced or removed by another process");
		expect(existsSync(lock)).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("{}\n");
	});

	it("does not commit once its own lock has passed the stale threshold, but still releases it", () => {
		const path = join(home, "settings.json");
		writeFileSync(path, "{}\n");
		let clock = 1_000_000;
		expect(() => updateSettingsFile(path, (file) => { clock += LOCK_STALE_MS; return plan()(file); }, { now: () => clock })).toThrow("passed its stale threshold");
		expect(readFileSync(path, "utf8")).toBe("{}\n");
		expect(leftovers(home)).toEqual([]);
		clock = 0;
		updateSettingsFile(path, (file) => { clock += LOCK_STALE_MS - 1; return plan()(file); }, { now: () => clock });
		expect(JSON.parse(readFileSync(path, "utf8")).subagents).toBeDefined();
		expect(leftovers(home)).toEqual([]);
	});

	it("exposes ownership checks on the lock handle", () => {
		const path = join(home, "settings.json");
		const handle = acquireSettingsLock(path);
		handle.assertOwned();
		rmdirSync(settingsLockPath(path));
		mkdirSync(settingsLockPath(path));
		const later = new Date(Date.now() + 5_000);
		utimesSync(settingsLockPath(path), later, later);
		expect(() => handle.assertOwned()).toThrow("replaced or removed");
		handle.release();
		expect(existsSync(settingsLockPath(path))).toBe(true);
		rmdirSync(settingsLockPath(path));
	});

	it("refuses when the file was replaced, modified, or created while the command ran", () => {
		const path = join(home, "settings.json");
		writeFileSync(path, "{}\n");
		// In-place modification with the same size: bytes differ.
		expect(() => updateSettingsFile(path, (file) => { writeFileSync(path, "[]\n"); return plan()(file); })).toThrow("replaced or modified");
		expect(readFileSync(path, "utf8")).toBe("[]\n");
		writeFileSync(path, "{}\n");
		// Inode replacement with identical bytes.
		expect(() => updateSettingsFile(path, (file) => { rmSync(path); writeFileSync(path, "{}\n"); return plan()(file); })).toThrow("replaced or modified");
		expect(readFileSync(path, "utf8")).toBe("{}\n");
		// Initially absent path created meanwhile.
		const fresh = join(home, "new.json");
		expect(() => updateSettingsFile(fresh, (file) => { writeFileSync(fresh, '{"theme":"x"}\n'); return plan()(file); })).toThrow("was created by another process");
		expect(readFileSync(fresh, "utf8")).toBe('{"theme":"x"}\n');
		// Benign unrelated concurrent change: the plan sees the new bytes because it runs under the lock.
		expect(leftovers(home)).toEqual([]);
	});

	it("cleans up the temp file and lock when the rename fails", () => {
		const path = join(home, "settings.json");
		writeFileSync(path, "{}\n");
		expect(() => updateSettingsFile(path, plan(), { rename: () => { throw new Error("EXDEV simulated"); } })).toThrow("EXDEV simulated");
		expect(readFileSync(path, "utf8")).toBe("{}\n");
		expect(leftovers(home)).toEqual([]);
	});

	it("preserves the file mode on rewrite", () => {
		const path = join(home, "settings.json");
		writeFileSync(path, "{}\n");
		chmodSync(path, 0o640);
		expect(updateSettingsFile(path, plan()).written).toBe(path);
		expect(statSync(path).mode & 0o777).toBe(0o640);
	});

	it("refuses symlinked settings paths and aliased directories, whose targets may carry their own native lock", () => {
		const real = join(home, "real.json");
		writeFileSync(real, "{}\n");
		mkdirSync(settingsLockPath(real)); // native lock held on the real file
		const link = join(home, "settings.json");
		symlinkSync(real, link);
		expect(() => updateSettingsFile(link, plan())).toThrow("is a symbolic link");
		expect(readFileSync(real, "utf8")).toBe("{}\n");
		expect(existsSync(settingsLockPath(real))).toBe(true);
		const dangling = join(home, "dangling.json");
		symlinkSync(join(home, "missing.json"), dangling);
		expect(() => updateSettingsFile(dangling, plan())).toThrow("is a symbolic link");
		expect(existsSync(join(home, "missing.json"))).toBe(false);
		// A symlink appearing after the snapshot is also refused before rename.
		const late = join(home, "late.json");
		expect(() => updateSettingsFile(late, (file) => { symlinkSync(real, late); return plan()(file); })).toThrow("is a symbolic link");
		expect(readFileSync(real, "utf8")).toBe("{}\n");
		// Directory alias: the real directory's lock would not be honoured through the alias.
		const realDir = join(home, "agent");
		mkdirSync(realDir);
		writeFileSync(join(realDir, "settings.json"), "{}\n");
		const aliasDir = join(home, "agent-alias");
		symlinkSync(realDir, aliasDir);
		expect(() => updateSettingsFile(join(aliasDir, "settings.json"), plan())).toThrow("reachable only through an alias");
		expect(readFileSync(join(realDir, "settings.json"), "utf8")).toBe("{}\n");
		expect(readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(readdirSync(realDir)).toEqual(["settings.json"]);
	});

	it("refuses directories and oversized files without reading them", () => {
		const dir = join(home, "settings.json");
		mkdirSync(dir);
		expect(() => updateSettingsFile(dir, plan())).toThrow("not a regular file");
		const big = join(home, "big.json");
		writeFileSync(big, `{"pad":"${"x".repeat(MAX_SETTINGS_BYTES)}"}`);
		expect(() => readSettingsFile(big)).toThrow("refusing to read or rewrite");
		expect(() => updateSettingsFile(big, plan())).toThrow("refusing to read or rewrite");
		expect(statSync(big).size).toBeGreaterThan(MAX_SETTINGS_BYTES);
		expect(leftovers(home)).toEqual([]);
	});

	it("refuses to produce an oversized file", () => {
		const path = join(home, "settings.json");
		writeFileSync(path, "{}\n");
		expect(() => updateSettingsFile(path, () => ({ settings: { pad: "x".repeat(MAX_SETTINGS_BYTES) } }))).toThrow("larger than 1 MiB");
		expect(readFileSync(path, "utf8")).toBe("{}\n");
		expect(leftovers(home)).toEqual([]);
	});
});
