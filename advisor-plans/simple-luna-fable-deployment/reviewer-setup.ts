/**
 * ONE-OFF local setup artefact (not product code): plan and, only on explicit
 * `--apply`, write the reviewer-only pi-subagents override that puts the
 * builtin read-only `reviewer` on Fable 5.1 medium.
 *
 * Importing this module does nothing. The CLI is read-only (a plan) unless
 * `--apply` is passed. It reuses the code-writer settings transaction and
 * touches exactly two keys: `subagents.agentOverrides.reviewer` and
 * `subagents.modelScope.agents.reviewer`. It never reads or writes the
 * code-writer hierarchy, global scope, parent model or any other role, and it
 * never prints settings content: diagnostics name paths and keys only.
 *
 * It is deliberately not a settings framework: any reviewer key it does not
 * write itself, and any reviewer entry under a provider-scoped map, is a
 * refusal rather than something to validate or merge.
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { matchesScopePattern } from "../../extensions/code-writer/hierarchy";
import {
	assertSupportedSubagentSettings, type JsonObject, projectSettingsPath, readSettingsFile, updateSettingsFile,
} from "../../extensions/code-writer/settings";

export const REVIEWER_AGENT = "reviewer";
export const REVIEWER_MODEL = "anthropic-claude-code/claude-fable-5-1";
/** MAIN checkout path on purpose: worktrees are disposable and the child loads this at launch time. */
export const MAIN_ANTHROPIC_PROVIDER_EXTENSION = "/home/tvd/agent-skills/extensions/anthropic-claude-code.ts";
export const REVIEWER_TOOLS = ["read", "grep", "find", "ls", "contact_supervisor"] as const;

/** Exactly what is written under `subagents.agentOverrides.reviewer` (merged over preserved unrelated keys). */
export function reviewerOverride(anthropicProviderExtensionPath: string): JsonObject {
	return {
		model: REVIEWER_MODEL,
		thinking: "medium",
		fallbackModels: [],
		defaultContext: "fresh",
		fast: false,
		extensions: [anthropicProviderExtensionPath],
		tools: [...REVIEWER_TOOLS],
		inheritProjectContext: true,
		inheritGlobalContext: false,
		inheritSkills: false,
		allowNestedSubagents: false,
	};
}

export const REVIEWER_SCOPE = { enforce: true, strict: true, allow: [REVIEWER_MODEL] } as const;

/**
 * The only keys tolerated in an existing reviewer entry: the ones this setup
 * rewrites, plus `disabled` (refused when true, dropped otherwise). Every other
 * key (systemPrompt, subagentOnlyExtensions, output, skills, toolBudget, ...)
 * could change the reviewer's capabilities or break native loading, so its
 * presence is a refusal, not a merge.
 */
export const SUPPORTED_REVIEWER_KEYS = [...Object.keys(reviewerOverride("/unused")), "disabled"] as const;

export interface ReviewerPlanOptions {
	anthropicProviderExtensionPath?: string;
	/** Parsed effective project settings for the working directory, when a project file exists. */
	projectSettings?: JsonObject;
}

export interface ReviewerPlan {
	settings: JsonObject;
	/** Settings paths this plan writes; nothing else changes. */
	affectedKeys: string[];
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function refuse(message: string): never {
	throw new Error(`${message} Resolve it by hand; nothing was written.`);
}

/** Any reviewer entry in a provider-scoped map is refused: native layers the parent provider's map, which changes with /model. */
function providerScopedReviewerEntries(settings: JsonObject, origin: string): string[] {
	const subagents = isObject(settings.subagents) ? settings.subagents : undefined;
	const byProvider = subagents && isObject(subagents.agentOverridesByProvider) ? subagents.agentOverridesByProvider : undefined;
	if (!byProvider) return [];
	return Object.entries(byProvider)
		.filter(([, agents]) => isObject(agents) && REVIEWER_AGENT in agents)
		.map(([provider]) => `${origin} subagents.agentOverridesByProvider.${provider}.${REVIEWER_AGENT}`);
}

/** Refuse unknown reviewer keys and wrong types for the supported ones, so the merge cannot preserve a capability change. */
function checkExistingReviewerEntry(previous: JsonObject, extension: string): void {
	const field = `user subagents.agentOverrides.${REVIEWER_AGENT}`;
	const unsupported = Object.keys(previous).filter((key) => !(SUPPORTED_REVIEWER_KEYS as readonly string[]).includes(key));
	if (unsupported.length > 0) refuse(`${field} has keys this one-off setup does not manage: ${unsupported.join(", ")}. Remove or reconcile them by hand first; nothing is merged around them.`);
	if ("disabled" in previous) {
		if (typeof previous.disabled !== "boolean") refuse(`${field}.disabled is not a boolean.`);
		if (previous.disabled) refuse(`${field}.disabled is true; this setup does not re-enable a deliberately disabled role.`);
	}
	if ("model" in previous && typeof previous.model !== "string") refuse(`${field}.model is not a string.`);
	if ("thinking" in previous && typeof previous.thinking !== "string") refuse(`${field}.thinking is not a string.`);
	if ("fallbackModels" in previous && !isStringList(previous.fallbackModels)) refuse(`${field}.fallbackModels is not an array of strings.`);
	if ("defaultContext" in previous && previous.defaultContext !== "fresh" && previous.defaultContext !== "fork") refuse(`${field}.defaultContext is not 'fresh' or 'fork'.`);
	for (const key of ["fast", "inheritProjectContext", "inheritGlobalContext", "inheritSkills", "allowNestedSubagents"]) {
		if (key in previous && typeof previous[key] !== "boolean") refuse(`${field}.${key} is not a boolean.`);
	}
	if ("tools" in previous && JSON.stringify(previous.tools) !== JSON.stringify([...REVIEWER_TOOLS])) refuse(`${field}.tools already customises the reviewer's tools; this setup only writes the read-only set ${REVIEWER_TOOLS.join(", ")}.`);
	if (previous.allowNestedSubagents === true || previous.inheritGlobalContext === true || previous.inheritSkills === true) refuse(`${field} enables nested delegation, global context or skills; this setup keeps all three off.`);
	if ("extensions" in previous && JSON.stringify(previous.extensions) !== JSON.stringify([extension])) refuse(`${field}.extensions already lists other extensions; merge by hand.`);
}

/** Pure plan: validates the current user (and effective project) settings and returns the merged result, or throws. */
export function planReviewerSettings(current: unknown, options: ReviewerPlanOptions = {}): ReviewerPlan {
	const extension = options.anthropicProviderExtensionPath ?? MAIN_ANTHROPIC_PROVIDER_EXTENSION;
	assertSupportedSubagentSettings(current, "user settings.json");
	const project = options.projectSettings;
	if (project !== undefined) assertSupportedSubagentSettings(project, "project settings.json");

	const subagents = isObject(current.subagents) ? current.subagents : {};
	const overrides = isObject(subagents.agentOverrides) ? subagents.agentOverrides : {};
	if (REVIEWER_AGENT in overrides && !isObject(overrides[REVIEWER_AGENT])) refuse(`user subagents.agentOverrides.${REVIEWER_AGENT} is not an object.`);
	const previous = isObject(overrides[REVIEWER_AGENT]) ? overrides[REVIEWER_AGENT] : {};
	checkExistingReviewerEntry(previous, extension);

	const userProviderEntries = providerScopedReviewerEntries(current, "user");
	if (userProviderEntries.length > 0) refuse(`Provider-scoped reviewer entries would layer over this configuration: ${userProviderEntries.join(", ")}.`);

	const modelScope = isObject(subagents.modelScope) ? subagents.modelScope : {};
	const globalAllow = isStringList(modelScope.allow) ? modelScope.allow.map((entry) => entry.trim()) : [];
	if (modelScope.enforce === true && !globalAllow.some((pattern) => matchesScopePattern(REVIEWER_MODEL, pattern))) {
		refuse(`${REVIEWER_MODEL} is outside the enforced user subagents.modelScope.allow (patterns other than 'inherit' are checked; the global scope is never widened here).`);
	}
	const agents = isObject(modelScope.agents) ? modelScope.agents : {};
	for (const name of Object.keys(agents)) {
		if (name !== REVIEWER_AGENT && name.trim() === REVIEWER_AGENT) refuse(`user subagents.modelScope.agents has an untrimmed ${JSON.stringify(name)} key that native would merge with the reviewer rule.`);
	}

	if (project) {
		const projectSubagents = isObject(project.subagents) ? project.subagents : {};
		const projectOverrides = isObject(projectSubagents.agentOverrides) ? projectSubagents.agentOverrides : {};
		if (REVIEWER_AGENT in projectOverrides) refuse(`The effective project settings override ${REVIEWER_AGENT}; the user-level configuration would not be what launches.`);
		if ("modelScope" in projectSubagents) refuse("The effective project settings define subagents.modelScope, which replaces the user scope and would make the reviewer-only rule inert.");
		const projectProviderEntries = providerScopedReviewerEntries(project, "project");
		if (projectProviderEntries.length > 0) refuse(`Project provider-scoped reviewer entries would layer over this configuration: ${projectProviderEntries.join(", ")}.`);
	}

	const override: JsonObject = { ...previous, ...reviewerOverride(extension) };
	delete override.disabled;
	const settings: JsonObject = {
		...current,
		subagents: {
			...subagents,
			agentOverrides: { ...overrides, [REVIEWER_AGENT]: override },
			modelScope: { ...modelScope, agents: { ...agents, [REVIEWER_AGENT]: { ...REVIEWER_SCOPE, allow: [...REVIEWER_SCOPE.allow] } } },
		},
	};
	return {
		settings,
		affectedKeys: [
			...Object.keys(reviewerOverride(extension)).map((key) => `subagents.agentOverrides.${REVIEWER_AGENT}.${key}`),
			`subagents.modelScope.agents.${REVIEWER_AGENT}`,
		],
	};
}

export interface InstallOptions extends ReviewerPlanOptions {
	/** When false (default), plan against the current file and write nothing. */
	apply?: boolean;
}

/** Plan against the file at `settingsPath`; write it under the code-writer lock/transaction only when `apply` is true. */
export function installReviewerSettings(settingsPath: string, options: InstallOptions = {}): ReviewerPlan {
	const extension = options.anthropicProviderExtensionPath ?? MAIN_ANTHROPIC_PROVIDER_EXTENSION;
	if (!existsSync(extension)) refuse(`Provider extension ${extension} does not exist; the reviewer could not load the anthropic-claude-code provider.`);
	if (!options.apply) return planReviewerSettings(readSettingsFile(settingsPath).parsed, options);
	return updateSettingsFile(settingsPath, (file) => planReviewerSettings(file.parsed, options)).plan;
}

export interface CliArguments {
	settings?: string;
	cwd?: string;
	apply: boolean;
	help: boolean;
}

const USAGE = "Usage: bun reviewer-setup.ts [--settings <settings.json>] [--cwd <dir>] [--apply] [--help]\nWithout --apply this only validates and lists the keys it would write.";

/**
 * Strict argument parsing: every token must be a known flag, value flags need
 * a following non-flag value, and no flag may repeat. Nothing about the
 * environment (HOME, cwd) is consulted until this has succeeded, so a
 * malformed command line can never select a default target.
 */
export function parseCliArguments(argv: readonly string[]): CliArguments {
	const parsed: CliArguments = { apply: false, help: false };
	const seen = new Set<string>();
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index]!;
		if (seen.has(token)) throw new Error(`Duplicate argument ${token}.`);
		seen.add(token);
		switch (token) {
			case "--help":
			case "-h":
				parsed.help = true;
				break;
			case "--apply":
				parsed.apply = true;
				break;
			case "--settings":
			case "--cwd": {
				const value = argv[index + 1];
				if (value === undefined || value === "" || value.startsWith("-")) throw new Error(`${token} requires a value.`);
				if (token === "--settings") parsed.settings = value;
				else parsed.cwd = value;
				index += 1;
				break;
			}
			default:
				throw new Error(`Unknown argument ${JSON.stringify(token)}.`);
		}
	}
	return parsed;
}

export interface CliDependencies {
	/** Provider extension the reviewer loads; production default is the MAIN checkout path. Tests inject a fixture. */
	anthropicProviderExtensionPath: string;
	/** Environment HOME; read explicitly (not os.homedir()) so a temporary HOME is honoured. */
	home: string | undefined;
	processCwd: string;
}

const defaultCliDependencies = (): CliDependencies => ({
	anthropicProviderExtensionPath: MAIN_ANTHROPIC_PROVIDER_EXTENSION,
	home: process.env.HOME,
	processCwd: process.cwd(),
});

export function main(argv: readonly string[] = process.argv.slice(2), log: (line: string) => void = console.log, deps: CliDependencies = defaultCliDependencies()): number {
	let args: CliArguments;
	try {
		args = parseCliArguments(argv);
	} catch (error) {
		log(`reviewer-setup: ${error instanceof Error ? error.message : String(error)}`);
		log(USAGE);
		return 2;
	}
	if (args.help) {
		log(USAGE);
		return 0;
	}
	try {
		if (!args.settings && !deps.home) throw new Error("HOME is unset; pass --settings <settings.json>.");
		const settingsPath = resolve(args.settings ?? join(deps.home!, ".pi", "agent", "settings.json"));
		const cwd = resolve(args.cwd ?? deps.processCwd);
		let cwdIsDirectory = false;
		try { cwdIsDirectory = statSync(cwd).isDirectory(); } catch { cwdIsDirectory = false; }
		if (!cwdIsDirectory) throw new Error(`--cwd ${cwd} is not an existing directory; the effective project settings cannot be determined.`);
		const projectPath = projectSettingsPath(cwd);
		const projectSettings = projectPath && existsSync(projectPath) ? (readSettingsFile(projectPath).parsed as JsonObject) : undefined;
		log(`Settings file: ${settingsPath}`);
		log(`Effective project settings: ${projectPath ?? "none"}${projectPath && !projectSettings ? " (absent)" : ""}`);
		const plan = installReviewerSettings(settingsPath, { apply: args.apply, projectSettings, anthropicProviderExtensionPath: deps.anthropicProviderExtensionPath });
		log(`${args.apply ? "Wrote" : "Would write"} ${plan.affectedKeys.length} keys:`);
		for (const key of plan.affectedKeys) log(`  ${key}`);
		log(args.apply ? "Done. Run /reload in Pi before new reviewer launches use it." : "Dry run only; rerun with --apply to write.");
		return 0;
	} catch (error) {
		log(`reviewer-setup: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (import.meta.main) process.exit(main());
