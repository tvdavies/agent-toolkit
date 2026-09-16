/**
 * Pure parsing of the human-supplied ordered model hierarchy for the
 * `code-writer` role. Legacy lists remain parseable for diagnostics and scope
 * checks, but the settings planner rejects multiple entries on native 0.68+.
 */

export const CODE_WRITER_AGENT = "code-writer";
export const MAX_HIERARCHY_MODELS = 6;

/** Thinking suffixes accepted by native pi-subagents 0.66.0 (`docs/models.md`, thinking ceiling). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface HierarchyModel {
	/** Canonical `provider/id` without a thinking suffix. */
	model: string;
	provider: string;
	id: string;
	thinking?: ThinkingLevel;
}

export interface ModelHierarchy {
	primary: HierarchyModel;
	fallbacks: HierarchyModel[];
}

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Parse one `provider/id[:thinking]` token. Bare ids and glob patterns are rejected on purpose. */
export function parseHierarchyModel(token: string): HierarchyModel {
	const raw = token.trim();
	if (!raw) throw new Error("Empty model entry.");
	if (raw.length > 120) throw new Error(`Model entry is too long: ${raw.slice(0, 40)}…`);
	if (raw.includes("*")) throw new Error(`Model '${raw}' must be an exact provider/id, not a pattern.`);
	const slash = raw.indexOf("/");
	if (slash <= 0) throw new Error(`Model '${raw}' must be fully qualified as provider/id (for example openai-codex/gpt-6-astra).`);
	const provider = raw.slice(0, slash);
	let rest = raw.slice(slash + 1);
	let thinking: ThinkingLevel | undefined;
	const colon = rest.lastIndexOf(":");
	if (colon !== -1) {
		const suffix = rest.slice(colon + 1);
		if (!isThinkingLevel(suffix)) throw new Error(`Model '${raw}' has an unsupported thinking suffix ':${suffix}'. Use one of ${THINKING_LEVELS.join(", ")}.`);
		thinking = suffix;
		rest = rest.slice(0, colon);
	}
	if (!PROVIDER_PATTERN.test(provider)) throw new Error(`Model '${raw}' has an invalid provider '${provider}'.`);
	if (!MODEL_ID_PATTERN.test(rest)) throw new Error(`Model '${raw}' has an invalid model id '${rest}'.`);
	if (provider === "inherit" || rest === "inherit") throw new Error("The code-writer hierarchy must name concrete models; 'inherit' is not allowed.");
	return { model: `${provider}/${rest}`, provider, id: rest, ...(thinking ? { thinking } : {}) };
}

/** Parse an ordered, bounded, de-duplicated hierarchy from command arguments. */
export function parseHierarchy(tokens: readonly string[]): ModelHierarchy {
	const entries = tokens.map((token) => token.trim()).filter(Boolean);
	if (entries.length === 0) throw new Error("Provide at least one model as provider/id[:thinking].");
	if (entries.length > MAX_HIERARCHY_MODELS) throw new Error(`Provide at most ${MAX_HIERARCHY_MODELS} models in the hierarchy.`);
	const seen = new Set<string>();
	const models: HierarchyModel[] = [];
	for (const entry of entries) {
		const parsed = parseHierarchyModel(entry);
		const key = parsed.model.toLowerCase();
		if (seen.has(key)) throw new Error(`Model '${parsed.model}' appears more than once; each hierarchy entry must be unique.`);
		seen.add(key);
		models.push(parsed);
	}
	const [primary, ...fallbacks] = models;
	if (!primary) throw new Error("Provide at least one model as provider/id[:thinking].");
	return { primary, fallbacks };
}

/** Render a model as native pi-subagents expects it: `provider/id` plus an optional `:thinking` suffix. */
export function formatHierarchyModel(entry: HierarchyModel): string {
	return entry.thinking ? `${entry.model}:${entry.thinking}` : entry.model;
}

export function hierarchyModels(hierarchy: ModelHierarchy): HierarchyModel[] {
	return [hierarchy.primary, ...hierarchy.fallbacks];
}

/** Split command arguments on whitespace and commas so both `a b` and `a, b` work. */
export function splitHierarchyArguments(args: string): string[] {
	return args.split(/[\s,]+/).map((token) => token.trim()).filter(Boolean);
}

/**
 * Same matching rule as native `modelScope.allow`: only `*` is special and the
 * comparison is case-insensitive against `provider/id`. `inherit` never
 * matches here because configuration time has no launch-time parent model.
 */
export function matchesScopePattern(model: string, pattern: string): boolean {
	if (pattern === "inherit") return false;
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i").test(model);
}
