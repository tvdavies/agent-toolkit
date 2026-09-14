/**
 * `code-writer`: a native pi-subagents code-writing role with a human-editable
 * ordered model hierarchy, plus a session-scoped delegation-preferred routing
 * mode. Human slash commands confirmed through the trusted UI are the only
 * writers of configuration; there is no model-facing setter, launcher, or
 * runtime fork of native fallback.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CODE_WRITER_AGENT, formatHierarchyModel, hierarchyModels, type ModelHierarchy, parseHierarchy, splitHierarchyArguments } from "./hierarchy";
import { appendRoutingPolicy, readRoutingState, ROUTING_ENTRY, type RoutingState } from "./routing";
import {
	assertActivatable, type JsonObject, type ParentModel, planSettingsUpdate, projectSettingsPath, readSettingsFile,
	readStoredWriterConfig, type SettingsPlan, type StoredWriterConfig, updateSettingsFile,
} from "./settings";

export { CODE_WRITER_AGENT } from "./hierarchy";
export { ROUTING_ENTRY, ROUTING_MARKER } from "./routing";

export const ANTHROPIC_PROVIDER_EXTENSION_PATH = fileURLToPath(new URL("../anthropic-claude-code.ts", import.meta.url));
export const CODE_WRITER_AGENT_FILE = fileURLToPath(new URL("../../agents/code-writer.md", import.meta.url));

/** Documented example only; never written unless the human types it. */
export const EXAMPLE_HIERARCHY = "anthropic-claude-code/claude-fable-5-1 openai-codex/gpt-6-astra openai-codex/gpt-5.6-luna";

export const FALLBACK_LIMITS = [
	"Native fallback rotates to the next hierarchy model only for retryable provider failures (rate limit, quota, overload, unavailable model) before the child uses any tool.",
	"No automatic fallback after tool activity, on cancellation or deadline, on ordinary task/test failure, or for unsupported setups. Partial work stays in the worktree: inspect and preserve the diff, then issue an explicit continuation on a remaining model.",
	"A retained native resume keeps its original model; it is not cross-model continuation. Models on one provider often share a quota, so cross-provider backups are more useful than same-provider ones.",
];

export interface CodeWriterDependencies {
	settingsPath: () => string;
	/** Effective native project settings path for a cwd, or null when there is no project root. Throws on unsupported policy. */
	projectSettingsPath: (cwd: string) => string | null;
	anthropicProviderExtensionPath: string;
	agentFileExists: () => boolean;
	isChildProcess: () => boolean;
	now: () => number;
}

const defaults: CodeWriterDependencies = {
	settingsPath: () => join(getAgentDir(), "settings.json"),
	projectSettingsPath,
	anthropicProviderExtensionPath: ANTHROPIC_PROVIDER_EXTENSION_PATH,
	agentFileExists: () => existsSync(CODE_WRITER_AGENT_FILE),
	isChildProcess: () => process.env.PI_SUBAGENT_CHILD === "1",
	now: Date.now,
};

function registryModels(ctx: ExtensionContext): string[] | undefined {
	try {
		const models = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
		return models.length > 0 ? models : undefined;
	} catch {
		return undefined;
	}
}

function parentModel(ctx: ExtensionContext): ParentModel | undefined {
	const model = ctx.model;
	return model && typeof model.provider === "string" && typeof model.id === "string" && model.provider && model.id ? { provider: model.provider, id: model.id } : undefined;
}

function readProjectSettings(path: string | null): JsonObject | undefined {
	if (!path || !existsSync(path)) return undefined;
	return readSettingsFile(path).parsed as JsonObject;
}

export function describeStored(stored: StoredWriterConfig): string[] {
	const lines: string[] = [];
	if (!stored.model) {
		lines.push(`Stored hierarchy: none. Configure one with /code-writer models <provider/id[:thinking]> ... (example: ${EXAMPLE_HIERARCHY}).`);
	} else {
		const primary = stored.thinking ? `${stored.model}:${stored.thinking}` : stored.model;
		const fallbacks = stored.fallbackModels === false ? [] : (stored.fallbackModels ?? []);
		lines.push(`Stored hierarchy (user settings): ${[primary, ...fallbacks].map((model, index) => `${index + 1}. ${model}`).join("  ")}`);
		if (stored.fallbackModels === false) lines.push("Warning: fallbackModels is false, so no automatic fallback will happen.");
		if (stored.disabled) lines.push("Warning: the code-writer override is disabled.");
		if (stored.extensions === undefined) lines.push("Child extensions: packaged default (explicit empty list; built-in providers only, no ambient extensions). An anthropic-claude-code model needs the provider extension: rerun /code-writer models.");
		else if (stored.extensions === false) lines.push("Warning: extensions is false, which clears the explicit list and lets the writer load ambient extensions.");
		else lines.push(`Child extensions: ${stored.extensions.length === 0 ? "none (explicit empty list; built-in providers only)" : stored.extensions.join(", ")}`);
		lines.push(stored.agentAllow?.length
			? `Per-agent scope (${stored.agentEnforce ? (stored.agentStrict ? "enforce, strict" : "enforce") : "not enforced"}): ${stored.agentAllow.join(", ")}`
			: "Per-agent scope: none.");
	}
	if (stored.globalAllow?.length) lines.push(`Global scope (${stored.globalEnforce ? (stored.globalStrict ? "enforce, strict" : "enforce") : "not enforced"}): ${stored.globalAllow.join(", ")}${stored.globalAllow.includes("inherit") ? " ('inherit' resolves to the current parent model at launch)" : ""}`);
	if (stored.providerOverrideKeys.length > 0) lines.push(`Warning: provider-scoped overrides layer over the stored hierarchy when their provider is the parent's: ${stored.providerOverrideKeys.join(", ")}`);
	return lines;
}

/** Lines describing how effective project settings change the stored user configuration. */
export function describeProjectEffects(project: JsonObject | undefined, path: string | null): string[] {
	const lines: string[] = [];
	if (!path) { lines.push("Project settings: no native project root for this directory."); return lines; }
	lines.push(`Effective project settings: ${path}${project ? "" : " (absent)"}`);
	if (!project) return lines;
	const stored = readStoredWriterConfig(project, "project");
	const subagents = typeof project.subagents === "object" && project.subagents !== null ? (project.subagents as JsonObject) : undefined;
	const overrides = subagents && typeof subagents.agentOverrides === "object" && subagents.agentOverrides !== null ? (subagents.agentOverrides as JsonObject) : undefined;
	if (overrides && CODE_WRITER_AGENT in overrides) lines.push(`Effective: project subagents.agentOverrides.${CODE_WRITER_AGENT} wins over the stored user hierarchy.`);
	if (stored.providerOverrideKeys.length > 0) lines.push(`Effective: ${stored.providerOverrideKeys.join(", ")} layer over the writer when that provider is the parent's.`);
	if (subagents && subagents.modelScope !== undefined) {
		lines.push(stored.agentAllow?.length
			? `Effective: project subagents.modelScope replaces the user scope; its ${CODE_WRITER_AGENT} rule (${stored.agentEnforce ? (stored.agentStrict ? "enforce, strict" : "enforce") : "not enforced"}): ${stored.agentAllow.join(", ")}`
			: `Effective: project subagents.modelScope replaces the user scope and has no ${CODE_WRITER_AGENT} rule, so the stored per-agent restriction is not in effect here.`);
	}
	return lines;
}

/** Trusted-UI confirmation; fails closed when no UI is available or the human declines. */
async function confirmHuman(ctx: ExtensionCommandContext, title: string, body: string): Promise<void> {
	if (!ctx.hasUI) throw new Error("This command changes configuration and needs an interactive Pi session to confirm; refused without a UI.");
	const confirmed = await ctx.ui.confirm(title, body);
	if (!confirmed) throw new Error("Cancelled; nothing was changed.");
}

export default function codeWriterExtension(pi: ExtensionAPI, deps: CodeWriterDependencies = defaults): void {
	// A child session must never carry the parent's routing preference or register the human command.
	if (deps.isChildProcess()) return;

	let routing: RoutingState | undefined;
	const restore = (ctx: ExtensionContext) => { routing = readRoutingState(ctx.sessionManager.getBranch()); };

	// Rebuild from the active branch on every start (startup/new/fork/resume/reload) and after /tree navigation.
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("before_agent_start", (event) => ({
		systemPrompt: appendRoutingPolicy(event.systemPrompt, routing?.preferred === true),
	}));

	/** Read-only check that the configuration as stored/effective right now would launch the writer on its hierarchy. */
	function checkActivatable(ctx: ExtensionCommandContext) {
		return assertActivatable({
			userSettings: readSettingsFile(deps.settingsPath()).parsed,
			projectSettings: readProjectSettings(deps.projectSettingsPath(ctx.cwd)),
			anthropicProviderExtensionPath: deps.anthropicProviderExtensionPath,
			parentModel: parentModel(ctx),
		});
	}

	async function setRouting(preferred: boolean, ctx: ExtensionCommandContext): Promise<void> {
		const preview = preferred ? checkActivatable(ctx) : undefined;
		await confirmHuman(ctx, `Turn code-writer routing ${preferred ? "on" : "off"} for this session?`, preferred
			? [
				`Hierarchy in effect: ${hierarchyModels(preview!.hierarchy).map((entry, index) => `${index + 1}. ${formatHierarchyModel(entry)}`).join("  ")}`,
				...preview!.warnings.map((warning) => `Warning: ${warning}`),
				"The parent will be asked to route code/test edits to the code-writer subagent. This is prompt policy, not a sandbox; your own tools remain available.",
			].join("\n")
			: "The routing preference is removed for this session.");
		// Configuration may have changed while the dialog was open: re-check the real files before recording anything.
		if (preferred) checkActivatable(ctx);
		routing = { preferred, changedAt: deps.now() };
		pi.appendEntry(ROUTING_ENTRY, routing);
		ctx.ui.notify(preferred
			? "code-writer routing preferred for this session. The parent is asked to route code/test edits to the code-writer subagent; this is prompt policy, not a sandbox, and your own tools remain available."
			: "code-writer routing off for this session.", "info");
	}

	function status(ctx: ExtensionCommandContext): void {
		const lines: string[] = [];
		lines.push(`Session routing: ${routing?.preferred ? "preferred (parent asked to delegate code/test edits)" : "off"}.`);
		lines.push(`Agent definition: ${deps.agentFileExists() ? "packaged" : "missing (run scripts/sync.sh and /reload)"}.`);
		try {
			lines.push(...describeStored(readStoredWriterConfig(readSettingsFile(deps.settingsPath()).parsed)));
		} catch (error) {
			lines.push(`Stored configuration unreadable: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			const path = deps.projectSettingsPath(ctx.cwd);
			lines.push(...describeProjectEffects(readProjectSettings(path), path));
		} catch (error) {
			lines.push(`Project settings unusable: ${error instanceof Error ? error.message : String(error)}`);
		}
		lines.push("Settings changes apply to future child launches after /reload; running children and the parent model are unaffected.");
		lines.push(...FALLBACK_LIMITS);
		ctx.ui.notify(lines.join("\n"), "info");
	}

	async function configure(hierarchy: ModelHierarchy, ctx: ExtensionCommandContext): Promise<void> {
		const options = () => ({
			anthropicProviderExtensionPath: deps.anthropicProviderExtensionPath,
			registryModels: registryModels(ctx),
			projectSettings: readProjectSettings(deps.projectSettingsPath(ctx.cwd)),
			parentModel: parentModel(ctx),
		});
		const path = deps.settingsPath();
		// Preview only: validated against a snapshot for display, then recomputed under the lock before writing.
		const preview = planSettingsUpdate(readSettingsFile(path).parsed, hierarchy, options());
		const ordered = hierarchyModels(hierarchy).map((entry, index) => `${index + 1}. ${formatHierarchyModel(entry)}`).join("  ");
		await confirmHuman(ctx, "Write the code-writer model hierarchy?", [
			`File: ${path}`,
			`Hierarchy: ${ordered}`,
			`Per-agent strict scope: ${preview.agentScope.allow.join(", ")}`,
			preview.extensions.length > 0 ? `Child extensions: ${preview.extensions.join(", ")}` : "Child extensions: none (built-in providers only).",
			...preview.warnings.map((warning) => `Warning: ${warning}`),
		].join("\n"));
		const result = updateSettingsFile<SettingsPlan>(path, (file) => planSettingsUpdate(file.parsed, hierarchy, options()));
		const plan = result.plan;
		const summary = [
			`Wrote code-writer hierarchy to ${result.written}: ${ordered}`,
			`Per-agent strict scope: ${plan.agentScope.allow.join(", ")}`,
			plan.extensions.length > 0 ? `Child extensions: ${plan.extensions.join(", ")}` : "Child extensions: none (explicit empty list; built-in providers only).",
			...plan.warnings.map((warning) => `Warning: ${warning}`),
			"Run /reload so new code-writer launches use this hierarchy. Existing runs and the parent model are unchanged.",
			...FALLBACK_LIMITS,
		];
		ctx.ui.notify(summary.join("\n"), plan.warnings.length > 0 ? "warning" : "info");
	}

	pi.registerCommand("code-writer", {
		description: "code-writer role: status | on | off | models <provider/id[:thinking]> ... (confirmed in the UI)",
		getArgumentCompletions: (prefix) => {
			const items = ["status", "on", "off", "models"].filter((item) => item.startsWith(prefix)).map((item) => ({ value: item, label: item }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				switch (action) {
					case "status":
						status(ctx);
						return;
					case "on":
						if (!readStoredWriterConfig(readSettingsFile(deps.settingsPath()).parsed).model) {
							ctx.ui.notify(`No code-writer hierarchy is configured; refusing to enable routing. Configure one first: /code-writer models ${EXAMPLE_HIERARCHY}`, "warning");
							return;
						}
						await setRouting(true, ctx);
						return;
					case "off":
						await setRouting(false, ctx);
						return;
					case "models": {
						if (rest.length === 0) {
							ctx.ui.notify(`Usage: /code-writer models <provider/id[:thinking]> ... (ordered; example: ${EXAMPLE_HIERARCHY})`, "warning");
							return;
						}
						await configure(parseHierarchy(splitHierarchyArguments(rest.join(" "))), ctx);
						return;
					}
					default:
						ctx.ui.notify("Usage: /code-writer [status|on|off|models <provider/id[:thinking]> ...]", "warning");
				}
			} catch (error) {
				ctx.ui.notify(`code-writer: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
