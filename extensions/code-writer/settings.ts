/**
 * Pure planning and validation of the native pi-subagents settings written
 * for the `code-writer` role, plus the locked atomic file transaction used by
 * the human command. Nothing here launches agents, probes models, or touches
 * credentials.
 *
 * Validation covers only the bounded subset of the native schema this feature
 * reads or writes (model scope, the code-writer override in every layer,
 * provider override map containers, project root policy); it is not a
 * complete native settings validator.
 */
import {
	closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync,
	rmdirSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	CODE_WRITER_AGENT,
	hierarchyModels,
	matchesScopePattern,
	type ModelHierarchy,
	parseHierarchy,
} from "./hierarchy";

export type JsonObject = Record<string, unknown>;

/** Providers bundled with pi-ai that need no provider extension in a child. */
export const BUILTIN_PROVIDERS = new Set([
	"amazon-bedrock", "anthropic", "google", "google-vertex", "openai", "azure-openai-responses", "openai-codex",
	"deepseek", "github-copilot", "xai", "groq", "cerebras", "openrouter", "vercel-ai-gateway", "zai", "mistral",
	"minimax", "minimax-cn", "moonshotai", "moonshotai-cn", "huggingface", "fireworks", "together", "opencode",
	"opencode-go", "kimi-coding", "cloudflare-workers-ai", "cloudflare-ai-gateway", "xiaomi", "xiaomi-token-plan-cn",
	"xiaomi-token-plan-ams", "xiaomi-token-plan-sgp",
]);

/** The only provider extension this toolkit owns and may add to a child automatically. */
export const ANTHROPIC_CLAUDE_CODE_PROVIDER = "anthropic-claude-code";

export const MAX_SETTINGS_BYTES = 1_048_576;

/** Override fields whose presence elsewhere would change how the writer launches. */
export const WRITER_OVERRIDE_FIELDS = ["model", "fallbackModels", "thinking", "extensions", "disabled", "fast", "defaultContext", "defaultProvider"] as const;

export interface ParentModel { provider: string; id: string }

export interface PlanOptions {
	/** Absolute path of the toolkit's Anthropic provider extension. */
	anthropicProviderExtensionPath: string;
	/** `provider/id` entries of the active model registry, or undefined when no registry is available. */
	registryModels?: readonly string[];
	/** Parsed effective project settings (native project root), when one exists. */
	projectSettings?: JsonObject;
	/** Current parent session model; resolves a global `inherit` allow pattern the way native launches do. */
	parentModel?: ParentModel;
}

export interface SettingsPlan {
	settings: JsonObject;
	override: JsonObject;
	agentScope: { enforce: true; strict: true; allow: string[] };
	extensions: string[];
	warnings: string[];
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

function invalid(file: string, field: string, expected: string): Error {
	return new Error(`${file} has an unsupported '${field}' value; expected ${expected}. Fix it by hand; nothing was written.`);
}

function validateScopeRule(rule: JsonObject, file: string, field: string): void {
	if ("enforce" in rule && typeof rule.enforce !== "boolean") throw invalid(file, `${field}.enforce`, "a boolean");
	if ("strict" in rule && typeof rule.strict !== "boolean") throw invalid(file, `${field}.strict`, "a boolean");
	if ("allow" in rule) {
		const allow = stringList(rule.allow);
		if (!allow || allow.length === 0 || allow.every((entry) => !entry.trim())) throw invalid(file, `${field}.allow`, "a non-empty array of pattern strings");
	}
}

/** Native list fields plus legacy fallbackModels, accepted only so models can remove it. */
const WRITER_LIST_OR_FALSE_FIELDS = ["fallbackModels", "extensions", "defaultReads", "skills", "excludeTools", "subagentOnlyExtensions", "mutationTools"] as const;
/** Override fields native accepts only as booleans. */
const WRITER_BOOLEAN_FIELDS = ["fast", "disabled", "inheritProjectContext", "inheritGlobalContext", "inheritSkills", "allowNestedSubagents", "completionGuard"] as const;

/**
 * Every field of a code-writer override entry, in any layer, checked against
 * the types the installed native parser accepts, so a preserved user value
 * cannot make the next `/reload` reject the file. Unknown fields are left
 * alone (native ignores them).
 */
function validateWriterOverride(override: unknown, file: string, field: string): void {
	if (!isObject(override)) throw invalid(file, field, "an object");
	if ("model" in override && typeof override.model !== "string" && override.model !== false) throw invalid(file, `${field}.model`, "a string or false");
	if ("thinking" in override && typeof override.thinking !== "string" && override.thinking !== false) throw invalid(file, `${field}.thinking`, "a string or false");
	for (const key of WRITER_LIST_OR_FALSE_FIELDS) {
		if (key in override && override[key] !== false && stringList(override[key]) === undefined) throw invalid(file, `${field}.${key}`, "an array of strings or false");
	}
	if ("tools" in override && override.tools !== false && override.tools !== "inherit" && stringList(override.tools) === undefined) throw invalid(file, `${field}.tools`, "an array of strings, \"inherit\", or false");
	for (const key of WRITER_BOOLEAN_FIELDS) {
		if (key in override && typeof override[key] !== "boolean") throw invalid(file, `${field}.${key}`, "a boolean");
	}
	if ("defaultContext" in override && override.defaultContext !== "fresh" && override.defaultContext !== "fork" && override.defaultContext !== false) throw invalid(file, `${field}.defaultContext`, "'fresh', 'fork', or false");
	if ("defaultProvider" in override && override.defaultProvider !== false && (typeof override.defaultProvider !== "string" || !override.defaultProvider.trim())) throw invalid(file, `${field}.defaultProvider`, "a non-empty string or false");
	if ("description" in override && (typeof override.description !== "string" || !override.description.trim())) throw invalid(file, `${field}.description`, "a non-empty string");
	if ("output" in override && override.output !== false && (typeof override.output !== "string" || !override.output.trim())) throw invalid(file, `${field}.output`, "a non-empty string or false");
	if ("outputMode" in override && override.outputMode !== "inline" && override.outputMode !== "file-only") throw invalid(file, `${field}.outputMode`, "'inline' or 'file-only'");
	if ("systemPromptMode" in override && override.systemPromptMode !== "append" && override.systemPromptMode !== "replace") throw invalid(file, `${field}.systemPromptMode`, "'append' or 'replace'");
	if ("systemPrompt" in override && typeof override.systemPrompt !== "string") throw invalid(file, `${field}.systemPrompt`, "a string");
	if ("acceptanceRole" in override && override.acceptanceRole !== "read-only" && override.acceptanceRole !== "writer" && override.acceptanceRole !== false) throw invalid(file, `${field}.acceptanceRole`, "'read-only', 'writer', or false");
	if ("toolBudget" in override && override.toolBudget !== false && !isObject(override.toolBudget)) throw invalid(file, `${field}.toolBudget`, "an object or false");
}

/**
 * Reject the parts of a settings object that native pi-subagents would refuse
 * and that this feature reads or rewrites. Applied to the user file and the
 * effective project file before any write.
 */
export function assertSupportedSubagentSettings(settings: unknown, file: string): asserts settings is JsonObject {
	if (!isObject(settings)) throw new Error(`${file} must contain a JSON object.`);
	const subagents = settings.subagents;
	if (subagents === undefined) return;
	if (!isObject(subagents)) throw invalid(file, "subagents", "an object");
	if ("projectRootResolution" in subagents && subagents.projectRootResolution !== "nearest" && subagents.projectRootResolution !== "git-root") throw invalid(file, "subagents.projectRootResolution", "'nearest' or 'git-root'");
	if ("agentOverrides" in subagents) {
		if (!isObject(subagents.agentOverrides)) throw invalid(file, "subagents.agentOverrides", "an object keyed by agent");
		for (const [name, value] of Object.entries(subagents.agentOverrides)) {
			if (!isObject(value)) throw invalid(file, `subagents.agentOverrides.${name}`, "an object");
			if (name === CODE_WRITER_AGENT) validateWriterOverride(value, file, `subagents.agentOverrides.${name}`);
		}
	}
	if ("agentOverridesByProvider" in subagents) {
		if (!isObject(subagents.agentOverridesByProvider)) throw invalid(file, "subagents.agentOverridesByProvider", "an object keyed by provider");
		for (const [provider, agents] of Object.entries(subagents.agentOverridesByProvider)) {
			if (!isObject(agents)) throw invalid(file, `subagents.agentOverridesByProvider.${provider}`, "an object keyed by agent");
			for (const [name, value] of Object.entries(agents)) {
				if (!isObject(value)) throw invalid(file, `subagents.agentOverridesByProvider.${provider}.${name}`, "an object");
				if (name === CODE_WRITER_AGENT) validateWriterOverride(value, file, `subagents.agentOverridesByProvider.${provider}.${name}`);
			}
		}
	}
	if ("modelScope" in subagents) {
		const scope = subagents.modelScope;
		if (!isObject(scope)) throw invalid(file, "subagents.modelScope", "an object");
		validateScopeRule(scope, file, "subagents.modelScope");
		let anyAllow = stringList(scope.allow)?.length ? true : false;
		if ("agents" in scope) {
			if (!isObject(scope.agents)) throw invalid(file, "subagents.modelScope.agents", "an object keyed by agent name");
			// Native trims these keys and lets a later duplicate win, which could silently
			// replace the writer rule; refuse ambiguity instead of rewriting policy.
			const seen = new Set<string>();
			for (const [name, rule] of Object.entries(scope.agents)) {
				const trimmed = name.trim();
				if (!trimmed) throw invalid(file, "subagents.modelScope.agents", "non-empty agent names");
				if (seen.has(trimmed)) throw invalid(file, `subagents.modelScope.agents`, `unique agent names after trimming (native trims keys and the later '${trimmed}' rule would win; merge the duplicates by hand)`);
				seen.add(trimmed);
				if (trimmed === CODE_WRITER_AGENT && name !== trimmed) throw invalid(file, `subagents.modelScope.agents`, `an untrimmed '${CODE_WRITER_AGENT}' key (found ${JSON.stringify(name)}; rename it by hand)`);
				if (!isObject(rule)) throw invalid(file, `subagents.modelScope.agents.${name}`, "an object");
				if ("agents" in rule) throw invalid(file, `subagents.modelScope.agents.${name}.agents`, "no nested agent scopes");
				validateScopeRule(rule, file, `subagents.modelScope.agents.${name}`);
				if (stringList(rule.allow)?.length) anyAllow = true;
			}
		}
		if (scope.enforce === true && !anyAllow) throw invalid(file, "subagents.modelScope", "a non-empty 'allow' list when enforce is true");
	}
}

interface ScopeRule { allow?: string[]; enforce?: boolean; strict?: boolean }

function scopeRule(value: unknown): ScopeRule | undefined {
	if (!isObject(value)) return undefined;
	return {
		allow: stringList(value.allow)?.map((entry) => entry.trim()).filter(Boolean),
		enforce: typeof value.enforce === "boolean" ? value.enforce : undefined,
		strict: typeof value.strict === "boolean" ? value.strict : undefined,
	};
}

/** Expand `inherit` the way native launches do; unresolved identity yields `undefined` so callers can refuse. */
function resolveAllow(allow: string[], parentModel: ParentModel | undefined): { patterns: string[]; unresolvedInherit: boolean } {
	const unresolvedInherit = allow.includes("inherit") && !parentModel;
	const patterns = allow.map((pattern) => (pattern === "inherit" && parentModel ? `${parentModel.provider}/${parentModel.id}` : pattern));
	return { patterns, unresolvedInherit };
}

/**
 * Hierarchy models outside the enforced *global* allow-list of a scope. The
 * command-owned per-agent writer rule is never checked here: it is replaced.
 */
export function globalScopeViolations(hierarchy: ModelHierarchy, modelScope: unknown, origin: string, parentModel?: ParentModel): string[] {
	const rule = scopeRule(modelScope);
	if (!rule?.allow?.length || rule.enforce !== true) return [];
	const { patterns, unresolvedInherit } = resolveAllow(rule.allow, parentModel);
	const problems: string[] = [];
	for (const entry of hierarchyModels(hierarchy)) {
		if (patterns.some((pattern) => matchesScopePattern(entry.model, pattern))) continue;
		problems.push(unresolvedInherit
			? `${entry.model} matches only via 'inherit' in ${origin} modelScope.allow, but no parent session model is available to resolve it`
			: `${entry.model} is outside ${origin} modelScope.allow (allow: ${rule.allow.join(", ")})`);
	}
	return problems;
}

/** Provider extensions the whole chain needs; only the owned Anthropic provider is added automatically. */
export function requiredProviderExtensions(hierarchy: ModelHierarchy, anthropicProviderExtensionPath: string): string[] {
	const extensions: string[] = [];
	for (const entry of hierarchyModels(hierarchy)) {
		if (BUILTIN_PROVIDERS.has(entry.provider)) continue;
		if (entry.provider === ANTHROPIC_CLAUDE_CODE_PROVIDER) {
			if (!extensions.includes(anthropicProviderExtensionPath)) extensions.push(anthropicProviderExtensionPath);
			continue;
		}
		throw new Error(`Provider '${entry.provider}' is not a built-in Pi provider and this toolkit does not own its extension. Configure subagents.agentOverrides.${CODE_WRITER_AGENT}.extensions with that provider's extension path by hand; ambient extensions are never loaded into the writer.`);
	}
	return extensions;
}

/**
 * Keys under `subagents.agentOverridesByProvider.<provider>.code-writer` that
 * would layer over the stored hierarchy. Native applies only the active parent
 * provider's map, but the parent provider changes with `/model`, so any
 * provider map touching the writer is reported (conservative by design).
 */
export function providerOverrideConflicts(settings: JsonObject | undefined, origin: string): string[] {
	const subagents = settings && isObject(settings.subagents) ? settings.subagents : undefined;
	const byProvider = subagents && isObject(subagents.agentOverridesByProvider) ? subagents.agentOverridesByProvider : undefined;
	if (!byProvider) return [];
	const keys: string[] = [];
	for (const [provider, agents] of Object.entries(byProvider)) {
		const writer = isObject(agents) ? agents[CODE_WRITER_AGENT] : undefined;
		if (!isObject(writer)) continue;
		for (const field of WRITER_OVERRIDE_FIELDS) if (field in writer) keys.push(`${origin} subagents.agentOverridesByProvider.${provider}.${CODE_WRITER_AGENT}.${field}`);
	}
	return keys;
}

function sameModelSet(a: readonly string[], b: readonly string[]): boolean {
	const norm = (list: readonly string[]) => [...new Set(list.map((entry) => entry.trim().toLowerCase()))].sort();
	const left = norm(a);
	const right = norm(b);
	return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * Project settings that would silently override or neutralise the user-level
 * hierarchy. Project `modelScope` replaces the user scope completely, so the
 * strict per-agent rule written to the user file is inert whenever a project
 * scope exists; it is accepted only when the project already carries an
 * equivalent enforced strict writer restriction.
 */
export function projectConflicts(hierarchy: ModelHierarchy, projectSettings: JsonObject | undefined, parentModel?: ParentModel): { errors: string[]; warnings: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];
	const subagents = projectSettings && isObject(projectSettings.subagents) ? projectSettings.subagents : undefined;
	if (!subagents) return { errors, warnings };
	const override = isObject(subagents.agentOverrides) ? subagents.agentOverrides[CODE_WRITER_AGENT] : undefined;
	if (isObject(override)) {
		const owned = WRITER_OVERRIDE_FIELDS.filter((key) => key in override);
		if (owned.length > 0) errors.push(`Project settings already override ${CODE_WRITER_AGENT} (project subagents.agentOverrides.${CODE_WRITER_AGENT}.${owned.join(", ")}); project overrides win, so edit the project settings instead of the user hierarchy.`);
	}
	const providerKeys = providerOverrideConflicts(projectSettings, "project");
	if (providerKeys.length > 0) errors.push(`Provider-scoped overrides would layer over the writer hierarchy: ${providerKeys.join(", ")}. Remove or align them by hand; provider preferences are never edited automatically.`);
	if (isObject(subagents.modelScope)) {
		const violations = globalScopeViolations(hierarchy, subagents.modelScope, "project", parentModel);
		if (violations.length > 0) {
			errors.push(`Project modelScope replaces the user scope and rejects the hierarchy: ${violations.join("; ")}.`);
		} else {
			const global = scopeRule(subagents.modelScope);
			const agents = isObject(subagents.modelScope.agents) ? subagents.modelScope.agents : undefined;
			const writer = scopeRule(agents?.[CODE_WRITER_AGENT]);
			const wanted = hierarchyModels(hierarchy).map((entry) => entry.model);
			const enforce = writer?.enforce ?? global?.enforce;
			const strict = writer?.strict ?? global?.strict;
			const equivalent = Boolean(writer?.allow?.length) && enforce === true && strict === true && sameModelSet(writer!.allow!, wanted);
			if (!equivalent) {
				errors.push(`Project settings define subagents.modelScope, which replaces the user modelScope, so the strict per-agent rule written for ${CODE_WRITER_AGENT} would be ineffective. Add to the project settings by hand: "subagents": { "modelScope": { "agents": { "${CODE_WRITER_AGENT}": { "enforce": true, "strict": true, "allow": ${JSON.stringify(wanted)} } } } } (keeping the project allow-list), then rerun this command. Project files are never edited automatically.`);
			} else {
				warnings.push(`Project subagents.modelScope replaces the user scope; its existing strict ${CODE_WRITER_AGENT} rule matches this hierarchy, so the user-level per-agent rule is written for consistency only.`);
			}
		}
	}
	return { errors, warnings };
}

/**
 * Compute the settings object to persist. Throws with an actionable message
 * instead of widening policy or overwriting an unsupported layout. The
 * command-owned writer override and per-agent scope are replaced wholesale;
 * global and other-agent policy is preserved and treated as immutable.
 */
export function planSettingsUpdate(current: unknown, hierarchy: ModelHierarchy, options: PlanOptions): SettingsPlan {
	if (hierarchy.fallbacks.length > 0) {
		throw new Error("pi-subagents 0.68+ supports one model per agent; fallbackModels was removed. Configure exactly one model; nothing was written.");
	}
	assertSupportedSubagentSettings(current, "user settings.json");
	if (options.projectSettings !== undefined) assertSupportedSubagentSettings(options.projectSettings, "project settings.json");
	const warnings: string[] = [];
	if (options.registryModels) {
		const missing = hierarchyModels(hierarchy).filter((entry) => !options.registryModels!.includes(entry.model));
		if (missing.length > 0) throw new Error(`Not in this session's model registry: ${missing.map((entry) => entry.model).join(", ")}. Check /model spelling, provider login or enabledModels; nothing was written.`);
	}
	const subagents = isObject(current.subagents) ? current.subagents : {};
	const violations = globalScopeViolations(hierarchy, subagents.modelScope, "user", options.parentModel);
	if (violations.length > 0) throw new Error(`The hierarchy would require widening the existing global subagents.modelScope: ${violations.join("; ")}. Widen policy deliberately by hand, or choose models inside the allow-list; nothing was written.`);
	const userProviderKeys = providerOverrideConflicts(current, "user");
	if (userProviderKeys.length > 0) throw new Error(`Provider-scoped overrides would layer over the writer hierarchy: ${userProviderKeys.join(", ")}. Remove or align them by hand; provider preferences are never edited automatically. Nothing was written.`);
	const project = projectConflicts(hierarchy, options.projectSettings, options.parentModel);
	if (project.errors.length > 0) throw new Error(`${project.errors.join(" ")} Nothing was written.`);
	warnings.push(...project.warnings);

	const extensions = requiredProviderExtensions(hierarchy, options.anthropicProviderExtensionPath);
	const overrides = isObject(subagents.agentOverrides) ? subagents.agentOverrides : {};
	const previous = isObject(overrides[CODE_WRITER_AGENT]) ? overrides[CODE_WRITER_AGENT] : {};
	const override: JsonObject = { ...previous };
	override.model = hierarchy.primary.model;
	if (hierarchy.primary.thinking) override.thinking = hierarchy.primary.thinking;
	else delete override.thinking;
	// Remove legacy configuration even when it was [] or false: native rejects the key's presence.
	delete override.fallbackModels;
	override.defaultContext = "fresh";
	override.fast = false;
	override.extensions = extensions;
	delete override.disabled;

	const modelScope = isObject(subagents.modelScope) ? subagents.modelScope : {};
	const agents = isObject(modelScope.agents) ? modelScope.agents : {};
	const agentScope: SettingsPlan["agentScope"] = { enforce: true, strict: true, allow: hierarchyModels(hierarchy).map((entry) => entry.model) };

	const settings: JsonObject = {
		...current,
		subagents: {
			...subagents,
			agentOverrides: { ...overrides, [CODE_WRITER_AGENT]: override },
			modelScope: { ...modelScope, agents: { ...agents, [CODE_WRITER_AGENT]: agentScope } },
		},
	};
	return { settings, override, agentScope, extensions, warnings };
}

export interface StoredWriterConfig {
	model?: string;
	thinking?: string;
	fallbackModels?: string[] | false;
	/** `undefined` = no override field (packaged empty list applies); `false` = explicit list cleared, ambient extensions load. */
	extensions?: string[] | false;
	agentAllow?: string[];
	agentEnforce?: boolean;
	agentStrict?: boolean;
	globalAllow?: string[];
	globalEnforce?: boolean;
	globalStrict?: boolean;
	disabled?: boolean;
	providerOverrideKeys: string[];
}

/** Read what a settings object currently stores for the writer, without validation side effects. */
export function readStoredWriterConfig(settings: unknown, origin = "user"): StoredWriterConfig {
	const result: StoredWriterConfig = { providerOverrideKeys: [] };
	if (!isObject(settings) || !isObject(settings.subagents)) return result;
	const subagents = settings.subagents;
	const override = isObject(subagents.agentOverrides) ? subagents.agentOverrides[CODE_WRITER_AGENT] : undefined;
	const scope = isObject(subagents.modelScope) ? subagents.modelScope : undefined;
	const agentScope = scope && isObject(scope.agents) ? scope.agents[CODE_WRITER_AGENT] : undefined;
	if (isObject(override)) {
		if (typeof override.model === "string") result.model = override.model;
		if (typeof override.thinking === "string") result.thinking = override.thinking;
		if (override.fallbackModels === false) result.fallbackModels = false;
		else { const list = stringList(override.fallbackModels); if (list) result.fallbackModels = list; }
		if (override.extensions === false) result.extensions = false;
		else { const list = stringList(override.extensions); if (list) result.extensions = list; }
		if (override.disabled === true) result.disabled = true;
	}
	if (scope) {
		const global = scopeRule(scope);
		result.globalAllow = global?.allow;
		result.globalEnforce = global?.enforce;
		result.globalStrict = global?.strict;
		const agent = scopeRule(agentScope);
		result.agentAllow = agent?.allow;
		result.agentEnforce = agent?.enforce ?? global?.enforce;
		result.agentStrict = agent?.strict ?? global?.strict;
	}
	result.providerOverrideKeys = providerOverrideConflicts(settings, origin);
	return result;
}

// ---------------------------------------------------------------------------
// User-level routing default (`codeWriter.routingDefault`)
// ---------------------------------------------------------------------------

/** Extension-owned namespace in the user settings file; native pi-subagents does not read it. */
export const ROUTING_DEFAULT_NAMESPACE = "codeWriter";
export const ROUTING_DEFAULT_KEY = "routingDefault";
/** Dotted name used in messages and documentation. */
export const ROUTING_DEFAULT_SETTING = `${ROUTING_DEFAULT_NAMESPACE}.${ROUTING_DEFAULT_KEY}`;

/**
 * Read the user-level routing default. Absent namespace or flag means
 * `false` (the pre-existing behaviour). Unsupported shapes throw rather than
 * being coerced: the flag is only ever read from the user file, never from
 * project settings.
 */
export function readRoutingDefault(settings: unknown, file = "user settings.json"): boolean {
	if (!isObject(settings)) throw new Error(`${file} must contain a JSON object.`);
	const namespace = settings[ROUTING_DEFAULT_NAMESPACE];
	if (namespace === undefined) return false;
	if (!isObject(namespace)) throw invalid(file, ROUTING_DEFAULT_NAMESPACE, "an object");
	const flag = namespace[ROUTING_DEFAULT_KEY];
	if (flag === undefined) return false;
	if (typeof flag !== "boolean") throw invalid(file, ROUTING_DEFAULT_SETTING, "a boolean");
	return flag;
}

export interface RoutingDefaultPlan {
	settings: JsonObject;
	enabled: boolean;
	/** Value in effect before this plan (false when absent). */
	previous: boolean;
}

/**
 * Compute the settings object with only `codeWriter.routingDefault` set.
 * Every other key, including unknown siblings inside the namespace and the
 * whole `subagents` tree, is carried over untouched; nothing is validated or
 * repaired beyond the namespace itself, so disabling the default stays
 * possible while the writer configuration is unusable.
 */
export function planRoutingDefault(current: unknown, enabled: boolean): RoutingDefaultPlan {
	if (!isObject(current)) throw new Error("user settings.json must contain a JSON object.");
	const previous = readRoutingDefault(current);
	const namespace = isObject(current[ROUTING_DEFAULT_NAMESPACE]) ? current[ROUTING_DEFAULT_NAMESPACE] : {};
	const settings: JsonObject = { ...current, [ROUTING_DEFAULT_NAMESPACE]: { ...namespace, [ROUTING_DEFAULT_KEY]: enabled } };
	return { settings, enabled, previous };
}

// ---------------------------------------------------------------------------
// Native project root resolution (mirrors installed pi-subagents 0.66.0
// `findConfiguredProjectRoot`; the bundled 0.28 runtime lacks this API).
// ---------------------------------------------------------------------------

/** Standard Pi project config directory; rebranded config-dir names are not supported by this feature. */
export const PROJECT_CONFIG_DIR = ".pi";

function isDirectory(path: string): boolean {
	try { return statSync(path).isDirectory(); } catch { return false; }
}

function readStrictJsonObject(path: string): JsonObject {
	const file = readSettingsFile(path);
	return file.parsed as JsonObject;
}

function readProjectRootResolution(candidate: string): "nearest" | "git-root" | undefined {
	const settingsPath = join(candidate, PROJECT_CONFIG_DIR, "settings.json");
	if (!existsSync(settingsPath)) return undefined;
	const settings = readStrictJsonObject(settingsPath);
	const subagents = settings.subagents;
	if (!isObject(subagents)) return undefined;
	const value = subagents.projectRootResolution;
	if (value === undefined) return undefined;
	if (value === "nearest" || value === "git-root") return value;
	throw new Error(`${settingsPath} has an unsupported 'subagents.projectRootResolution' value; expected 'nearest' or 'git-root'. Nothing was written.`);
}

/**
 * Native project root: ancestor directories containing `.pi/` or `.agents/`
 * are candidates; the nearest wins unless a candidate's settings choose
 * `git-root`, in which case the candidate matching the nearest `.git` (or the
 * policy candidate itself when it holds `.git`) wins. Unsupported policy
 * values throw so callers fail closed.
 */
export function findConfiguredProjectRoot(cwd: string): string | null {
	const candidates: string[] = [];
	let current = cwd;
	for (;;) {
		if (isDirectory(join(current, PROJECT_CONFIG_DIR)) || isDirectory(join(current, ".agents"))) candidates.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	const nearest = candidates[0];
	if (!nearest) return null;
	let policyRoot: string | undefined;
	let policyIndex = -1;
	for (const [index, candidate] of candidates.entries()) {
		const mode = readProjectRootResolution(candidate);
		if (mode === "nearest") return nearest;
		if (mode === "git-root") { policyRoot = candidate; policyIndex = index; break; }
	}
	if (!policyRoot) return nearest;
	let gitRoot: string | null = null;
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) { gitRoot = dir; break; }
		if (dirname(dir) === dir) break;
	}
	const gitProjectRoot = gitRoot ? candidates.slice(policyIndex).find((candidate) => candidate === gitRoot) : undefined;
	const configuredGitRoot = existsSync(join(policyRoot, ".git")) ? policyRoot : undefined;
	return gitProjectRoot ?? configuredGitRoot ?? nearest;
}

/** Effective project settings file for `cwd` under native resolution, or null when there is no project root. */
export function projectSettingsPath(cwd: string): string | null {
	const root = findConfiguredProjectRoot(cwd);
	return root ? join(root, PROJECT_CONFIG_DIR, "settings.json") : null;
}

// ---------------------------------------------------------------------------
// Read-only activation check of the configuration as it currently stands
// ---------------------------------------------------------------------------

export interface ActivationInput {
	/** Parsed user settings (may be `{}`). */
	userSettings: unknown;
	/** Parsed effective project settings, or undefined when absent. */
	projectSettings?: JsonObject;
	anthropicProviderExtensionPath: string;
	parentModel?: ParentModel;
}

export interface ActivationCheck {
	hierarchy: ModelHierarchy;
	warnings: string[];
}

/**
 * Decide whether the stored/effective configuration, exactly as it is, will
 * launch the writer on the stored hierarchy with an enforced strict scope.
 * Nothing is repaired or planned: this is what native would use on the next
 * launch. Throws with the reason routing must stay unchanged.
 */
export function assertActivatable(input: ActivationInput): ActivationCheck {
	const refuse = (reason: string): never => { throw new Error(`${reason} Routing is unchanged.`); };
	try {
		assertSupportedSubagentSettings(input.userSettings, "user settings.json");
		if (input.projectSettings !== undefined) assertSupportedSubagentSettings(input.projectSettings, "project settings.json");
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error));
	}
	const user = readStoredWriterConfig(input.userSettings, "user");
	if (!user.model) refuse("No code-writer hierarchy is configured; refusing to enable routing.");
	if (user.disabled) refuse(`The stored code-writer override is disabled (user subagents.agentOverrides.${CODE_WRITER_AGENT}.disabled); re-enable it by hand or rerun /code-writer models.`);
	if (user.fallbackModels !== undefined) refuse(`The stored override uses removed field fallbackModels; rerun /code-writer models with exactly one model.`);
	const hierarchy = (() => {
		try {
			return parseHierarchy([user.thinking ? `${user.model}:${user.thinking}` : user.model!]);
		} catch (error) {
			return refuse(`The stored hierarchy is not usable as written: ${error instanceof Error ? error.message : String(error)} Rerun /code-writer models.`);
		}
	})();
	const required = requiredProviderExtensions(hierarchy, input.anthropicProviderExtensionPath);
	const extensions = user.extensions;
	if (extensions === false) refuse(`The stored override sets extensions to false (ambient extensions would load into the writer); rerun /code-writer models.`);
	const present: string[] = extensions === false ? [] : extensions ?? [];
	const missing = required.filter((extension) => !present.includes(extension));
	if (missing.length > 0) refuse(`The stored override lacks the provider extension the hierarchy needs (${missing.join(", ")}); rerun /code-writer models.`);
	if (user.providerOverrideKeys.length > 0) refuse(`Provider-scoped overrides layer over the stored hierarchy: ${user.providerOverrideKeys.join(", ")}. Remove or align them by hand.`);
	const userViolations = globalScopeViolations(hierarchy, isObject(input.userSettings) && isObject(input.userSettings.subagents) ? input.userSettings.subagents.modelScope : undefined, "user", input.parentModel);
	if (userViolations.length > 0) refuse(`The stored hierarchy is outside the global scope: ${userViolations.join("; ")}.`);
	const project = projectConflicts(hierarchy, input.projectSettings, input.parentModel);
	if (project.errors.length > 0) refuse(project.errors.join(" "));
	const wanted = hierarchyModels(hierarchy).map((entry) => entry.model);
	const projectScope = input.projectSettings && isObject(input.projectSettings.subagents) ? input.projectSettings.subagents.modelScope : undefined;
	if (projectScope === undefined) {
		// The user scope is the effective one: the writer rule must be present, enforced, strict and equal to the hierarchy.
		if (!user.agentAllow?.length || user.agentEnforce !== true || user.agentStrict !== true || !sameModelSet(user.agentAllow, wanted)) {
			refuse(`The effective user modelScope.agents.${CODE_WRITER_AGENT} rule is missing, not enforced strict, or does not match the stored hierarchy; rerun /code-writer models.`);
		}
	}
	return { hierarchy, warnings: project.warnings };
}

// ---------------------------------------------------------------------------
// Locked atomic settings transaction
// ---------------------------------------------------------------------------

export interface SettingsFile {
	path: string;
	/** Raw bytes read, or undefined when the file does not exist. */
	raw?: string;
	parsed: unknown;
}

/** Read and JSON-parse a settings file. Malformed content throws; absence yields `{}`. */
export function readSettingsFile(path: string): SettingsFile {
	let raw: string;
	try {
		const info = statSync(path);
		if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
		if (info.size > MAX_SETTINGS_BYTES) throw new Error(`${path} is larger than ${MAX_SETTINGS_BYTES} bytes; refusing to read or rewrite it.`);
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, parsed: {} };
		throw error;
	}
	return parseSettingsRaw(path, raw);
}

function parseSettingsRaw(path: string, raw: string): SettingsFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
	} catch (error) {
		throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix it by hand; nothing was written.`);
	}
	if (!isObject(parsed)) throw new Error(`${path} must contain a JSON object; nothing was written.`);
	return { path, raw, parsed };
}

function detectIndent(raw: string | undefined): string {
	return raw && /\n\t/.test(raw) ? "\t" : "  ";
}

export function serialiseSettings(settings: JsonObject, previousRaw: string | undefined): string {
	return `${JSON.stringify(settings, null, detectIndent(previousRaw))}\n`;
}

/**
 * Same on-disk protocol as `proper-lockfile` (used by Pi's SettingsManager
 * with `realpath: false`): an exclusive `<path>.lock` directory beside the
 * configured path, which its owner may refresh by touching its mtime and
 * which others treat as stale after 10 s without a refresh.
 *
 * This feature never takes over, refreshes or deletes a lock it did not
 * create: any pre-existing lock, stale or not, is a refusal. Its own lock is
 * identified by the directory's inode and timestamps and is considered lost
 * when that identity changes, the directory disappears, or the stale
 * threshold elapses; a lost lock prevents committing and is never removed.
 */
export const LOCK_STALE_MS = 10_000;
const LOCK_ATTEMPTS = 10;
const LOCK_RETRY_MS = 20;

export function settingsLockPath(path: string): string {
	return `${path}.lock`;
}

function sleepSync(ms: number): void {
	const end = Date.now() + ms;
	while (Date.now() < end) { /* bounded synchronous wait, mirrors Pi's retry loop */ }
}

interface LockIdentity { dev: number; ino: number; mtimeMs: number; ctimeMs: number }

function lockIdentity(lock: string): LockIdentity | undefined {
	try {
		const info = statSync(lock);
		return { dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
	} catch {
		return undefined;
	}
}

function sameIdentity(a: LockIdentity | undefined, b: LockIdentity | undefined): boolean {
	return Boolean(a && b) && a!.dev === b!.dev && a!.ino === b!.ino && a!.mtimeMs === b!.mtimeMs && a!.ctimeMs === b!.ctimeMs;
}

export interface SettingsLock {
	/** Throws when the lock is no longer exclusively owned or its stale window has elapsed. */
	assertOwned(): void;
	/** Removes the lock only while it is still the one this process created. */
	release(): void;
}

export interface LockIo {
	/** Overridable clock for deterministic expiry tests. */
	now?: () => number;
}

export function acquireSettingsLock(path: string, io: LockIo = {}): SettingsLock {
	const now = io.now ?? Date.now;
	const lock = settingsLockPath(path);
	mkdirSync(dirname(lock), { recursive: true });
	for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt++) {
		try {
			mkdirSync(lock);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (attempt === LOCK_ATTEMPTS) throw new Error(`${path} is locked by another Pi process (${lock}). Retry in a moment, or remove the lock by hand if you are sure it is abandoned; nothing was written.`);
			sleepSync(LOCK_RETRY_MS);
		}
	}
	const acquiredAt = now();
	const identity = lockIdentity(lock);
	if (!identity) throw new Error(`${lock} vanished right after it was created; nothing was written.`);
	const owned = () => sameIdentity(identity, lockIdentity(lock));
	return {
		assertOwned() {
			if (!owned()) throw new Error(`${lock} was replaced or removed by another process while this command ran; nothing was written.`);
			if (now() - acquiredAt >= LOCK_STALE_MS) throw new Error(`${lock} passed its stale threshold before the write could be committed; retry the command, nothing was written.`);
		},
		release() {
			if (!owned()) return;
			try { rmdirSync(lock); } catch { /* already released */ }
		},
	};
}

export interface TransactionIo extends LockIo {
	/** Overridable for failure-path tests. */
	rename?: (from: string, to: string) => void;
}

export interface SettingsTransactionResult<T> {
	file: SettingsFile;
	plan: T;
	/** Path actually written; always the configured path (aliases are refused). */
	written: string;
}

interface FileSnapshot { dev: number; ino: number; uid: number; mode: number; size: number; mtimeMs: number; raw: string }

/** Ownership and content of the regular file at `path`, or undefined when absent. */
function snapshotRegularFile(path: string): FileSnapshot | undefined {
	let info: ReturnType<typeof lstatSync>;
	try {
		info = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (info.isSymbolicLink()) throw new Error(`${path} is a symbolic link; this command only rewrites a regular settings file at the configured path. Point Pi at the real file or replace the link by hand; nothing was written.`);
	if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
	if (info.size > MAX_SETTINGS_BYTES) throw new Error(`${path} is larger than ${MAX_SETTINGS_BYTES} bytes; refusing to read or rewrite it.`);
	const uid = process.getuid?.();
	if (uid !== undefined && info.uid !== uid) throw new Error(`${path} is owned by another user; refusing to rewrite it.`);
	return { dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode & 0o777, size: info.size, mtimeMs: info.mtimeMs, raw: readFileSync(path, "utf8") };
}

function sameSnapshot(before: FileSnapshot | undefined, after: FileSnapshot | undefined): boolean {
	if (!before || !after) return before === after;
	return before.dev === after.dev && before.ino === after.ino && before.uid === after.uid && before.mode === after.mode
		&& before.size === after.size && before.mtimeMs === after.mtimeMs && before.raw === after.raw;
}

/**
 * Locked read-plan-write transaction on a regular file at the configured
 * path. Holding the compatible lock, snapshot the file (identity, ownership,
 * bytes), run `plan` against that content, write a same-directory temp file,
 * then re-check the snapshot and the lock ownership immediately before the
 * atomic rename. Symlinked settings paths and directories reachable only
 * through an alias are refused (their target could carry a different native
 * lock). Temporary files and the owned lock are removed on every failure.
 * This is race-aware cooperation with Pi's own writer, not a sandbox against
 * adversarial filesystem changes.
 */
export function updateSettingsFile<T extends { settings: JsonObject }>(
	path: string,
	plan: (file: SettingsFile) => T,
	io: TransactionIo = {},
): SettingsTransactionResult<T> {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const realDir = realpathSync(dir);
	if (realDir !== dir) throw new Error(`${dir} is reachable only through an alias of ${realDir}; a native lock taken at the real path would not be honoured. Configure the real path; nothing was written.`);
	const lock = acquireSettingsLock(path, io);
	let temp: string | undefined;
	try {
		const before = snapshotRegularFile(path);
		const file: SettingsFile = before ? parseSettingsRaw(path, before.raw) : { path, parsed: {} };
		const result = plan(file);
		const content = serialiseSettings(result.settings, file.raw);
		if (Buffer.byteLength(content) > MAX_SETTINGS_BYTES) throw new Error("Refusing to write settings larger than 1 MiB.");
		const mode = before?.mode ?? 0o600;
		temp = join(dir, `.${process.pid}-${Date.now().toString(36)}-code-writer.tmp`);
		const fd = openSync(temp, "wx", mode);
		try {
			writeSync(fd, content);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		// Immediately before replacement: still our lock, and the target is exactly what was planned against.
		lock.assertOwned();
		const after = snapshotRegularFile(path);
		if (!sameSnapshot(before, after)) {
			throw new Error(before
				? `${path} was replaced or modified while the command was running; rerun it. Nothing was written.`
				: `${path} was created by another process while the command was running; rerun it. Nothing was written.`);
		}
		(io.rename ?? renameSync)(temp, path);
		temp = undefined;
		return { file, plan: result, written: path };
	} finally {
		if (temp) { try { unlinkSync(temp); } catch { /* never created */ } }
		lock.release();
	}
}
