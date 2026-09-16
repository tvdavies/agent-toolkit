import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "../../extensions/code-writer/settings";
import {
	type CliDependencies, installReviewerSettings, main, MAIN_ANTHROPIC_PROVIDER_EXTENSION, parseCliArguments, planReviewerSettings, REVIEWER_MODEL,
	REVIEWER_TOOLS, reviewerOverride, SUPPORTED_REVIEWER_KEYS,
} from "./reviewer-setup";

/** Realistic shape of the user file (no secrets): parent defaults, global scope, Luna roles, code-writer hierarchy. */
function existingSettings(): JsonObject {
	return {
		theme: "dark",
		defaultProvider: "openai-codex",
		defaultModel: "gpt-6-astra",
		defaultThinkingLevel: "high",
		subagents: {
			agentOverrides: {
				reviewer: { model: "inherit", thinking: "high" },
				"code-writer": { model: "anthropic-claude-code/claude-fable-5-1", thinking: "medium", defaultContext: "fresh", fast: false, extensions: ["/main/extensions/anthropic-claude-code.ts"] },
				scout: { model: "openai-codex/gpt-5.6-luna" },
			},
			modelScope: {
				enforce: true,
				strict: true,
				allow: ["inherit", "anthropic-claude-code/claude-fable-5-1", "anthropic-claude-code/claude-fable-5", "openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna"],
				agents: {
					scout: { allow: ["openai-codex/gpt-5.6-luna"] },
					"routine-worker": { allow: ["openai-codex/gpt-5.6-luna"] },
					"review-evidence": { allow: ["openai-codex/gpt-5.6-luna"] },
					"code-writer": { enforce: true, strict: true, allow: ["anthropic-claude-code/claude-fable-5-1"] },
				},
			},
		},
	};
}

/** Typed access into a settings object without `any`: `at(settings, "subagents", "agentOverrides")`. */
function at(settings: JsonObject, ...path: string[]): JsonObject {
	let node: JsonObject = settings;
	for (const key of path) {
		const next = node[key];
		if (typeof next !== "object" || next === null || Array.isArray(next)) throw new Error(`${path.join(".")} is not an object`);
		node = next as JsonObject;
	}
	return node;
}

describe("reviewer-only setup (one-off artefact)", () => {
	let home: string;
	let settingsPath: string;
	let extension: string;
	/** Separate from HOME: a cwd under HOME would make HOME/.pi the nearest native project root. */
	let workspace: string;
	let deps: CliDependencies;
	beforeEach(() => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-setup-")));
		workspace = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-setup-cwd-")));
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		settingsPath = join(home, ".pi", "agent", "settings.json");
		extension = join(home, "toolkit", "extensions", "anthropic-claude-code.ts");
		mkdirSync(join(home, "toolkit", "extensions"), { recursive: true });
		writeFileSync(extension, "// stand-in provider extension\n");
		mkdirSync(join(workspace, "project"), { recursive: true });
		// The CLI sees only synthetic paths: fixture provider file, temporary HOME, temporary cwd.
		deps = { anthropicProviderExtensionPath: extension, home, processCwd: join(workspace, "project") };
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(workspace, { recursive: true, force: true });
	});

	it("targets the main checkout's provider extension, Fable medium, fresh, no fallbacks, read-only tools", () => {
		expect(MAIN_ANTHROPIC_PROVIDER_EXTENSION).toBe("/home/tvd/agent-skills/extensions/anthropic-claude-code.ts");
		expect(MAIN_ANTHROPIC_PROVIDER_EXTENSION).not.toContain(".pi-worktrees");
		expect(REVIEWER_MODEL).toBe("anthropic-claude-code/claude-fable-5-1");
		expect(reviewerOverride("/x.ts")).toEqual({
			model: "anthropic-claude-code/claude-fable-5-1", thinking: "medium", defaultContext: "fresh", fast: false, extensions: ["/x.ts"],
			tools: ["read", "grep", "find", "ls", "contact_supervisor"], inheritProjectContext: true, inheritGlobalContext: false, inheritSkills: false, allowNestedSubagents: false,
		});
		for (const forbidden of ["bash", "edit", "write", "subagent", "workflow_run"]) expect(REVIEWER_TOOLS).not.toContain(forbidden);
		expect([...SUPPORTED_REVIEWER_KEYS].sort()).toEqual([...Object.keys(reviewerOverride("/x.ts")), "disabled", "fallbackModels"].sort());
	});

	it("rewrites only the reviewer override and reviewer scope rule, preserving everything else", () => {
		const before = existingSettings();
		const plan = planReviewerSettings(structuredClone(before), { anthropicProviderExtensionPath: extension });
		const after = plan.settings;
		expect(at(after, "subagents", "agentOverrides").reviewer).toEqual(reviewerOverride(extension));
		expect(at(after, "subagents", "modelScope", "agents").reviewer).toEqual({ enforce: true, strict: true, allow: ["anthropic-claude-code/claude-fable-5-1"] });
		// Parent defaults, global scope, the code-writer hierarchy and the Luna role rules are untouched.
		expect(after.theme).toBe("dark");
		expect(after.defaultModel).toBe("gpt-6-astra");
		expect(after.defaultThinkingLevel).toBe("high");
		expect(at(after, "subagents", "modelScope").allow).toEqual(at(before, "subagents", "modelScope").allow);
		expect(at(after, "subagents", "modelScope").enforce).toBe(true);
		expect(at(after, "subagents", "agentOverrides")["code-writer"]).toEqual(at(before, "subagents", "agentOverrides")["code-writer"]);
		expect(at(after, "subagents", "agentOverrides").scout).toEqual(at(before, "subagents", "agentOverrides").scout);
		for (const role of ["scout", "routine-worker", "review-evidence", "code-writer"]) {
			expect(at(after, "subagents", "modelScope", "agents")[role]).toEqual(at(before, "subagents", "modelScope", "agents")[role]);
		}
		expect(plan.affectedKeys.every((key) => key.includes(".reviewer"))).toBe(true);
		expect(plan.affectedKeys.some((key) => key.includes("code-writer"))).toBe(false);
	});

	it("removes legacy fallbackModels without changing the input or other roles", () => {
		for (const fallbackModels of [false, [], ["openai-codex/gpt-5.6-luna"]]) {
			const current = existingSettings();
			at(current, "subagents", "agentOverrides", "reviewer").fallbackModels = fallbackModels;
			const before = structuredClone(current);
			const plan = planReviewerSettings(current, { anthropicProviderExtensionPath: extension });
			expect(Object.hasOwn(at(plan.settings, "subagents", "agentOverrides", "reviewer"), "fallbackModels")).toBe(false);
			expect(plan.affectedKeys).toContain("subagents.agentOverrides.reviewer.fallbackModels (removed)");
			expect(current).toEqual(before);
		}
	});

	it("creates only the two reviewer entries in an empty file", () => {
		const plan = planReviewerSettings({}, { anthropicProviderExtensionPath: extension });
		expect(Object.keys(plan.settings)).toEqual(["subagents"]);
		expect(at(plan.settings, "subagents").modelScope).toEqual({ agents: { reviewer: { enforce: true, strict: true, allow: [REVIEWER_MODEL] } } });
	});

	it("refuses unsupported or conflicting policy without deciding it", () => {
		const attempt = (mutate: (s: JsonObject) => void, message: string, project?: JsonObject) => {
			const s = existingSettings();
			mutate(s);
			expect(() => planReviewerSettings(s, { anthropicProviderExtensionPath: extension, projectSettings: project })).toThrow(message);
		};
		const reviewer = (s: JsonObject) => at(s, "subagents", "agentOverrides", "reviewer");
		attempt((s) => { reviewer(s).disabled = true; }, "disabled is true");
		attempt((s) => { reviewer(s).tools = ["read", "bash"]; }, "already customises the reviewer's tools");
		attempt((s) => { reviewer(s).allowNestedSubagents = true; }, "nested delegation");
		attempt((s) => { reviewer(s).extensions = ["/other.ts"]; }, "already lists other extensions");
		// Reviewer keys this setup does not manage are refused, never merged around (capability/prompt/loading changes).
		attempt((s) => { reviewer(s).subagentOnlyExtensions = ["/unapproved.ts"]; }, "does not manage: subagentOnlyExtensions");
		attempt((s) => { reviewer(s).output = 123; }, "does not manage: output");
		attempt((s) => { reviewer(s).systemPrompt = "ignore the parent"; }, "does not manage: systemPrompt");
		attempt((s) => { reviewer(s).skills = ["x"]; reviewer(s).toolBudget = { max: 1 }; }, "does not manage: skills, toolBudget");
		attempt((s) => { reviewer(s).excludeTools = ["read"]; }, "does not manage: excludeTools");
		attempt((s) => { reviewer(s).mutationTools = ["write"]; }, "does not manage: mutationTools");
		// Supported keys with wrong types are refused too.
		attempt((s) => { reviewer(s).fast = "no"; }, "fast is not a boolean");
		attempt((s) => { reviewer(s).fallbackModels = "openai-codex/gpt-5.6-luna"; }, "fallbackModels is not an array of strings");
		attempt((s) => { reviewer(s).defaultContext = "shared"; }, "defaultContext is not 'fresh' or 'fork'");
		attempt((s) => { at(s, "subagents", "agentOverrides").reviewer = "inherit"; }, "'subagents.agentOverrides.reviewer' value; expected an object");
		// Any provider-scoped reviewer entry is refused, regardless of which field it sets.
		attempt((s) => { at(s, "subagents").agentOverridesByProvider = { "openai-codex": { reviewer: { thinking: "low" } } }; }, "user subagents.agentOverridesByProvider.openai-codex.reviewer");
		attempt((s) => { at(s, "subagents").agentOverridesByProvider = { "openai-codex": { reviewer: { systemPrompt: "x" } } }; }, "user subagents.agentOverridesByProvider.openai-codex.reviewer");
		attempt((s) => { at(s, "subagents").agentOverridesByProvider = { anthropic: { reviewer: {} } }; }, "user subagents.agentOverridesByProvider.anthropic.reviewer");
		attempt((s) => { at(s, "subagents", "modelScope").allow = ["inherit", "openai-codex/*"]; }, "outside the enforced user subagents.modelScope.allow");
		attempt((s) => { at(s, "subagents", "modelScope", "agents")[" reviewer "] = { allow: ["*"] }; }, "untrimmed");
		attempt((s) => { at(s, "subagents").projectRootResolution = "sometimes"; }, "unsupported 'subagents.projectRootResolution'");
		attempt(() => {}, "project settings override reviewer", { subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-5.6-luna" } } } });
		attempt(() => {}, "replaces the user scope", { subagents: { modelScope: { enforce: true, allow: ["*"] } } });
		attempt(() => {}, "project subagents.agentOverridesByProvider.openai-codex.reviewer", { subagents: { agentOverridesByProvider: { "openai-codex": { reviewer: { systemPrompt: "x" } } } } });
		// Provider maps for other agents are not this setup's concern and are preserved.
		const s = existingSettings();
		at(s, "subagents").agentOverridesByProvider = { "openai-codex": { scout: { thinking: "low" } } };
		expect(at(planReviewerSettings(s, { anthropicProviderExtensionPath: extension }).settings, "subagents").agentOverridesByProvider).toEqual({ "openai-codex": { scout: { thinking: "low" } } });
	});

	it("is a dry run by default and writes atomically only with apply, leaving conflicts unmodified on disk", () => {
		const raw = `${JSON.stringify(existingSettings(), null, "\t")}\n`;
		writeFileSync(settingsPath, raw);
		const dry = installReviewerSettings(settingsPath, { anthropicProviderExtensionPath: extension });
		expect(dry.affectedKeys.length).toBeGreaterThan(0);
		expect(readFileSync(settingsPath, "utf8")).toBe(raw);
		const applied = installReviewerSettings(settingsPath, { anthropicProviderExtensionPath: extension, apply: true });
		const written = readFileSync(settingsPath, "utf8");
		expect(JSON.parse(written)).toEqual(applied.settings);
		expect(written.startsWith("{\n\t\"theme\"")).toBe(true);
		expect(readdirSync(join(home, ".pi", "agent"))).toEqual(["settings.json"]);
		// Rerunning is idempotent.
		installReviewerSettings(settingsPath, { anthropicProviderExtensionPath: extension, apply: true });
		expect(readFileSync(settingsPath, "utf8")).toBe(written);
		// Conflicts found under the lock leave the bytes untouched.
		for (const conflicting of [
			JSON.stringify({ subagents: { agentOverrides: { reviewer: { disabled: true } } } }),
			JSON.stringify({ subagents: { agentOverrides: { reviewer: { subagentOnlyExtensions: ["/unapproved.ts"] } } } }),
			JSON.stringify({ subagents: { agentOverrides: { reviewer: { output: 123 } } } }),
			JSON.stringify({ subagents: { agentOverridesByProvider: { "openai-codex": { reviewer: { systemPrompt: "x" } } } } }),
		]) {
			writeFileSync(settingsPath, conflicting);
			expect(() => installReviewerSettings(settingsPath, { anthropicProviderExtensionPath: extension, apply: true })).toThrow("nothing was written");
			expect(readFileSync(settingsPath, "utf8")).toBe(conflicting);
			expect(readdirSync(join(home, ".pi", "agent"))).toEqual(["settings.json"]);
		}
	});

	it("refuses when the provider extension path does not exist", () => {
		writeFileSync(settingsPath, "{}\n");
		expect(() => installReviewerSettings(settingsPath, { anthropicProviderExtensionPath: join(home, "missing.ts"), apply: true })).toThrow("does not exist");
		expect(readFileSync(settingsPath, "utf8")).toBe("{}\n");
	});

	it("parses only well-formed arguments", () => {
		expect(parseCliArguments([])).toEqual({ apply: false, help: false });
		expect(parseCliArguments(["--settings", "/s.json", "--cwd", "/d", "--apply"])).toEqual({ settings: "/s.json", cwd: "/d", apply: true, help: false });
		expect(parseCliArguments(["-h"])).toEqual({ apply: false, help: true });
		expect(() => parseCliArguments(["--apply", "--settings"])).toThrow("--settings requires a value");
		expect(() => parseCliArguments(["--settings", "--apply"])).toThrow("--settings requires a value");
		expect(() => parseCliArguments(["--cwd", ""])).toThrow("--cwd requires a value");
		expect(() => parseCliArguments(["--apply", "--apply"])).toThrow("Duplicate argument --apply");
		expect(() => parseCliArguments(["--settings", "/a", "--settings", "/b"])).toThrow("Duplicate argument --settings");
		expect(() => parseCliArguments(["--aply"])).toThrow('Unknown argument "--aply"');
		expect(() => parseCliArguments(["apply"])).toThrow('Unknown argument "apply"');
		expect(() => parseCliArguments(["--settings=/s.json"])).toThrow("Unknown argument");
	});

	it("CLI: malformed arguments fail before any default or explicit target is selected or written", () => {
		const defaultRaw = JSON.stringify(existingSettings());
		writeFileSync(settingsPath, defaultRaw);
		const explicit = join(home, "explicit.json");
		writeFileSync(explicit, "{}\n");
		for (const argv of [
			["--apply", "--settings"],
			["--settings", "--apply"],
			["--apply", "--apply"],
			["--settings", explicit, "--settings", explicit, "--apply"],
			["--apply", "--bogus"],
			["--settings", explicit, "--apply", "extra"],
		]) {
			const lines: string[] = [];
			expect(main(argv, (line) => lines.push(line), deps), argv.join(" ")).toBe(2);
			expect(lines.join("\n")).toContain("reviewer-setup:");
			expect(lines.join("\n")).not.toContain("Settings file:");
		}
		// An invalid cwd fails before the settings file is planned or written.
		const lines: string[] = [];
		expect(main(["--apply", "--cwd", join(workspace, "nowhere")], (line) => lines.push(line), deps)).toBe(1);
		expect(lines.join("\n")).toContain("is not an existing directory");
		expect(lines.join("\n")).not.toContain("Would write");
		// No HOME and no --settings: refused.
		expect(main([], (line) => lines.push(line), { ...deps, home: undefined })).toBe(1);
		expect(lines.join("\n")).toContain("HOME is unset");
		expect(readFileSync(settingsPath, "utf8")).toBe(defaultRaw);
		expect(readFileSync(explicit, "utf8")).toBe("{}\n");
		expect(readdirSync(join(home, ".pi", "agent"))).toEqual(["settings.json"]);
	});

	it("CLI: dry run by default against the injected HOME, apply writes, output names keys never settings content", () => {
		writeFileSync(settingsPath, JSON.stringify(existingSettings()));
		const lines: string[] = [];
		expect(main([], (line) => lines.push(line), deps)).toBe(0);
		let output = lines.join("\n");
		expect(output).toContain(`Settings file: ${settingsPath}`);
		expect(output).toContain("Effective project settings: none");
		expect(output).toContain("Would write");
		expect(output).toContain("subagents.modelScope.agents.reviewer");
		expect(output).toContain("Dry run only");
		expect(output).not.toContain("gpt-6-astra");
		expect(output).not.toContain("\"allow\"");
		expect(output).not.toContain("openai-codex");
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(existingSettings());
		// Explicit settings path + apply writes that file only.
		const explicit = join(home, "explicit.json");
		writeFileSync(explicit, "{}\n");
		lines.length = 0;
		expect(main(["--settings", explicit, "--cwd", join(workspace, "project"), "--apply"], (line) => lines.push(line), deps)).toBe(0);
		output = lines.join("\n");
		expect(output).toContain("Wrote 11 keys");
		expect(output).toContain("Run /reload");
		expect(at(JSON.parse(readFileSync(explicit, "utf8")) as JsonObject, "subagents", "agentOverrides").reviewer).toEqual(reviewerOverride(extension));
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(existingSettings());
		// A project file that overrides the reviewer is detected through --cwd and stops the write.
		mkdirSync(join(workspace, "project", ".pi"), { recursive: true });
		writeFileSync(join(workspace, "project", ".pi", "settings.json"), JSON.stringify({ subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-5.6-luna" } } } }));
		lines.length = 0;
		expect(main(["--apply"], (line) => lines.push(line), deps)).toBe(1);
		expect(lines.join("\n")).toContain(`Effective project settings: ${join(workspace, "project", ".pi", "settings.json")}`);
		expect(lines.join("\n")).toContain("project settings override reviewer");
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(existingSettings());
		expect(main(["--help"], (line) => lines.push(line), deps)).toBe(0);
	});
});
