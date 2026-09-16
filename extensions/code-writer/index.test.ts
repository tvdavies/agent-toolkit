import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codeWriterExtension, { ANTHROPIC_PROVIDER_EXTENSION_PATH, CODE_WRITER_AGENT_FILE, describeStored, EXAMPLE_HIERARCHY, ROUTING_ENTRY, ROUTING_MARKER } from "./index";
import { appendRoutingPolicy, readRoutingState, ROUTING_ADDENDUM, ROUTING_ROLES } from "./routing";
import { parseHierarchy } from "./hierarchy";
import { projectSettingsPath } from "./settings";
import { appendDelegationPolicy } from "../delegation-policy/index";

type Entry = { type: string; customType?: string; data?: unknown };
type Handler = (event: any, ctx: any) => unknown;

interface Options {
	child?: boolean;
	/** Entries of the active branch. */
	branch?: Entry[];
	/** Entries of other branches, visible through getEntries() only. */
	otherBranches?: Entry[];
	registry?: string[];
	projectSettings?: unknown;
	cwd?: string;
	hasUI?: boolean;
	confirm?: boolean | (() => boolean);
	parentModel?: { provider: string; id: string } | undefined;
}

function harness(home: string, options: Options = {}) {
	const hooks: Record<string, Handler> = {};
	const commands: Record<string, (args: string, ctx: any) => Promise<void>> = {};
	const notices: { text: string; level: string }[] = [];
	const dialogs: { title: string; body: string }[] = [];
	const branch: Entry[] = [...(options.branch ?? [])];
	const other: Entry[] = [...(options.otherBranches ?? [])];
	const cwd = options.cwd ?? join(home, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	if (options.projectSettings !== undefined) writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(options.projectSettings));
	const pi = {
		on(event: string, handler: Handler) { hooks[event] = handler; },
		registerCommand(name: string, value: { handler: (args: string, ctx: any) => Promise<void> }) { commands[name] = value.handler; },
		appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
	};
	const ctx = {
		cwd,
		hasUI: options.hasUI ?? true,
		isIdle: () => true,
		model: "parentModel" in options ? options.parentModel : { provider: "openai-codex", id: "gpt-6-astra" },
		sessionManager: { getBranch: () => branch, getEntries: () => [...other, ...branch] },
		modelRegistry: { getAvailable: () => (options.registry ?? ["anthropic-claude-code/claude-fable-5-1", "openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"]).map((full) => { const [provider, ...rest] = full.split("/"); return { provider, id: rest.join("/") }; }) },
		ui: {
			notify: (text: string, level = "info") => notices.push({ text, level }),
			confirm: async (title: string, body: string) => { dialogs.push({ title, body }); const c = options.confirm ?? true; return typeof c === "function" ? c() : c; },
		},
	};
	const settingsPath = join(home, ".pi", "agent", "settings.json");
	codeWriterExtension(pi as never, {
		settingsPath: () => settingsPath,
		projectSettingsPath,
		anthropicProviderExtensionPath: "/toolkit/extensions/anthropic-claude-code.ts",
		agentFileExists: () => true,
		isChildProcess: () => options.child ?? false,
		now: () => 1_700_000_000_000,
	});
	return {
		hooks, commands, notices, dialogs, branch, settingsPath, ctx, cwd,
		start: (reason = "startup") => hooks.session_start?.({ reason }, ctx),
		tree: () => hooks.session_tree?.({ newLeafId: "x", oldLeafId: "y" }, ctx),
		prompt: (systemPrompt = "BASE") => (hooks.before_agent_start?.({ prompt: "", systemPrompt }, ctx) as { systemPrompt: string }).systemPrompt,
		run: (args: string) => commands["code-writer"]!(args, ctx),
		last: () => notices.at(-1),
	};
}

const EXPECTED_WRITE = {
	subagents: {
		agentOverrides: { "code-writer": { model: "anthropic-claude-code/claude-fable-5-1", fallbackModels: ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna:low"], defaultContext: "fresh", fast: false, extensions: ["/toolkit/extensions/anthropic-claude-code.ts"] } },
		modelScope: { agents: { "code-writer": { enforce: true, strict: true, allow: ["anthropic-claude-code/claude-fable-5-1", "openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna"] } } },
	},
};

describe("code-writer extension", () => {
	let home: string;
	/** Temporary canary standing in for a real home settings file: it must never change. */
	let canary: string;
	const CANARY = '{"theme":"canary"}\n';
	beforeEach(() => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "code-writer-ext-")));
		canary = join(home, "canary-home", ".pi", "agent", "settings.json");
		mkdirSync(join(home, "canary-home", ".pi", "agent"), { recursive: true });
		writeFileSync(canary, CANARY);
	});
	afterEach(() => {
		expect(readFileSync(canary, "utf8")).toBe(CANARY);
		rmSync(home, { recursive: true, force: true });
	});

	it("registers nothing inside a subagent child process", () => {
		const h = harness(home, { child: true });
		expect(Object.keys(h.hooks)).toEqual([]);
		expect(Object.keys(h.commands)).toEqual([]);
	});

	it("resolves the owned provider extension and packaged agent relative to the toolkit", () => {
		expect(ANTHROPIC_PROVIDER_EXTENSION_PATH.endsWith("/extensions/anthropic-claude-code.ts")).toBe(true);
		expect(existsSync(ANTHROPIC_PROVIDER_EXTENSION_PATH)).toBe(true);
		expect(CODE_WRITER_AGENT_FILE.endsWith("/agents/code-writer.md")).toBe(true);
		expect(existsSync(CODE_WRITER_AGENT_FILE)).toBe(true);
	});

	it("refuses to enable routing until a hierarchy is configured and never guesses one", async () => {
		const h = harness(home);
		h.start();
		await h.run("on");
		expect(h.last()?.level).toBe("warning");
		expect(h.last()?.text).toContain("No code-writer hierarchy is configured");
		expect(h.last()?.text).toContain(EXAMPLE_HIERARCHY);
		expect(h.dialogs).toEqual([]);
		expect(existsSync(h.settingsPath)).toBe(false);
		expect(h.branch).toEqual([]);
		expect(h.prompt()).toBe("BASE");
		await h.run("status");
		expect(h.last()?.text).toContain("Stored hierarchy: none");
		expect(h.last()?.text).toContain("Session routing: off");
		expect(h.last()?.text).toContain(`Effective project settings: ${join(h.cwd, ".pi", "settings.json")} (absent)`);
	});

	it("writes the ordered hierarchy after UI confirmation, then routes only after a confirmed on", async () => {
		const h = harness(home);
		h.start();
		await h.run("models anthropic-claude-code/claude-fable-5-1 openai-codex/gpt-6-astra, openai-codex/gpt-5.6-luna:low");
		expect(h.dialogs).toHaveLength(1);
		expect(h.dialogs[0]!.title).toContain("Write the code-writer model hierarchy?");
		expect(h.dialogs[0]!.body).toContain(h.settingsPath);
		expect(h.dialogs[0]!.body).toContain("1. anthropic-claude-code/claude-fable-5-1  2. openai-codex/gpt-6-astra  3. openai-codex/gpt-5.6-luna:low");
		expect(h.last()?.level).toBe("info");
		expect(h.last()?.text).toContain("Run /reload");
		expect(h.last()?.text).toContain("before the child uses any tool");
		expect(JSON.parse(readFileSync(h.settingsPath, "utf8"))).toEqual(EXPECTED_WRITE);
		expect(h.prompt()).toBe("BASE");
		await h.run("on");
		expect(h.dialogs).toHaveLength(2);
		expect(h.dialogs[1]!.title).toContain("routing on");
		expect(h.branch).toEqual([{ type: "custom", customType: ROUTING_ENTRY, data: { preferred: true, changedAt: 1_700_000_000_000 } }]);
		const prompt = h.prompt();
		expect(prompt).toContain(ROUTING_MARKER);
		expect(prompt).toContain('subagent({ agent: "code-writer"');
		expect(prompt).toContain("Do not pass a per-call `model`");
		expect(prompt).toContain("Never silently fall back to editing code yourself");
		expect(prompt).toContain("not a sandbox");
		await h.run("status");
		expect(h.last()?.text).toContain("Session routing: preferred");
		expect(h.last()?.text).toContain("Per-agent scope (enforce, strict): anthropic-claude-code/claude-fable-5-1, openai-codex/gpt-6-astra, openai-codex/gpt-5.6-luna");
		expect(h.last()?.text).toContain("No automatic fallback after tool activity");
		await h.run("off");
		expect(h.dialogs).toHaveLength(3);
		expect(h.prompt()).toBe("BASE");
	});

	it("refuses to enable routing when the current configuration would not launch the stored hierarchy", async () => {
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		const h = harness(home);
		h.start();
		const attempt = async (settings: unknown, fragment: string) => {
			const raw = JSON.stringify(settings);
			writeFileSync(h.settingsPath, raw);
			await h.run("on");
			expect(h.last()?.level, fragment).toBe("error");
			expect(h.last()?.text, fragment).toContain(fragment);
			expect(h.last()?.text).toContain("Routing is unchanged");
			expect(readFileSync(h.settingsPath, "utf8")).toBe(raw);
			expect(h.branch).toEqual([]);
			expect(h.prompt()).toBe("BASE");
		};
		const good = JSON.parse(JSON.stringify(EXPECTED_WRITE));
		const edited = (edit: (s: any) => void) => { const s = JSON.parse(JSON.stringify(good)); edit(s); return s; };
		await attempt(edited((s) => { s.subagents.agentOverrides["code-writer"].disabled = true; }), "disabled");
		await attempt(edited((s) => { s.subagents.agentOverridesByProvider = { "openai-codex": { "code-writer": { model: "openai-codex/gpt-5.6-luna" } } }; }), "user subagents.agentOverridesByProvider.openai-codex.code-writer.model");
		await attempt(edited((s) => { s.subagents.agentOverrides["code-writer"].extensions = []; }), "lacks the provider extension");
		await attempt(edited((s) => { delete s.subagents.modelScope.agents["code-writer"]; }), "rule is missing, not enforced strict");
		await attempt(edited((s) => { s.subagents.modelScope.agents[" code-writer "] = { allow: ["*"] }; }), "unique agent names after trimming");
		await attempt(edited((s) => { s.subagents.agentOverrides["code-writer"].inheritProjectContext = "yes"; }), "'subagents.agentOverrides.code-writer.inheritProjectContext'");
		await attempt(edited((s) => { s.subagents.modelScope.enforce = true; s.subagents.modelScope.allow = ["openai-codex/*"]; }), "outside the global scope");
		expect(h.dialogs).toEqual([]);
		// Ancestor project settings neutralising the scope, and an unsupported root policy.
		writeFileSync(h.settingsPath, JSON.stringify(good));
		writeFileSync(join(h.cwd, ".pi", "settings.json"), JSON.stringify({ subagents: { modelScope: { enforce: true, allow: ["*"] } } }));
		await h.run("on");
		expect(h.last()?.text).toContain("would be ineffective");
		writeFileSync(join(h.cwd, ".pi", "settings.json"), JSON.stringify({ subagents: { projectRootResolution: "sometimes" } }));
		await h.run("on");
		expect(h.last()?.text).toContain("unsupported 'subagents.projectRootResolution'");
		writeFileSync(join(h.cwd, ".pi", "settings.json"), JSON.stringify({ subagents: { agentOverrides: { "code-writer": { fallbackModels: false } } } }));
		await h.run("on");
		expect(h.last()?.text).toContain("project subagents.agentOverrides.code-writer.fallbackModels");
		expect(h.branch).toEqual([]);
		expect(h.dialogs).toEqual([]);
		// Valid again: the dialog shows the hierarchy in effect and the entry is appended.
		rmSync(join(h.cwd, ".pi", "settings.json"));
		await h.run("on");
		expect(h.dialogs).toHaveLength(1);
		expect(h.dialogs[0]!.body).toContain("Hierarchy in effect: 1. anthropic-claude-code/claude-fable-5-1  2. openai-codex/gpt-6-astra  3. openai-codex/gpt-5.6-luna:low");
		expect(h.branch).toHaveLength(1);
		expect(h.prompt()).toContain(ROUTING_MARKER);
		// off stays available as a confirmed opt-out even when the configuration has since broken.
		writeFileSync(h.settingsPath, "{ broken");
		await h.run("off");
		expect(h.dialogs).toHaveLength(2);
		expect(h.prompt()).toBe("BASE");
	});

	it("re-checks the real configuration after the routing dialog and preserves benign changes", async () => {
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		let duringDialog: () => void = () => {};
		const h = harness(home, { confirm: () => { duringDialog(); return true; } });
		writeFileSync(h.settingsPath, JSON.stringify(EXPECTED_WRITE));
		h.start();
		duringDialog = () => {
			const s = JSON.parse(readFileSync(h.settingsPath, "utf8"));
			s.subagents.agentOverrides["code-writer"].disabled = true;
			writeFileSync(h.settingsPath, JSON.stringify(s));
		};
		await h.run("on");
		expect(h.dialogs).toHaveLength(1);
		expect(h.last()?.level).toBe("error");
		expect(h.last()?.text).toContain("disabled");
		expect(h.branch).toEqual([]);
		expect(h.prompt()).toBe("BASE");
		// Unrelated benign change during the dialog does not block activation.
		writeFileSync(h.settingsPath, JSON.stringify(EXPECTED_WRITE));
		duringDialog = () => {
			const s = JSON.parse(readFileSync(h.settingsPath, "utf8"));
			s.theme = "light";
			writeFileSync(h.settingsPath, JSON.stringify(s));
		};
		await h.run("on");
		expect(h.last()?.level).toBe("info");
		expect(h.branch).toHaveLength(1);
		expect(JSON.parse(readFileSync(h.settingsPath, "utf8")).theme).toBe("light");
	});

	it("chains a second configuration on the first serialised result", async () => {
		const h = harness(home);
		h.start();
		await h.run("models anthropic-claude-code/claude-fable-5-1");
		expect(JSON.parse(readFileSync(h.settingsPath, "utf8")).subagents.modelScope.agents["code-writer"].allow).toEqual(["anthropic-claude-code/claude-fable-5-1"]);
		await h.run("models anthropic-claude-code/claude-fable-5-1 openai-codex/gpt-6-astra openai-codex/gpt-5.6-luna:low");
		expect(h.last()?.level).toBe("info");
		expect(JSON.parse(readFileSync(h.settingsPath, "utf8"))).toEqual(EXPECTED_WRITE);
		await h.run("models openai-codex/gpt-5.6-luna openai-codex/gpt-6-astra");
		expect(JSON.parse(readFileSync(h.settingsPath, "utf8")).subagents).toEqual({
			agentOverrides: { "code-writer": { model: "openai-codex/gpt-5.6-luna", fallbackModels: ["openai-codex/gpt-6-astra"], defaultContext: "fresh", fast: false, extensions: [] } },
			modelScope: { agents: { "code-writer": { enforce: true, strict: true, allow: ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-6-astra"] } } },
		});
	});

	it("fails closed without a UI or when the human declines, for settings and routing changes", async () => {
		const declined = harness(home, { confirm: false });
		declined.start();
		await declined.run("models openai-codex/gpt-6-astra");
		expect(declined.dialogs).toHaveLength(1);
		expect(declined.last()?.level).toBe("error");
		expect(declined.last()?.text).toContain("Cancelled; nothing was changed");
		expect(existsSync(declined.settingsPath)).toBe(false);
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(declined.settingsPath, JSON.stringify(EXPECTED_WRITE));
		await declined.run("on");
		expect(declined.last()?.text).toContain("Cancelled");
		expect(declined.branch).toEqual([]);
		expect(declined.prompt()).toBe("BASE");

		const headless = harness(home, { hasUI: false });
		headless.start();
		const before = readFileSync(headless.settingsPath, "utf8");
		await headless.run("models openai-codex/gpt-6-astra");
		expect(headless.dialogs).toEqual([]);
		expect(headless.last()?.text).toContain("refused without a UI");
		expect(readFileSync(headless.settingsPath, "utf8")).toBe(before);
		await headless.run("on");
		expect(headless.last()?.text).toContain("refused without a UI");
		expect(headless.branch).toEqual([]);
	});

	it("revalidates current state under the lock after the confirmation preview", async () => {
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		const h = harness(home, {
			confirm: () => {
				// The file changes while the dialog is open: now the global scope excludes Luna.
				writeFileSync(h.settingsPath, JSON.stringify({ subagents: { modelScope: { enforce: true, strict: true, allow: ["openai-codex/gpt-6-astra"] } } }));
				return true;
			},
		});
		h.start();
		await h.run("models openai-codex/gpt-6-astra openai-codex/gpt-5.6-luna");
		expect(h.dialogs).toHaveLength(1);
		expect(h.last()?.level).toBe("error");
		expect(h.last()?.text).toContain("widening the existing global subagents.modelScope");
		expect(JSON.parse(readFileSync(h.settingsPath, "utf8")).subagents.agentOverrides).toBeUndefined();
	});

	it("reports actionable errors and writes nothing when the registry, scope or provider maps reject the hierarchy", async () => {
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		const original = JSON.stringify({ subagents: { modelScope: { enforce: true, strict: true, allow: ["openai-codex/gpt-6-astra", "inherit"] } } });
		const h = harness(home, { parentModel: { provider: "openai-codex", id: "gpt-5.6-sol" } });
		writeFileSync(h.settingsPath, original);
		h.start();
		await h.run("models openai-codex/gpt-6-astra openai-codex/gpt-5.6-luna");
		expect(h.last()?.level).toBe("error");
		expect(h.last()?.text).toContain("widening the existing global subagents.modelScope");
		expect(h.dialogs).toEqual([]);
		expect(readFileSync(h.settingsPath, "utf8")).toBe(original);
		// inherit resolves to the parent model (Sol), so Sol is accepted without widening.
		await h.run("models openai-codex/gpt-6-astra openai-codex/gpt-5.6-sol");
		expect(h.last()?.level).toBe("info");
		expect(JSON.parse(readFileSync(h.settingsPath, "utf8")).subagents.modelScope.allow).toEqual(["openai-codex/gpt-6-astra", "inherit"]);
		await h.run("models openai-codex/gpt-7-unknown");
		expect(h.last()?.text).toContain("Not in this session's model registry");
		await h.run("models openai-codex/gpt-6-astra openai-codex/gpt-6-astra");
		expect(h.last()?.text).toContain("more than once");
		await h.run("models");
		expect(h.last()?.level).toBe("warning");
		expect(h.last()?.text).toContain("Usage");
		// Provider map conflict.
		const withMap = JSON.parse(readFileSync(h.settingsPath, "utf8"));
		withMap.subagents.agentOverridesByProvider = { "openai-codex": { "code-writer": { fallbackModels: false } } };
		writeFileSync(h.settingsPath, JSON.stringify(withMap));
		await h.run("models openai-codex/gpt-6-astra");
		expect(h.last()?.text).toContain("user subagents.agentOverridesByProvider.openai-codex.code-writer.fallbackModels");
		expect(JSON.parse(readFileSync(h.settingsPath, "utf8"))).toEqual(withMap);
		await h.run("status");
		expect(h.last()?.text).toContain("Warning: provider-scoped overrides layer over the stored hierarchy");
		expect(h.last()?.text).toContain("'inherit' resolves to the current parent model at launch");
	});

	it("refuses when no parent model can resolve an inherit-only global allow-list", async () => {
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		const h = harness(home, { parentModel: undefined });
		writeFileSync(h.settingsPath, JSON.stringify({ subagents: { modelScope: { enforce: true, allow: ["inherit"] } } }));
		h.start();
		await h.run("models openai-codex/gpt-6-astra");
		expect(h.last()?.text).toContain("no parent session model is available");
		expect(h.dialogs).toEqual([]);
	});

	it("distinguishes stored configuration from effective project overrides, provider maps and replacing scopes in status", async () => {
		const h = harness(home, { projectSettings: { subagents: { agentOverrides: { "code-writer": { model: "openai-codex/gpt-5.6-luna" } }, agentOverridesByProvider: { "openai-codex": { "code-writer": { thinking: "low" } } }, modelScope: { enforce: true, allow: ["*"] } } } });
		h.start();
		await h.run("models openai-codex/gpt-6-astra");
		expect(h.last()?.level).toBe("error");
		expect(h.last()?.text).toContain("project subagents.agentOverrides.code-writer.model");
		expect(h.dialogs).toEqual([]);
		expect(existsSync(h.settingsPath)).toBe(false);
		await h.run("status");
		expect(h.last()?.text).toContain("Effective: project subagents.agentOverrides.code-writer wins over the stored user hierarchy.");
		expect(h.last()?.text).toContain("project subagents.agentOverridesByProvider.openai-codex.code-writer.thinking layer over the writer");
		expect(h.last()?.text).toContain("project subagents.modelScope replaces the user scope and has no code-writer rule");
	});

	it("refuses a replacing permissive project scope with instructions, and accepts an equivalent strict project rule", async () => {
		const permissive = harness(home, { projectSettings: { subagents: { modelScope: { enforce: true, allow: ["*"] } } } });
		permissive.start();
		await permissive.run("models openai-codex/gpt-6-astra openai-codex/gpt-5.6-luna");
		expect(permissive.last()?.level).toBe("error");
		expect(permissive.last()?.text).toContain('"allow": ["openai-codex/gpt-6-astra","openai-codex/gpt-5.6-luna"]');
		expect(permissive.dialogs).toEqual([]);
		expect(existsSync(permissive.settingsPath)).toBe(false);
		expect(readFileSync(join(permissive.cwd, ".pi", "settings.json"), "utf8")).toBe(JSON.stringify({ subagents: { modelScope: { enforce: true, allow: ["*"] } } }));

		const cwd = join(home, "equivalent");
		const equivalent = harness(home, { cwd, projectSettings: { subagents: { modelScope: { enforce: true, strict: true, allow: ["*"], agents: { "code-writer": { allow: ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-6-astra"] } } } } } });
		equivalent.start();
		await equivalent.run("models openai-codex/gpt-6-astra openai-codex/gpt-5.6-luna");
		expect(equivalent.last()?.level).toBe("warning");
		expect(equivalent.last()?.text).toContain("Wrote code-writer hierarchy");
		expect(equivalent.last()?.text).toContain("existing strict code-writer rule matches this hierarchy");
		expect(existsSync(equivalent.settingsPath)).toBe(true);
		await equivalent.run("status");
		expect(equivalent.last()?.text).toContain("its code-writer rule (enforce, strict): openai-codex/gpt-5.6-luna, openai-codex/gpt-6-astra");
	});

	it("uses the native project root (ancestor .pi, git-root policy) for configure and status, failing closed on unsupported policy", async () => {
		const repo = join(home, "repo");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repo, ".pi"), { recursive: true });
		writeFileSync(join(repo, ".pi", "settings.json"), JSON.stringify({ subagents: { agentOverrides: { "code-writer": { fallbackModels: false } } } }));
		const nestedCwd = join(repo, "packages", "app");
		const h = harness(home, { cwd: nestedCwd });
		h.start();
		// nested cwd has an empty .pi (created by the harness) -> nearest wins -> no conflict from the ancestor.
		await h.run("status");
		expect(h.last()?.text).toContain(`Effective project settings: ${join(nestedCwd, ".pi", "settings.json")} (absent)`);
		writeFileSync(join(nestedCwd, ".pi", "settings.json"), JSON.stringify({ subagents: { projectRootResolution: "git-root" } }));
		await h.run("status");
		expect(h.last()?.text).toContain(`Effective project settings: ${join(repo, ".pi", "settings.json")}`);
		await h.run("models openai-codex/gpt-6-astra");
		expect(h.last()?.level).toBe("error");
		expect(h.last()?.text).toContain("project subagents.agentOverrides.code-writer.fallbackModels");
		expect(existsSync(h.settingsPath)).toBe(false);
		writeFileSync(join(nestedCwd, ".pi", "settings.json"), JSON.stringify({ subagents: { projectRootResolution: "sometimes" } }));
		await h.run("models openai-codex/gpt-6-astra");
		expect(h.last()?.text).toContain("unsupported 'subagents.projectRootResolution'");
		expect(existsSync(h.settingsPath)).toBe(false);
		await h.run("status");
		expect(h.last()?.text).toContain("Project settings unusable");
	});

	it("restores routing from the active branch only and refreshes on start and tree navigation", () => {
		const on = { type: "custom", customType: ROUTING_ENTRY, data: { preferred: true, changedAt: 1 } };
		const off = { type: "custom", customType: ROUTING_ENTRY, data: { preferred: false, changedAt: 2 } };
		// Preference recorded on an abandoned branch must not leak into the active one.
		const leaked = harness(home, { branch: [], otherBranches: [on] });
		leaked.start("resume");
		expect(leaked.prompt()).toBe("BASE");
		const restored = harness(home, { branch: [on], otherBranches: [off] });
		restored.start("resume");
		expect(restored.prompt()).toContain(ROUTING_MARKER);
		expect(readRoutingState([on, { type: "custom", customType: ROUTING_ENTRY, data: { preferred: "yes" } }, off])).toEqual({ preferred: false, changedAt: 2 });
		const fresh = harness(home);
		fresh.start("new");
		expect(fresh.prompt()).toBe("BASE");
		// /tree switches the active branch: refresh from it without a session_start.
		restored.branch.length = 0;
		expect(restored.prompt()).toContain(ROUTING_MARKER); // stale until an event fires
		restored.tree();
		expect(restored.prompt()).toBe("BASE");
		restored.branch.push(on);
		restored.tree();
		expect(restored.prompt()).toContain(ROUTING_MARKER);
		restored.branch.length = 0;
		restored.start("reload");
		expect(restored.prompt()).toBe("BASE");
	});

	it("documents a single medium Fable model as the example while longer hierarchies stay valid", async () => {
		expect(EXAMPLE_HIERARCHY).toBe("anthropic-claude-code/claude-fable-5-1:medium");
		const example = parseHierarchy(EXAMPLE_HIERARCHY.split(" "));
		expect(example.fallbacks).toEqual([]);
		expect(example.primary.thinking).toBe("medium");
		// The example is documentation only: it is never written unless typed.
		const h = harness(home);
		h.start();
		await h.run("on");
		expect(h.last()?.text).toContain(`/code-writer models ${EXAMPLE_HIERARCHY}`);
		expect(existsSync(h.settingsPath)).toBe(false);
		await h.run(`models ${EXAMPLE_HIERARCHY}`);
		expect(JSON.parse(readFileSync(h.settingsPath, "utf8")).subagents).toEqual({
			agentOverrides: { "code-writer": { model: "anthropic-claude-code/claude-fable-5-1", thinking: "medium", defaultContext: "fresh", fast: false, extensions: ["/toolkit/extensions/anthropic-claude-code.ts"] } },
			modelScope: { agents: { "code-writer": { enforce: true, strict: true, allow: ["anthropic-claude-code/claude-fable-5-1"] } } },
		});
		// A single-model example does not narrow the general hierarchy feature.
		await h.run("models anthropic-claude-code/claude-fable-5-1 openai-codex/gpt-6-astra openai-codex/gpt-5.6-luna:low");
		expect(JSON.parse(readFileSync(h.settingsPath, "utf8"))).toEqual(EXPECTED_WRITE);
	});

	it("routes mechanical work, substantive writing and optional review to distinct roles without a blanket cheap route", () => {
		const text = ROUTING_ADDENDUM;
		expect(ROUTING_ROLES).toEqual({ writer: "code-writer", mechanical: "routine-worker", evidence: ["review-evidence", "scout"], reviewer: "reviewer" });
		// Evidence roles read; they never approve or decide.
		expect(text).toContain("`review-evidence` or `scout`");
		expect(text).toContain("evidence only, never approval or a decision");
		// Luna worker only for mechanical edits behind an explicit gate; uncertainty goes to the writer.
		expect(text).toContain("`routine-worker` is ONLY for mechanical edits: settled behaviour, an explicit file scope, an existing pattern to propagate exactly, and cheap verification");
		expect(text).toContain("If you are unsure whether work is mechanical, it is not; send it to the writer");
		// Substantive implementation goes to the writer with the native launch protocol, fresh and unpinned.
		expect(text).toContain("Substantive implementation and tests, and any coding task needing judgement beyond that mechanical gate, go to the `code-writer` subagent");
		expect(text).toContain('subagent({ agent: "code-writer", task: "<coherent bounded task>", context: "fresh", async: true })');
		expect(text).toContain("Do not pass a per-call `model`");
		expect(text).toContain("fresh context, no per-call model pin");
		expect(text).not.toMatch(/model: "/);
		// Review is optional and never replaces parent acceptance.
		expect(text).toContain("not an obligatory stage for every patch");
		expect(text).toContain("they do not replace it");
		expect(text).toContain("command and test execution, and final acceptance");
		expect(text).toContain("do not impose a scout-plan-write-review ceremony");
		// Unavailable or unsuitable roles are reported, never downgraded or silently done inline.
		expect(text).toContain("Choose roles from the agents actually available in this session");
		expect(text).toContain("never substitute a cheaper worker for writer work");
		expect(text).toContain("Never silently fall back to editing code yourself");
		// One writer per checkout, explicit partial-work escalation, no task replay, honest labelling, opt-out.
		expect(text).toContain("One writer per checkout");
		expect(text).toContain("issue a new, explicit continuation task");
		expect(text).toContain("Do not replay completed changes");
		expect(text).toContain("not a sandbox or an enforced complexity classifier");
		expect(text).toContain("None of these roles has a shell or runs tests");
		expect(text).toContain("/code-writer off");
		// No blanket lightweight coding route and no broadened tools.
		expect(text).not.toMatch(/Route source and test edits to/);
		expect(text).not.toMatch(/\bbash\b|tools?:/);
		expect(text).not.toContain("routine-worker\" subagent for");
	});

	it("labels the routing dialog, notice and status with the split policy", async () => {
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		const h = harness(home);
		writeFileSync(h.settingsPath, JSON.stringify(EXPECTED_WRITE));
		h.start();
		await h.run("on");
		expect(h.dialogs[0]!.body).toContain("substantive code/test edits to the code-writer subagent, mechanical edits only to routine-worker");
		expect(h.dialogs[0]!.body).toContain("review to reviewer when justified");
		expect(h.last()?.text).toContain("only mechanical edits to routine-worker");
		await h.run("status");
		expect(h.last()?.text).toContain("Session routing: preferred (parent asked to delegate substantive code/test edits to code-writer; mechanical edits only to routine-worker)");
	});

	it("describes native extension semantics accurately", () => {
		expect(describeStored({ model: "a/b", providerOverrideKeys: [] }).join("\n")).toContain("packaged default (explicit empty list");
		expect(describeStored({ model: "a/b", extensions: false, providerOverrideKeys: [] }).join("\n")).toContain("extensions is false, which clears the explicit list and lets the writer load ambient extensions");
		expect(describeStored({ model: "a/b", extensions: [], providerOverrideKeys: [] }).join("\n")).toContain("none (explicit empty list; built-in providers only)");
		expect(describeStored({ model: "a/b", agentAllow: ["a/b"], agentEnforce: true, agentStrict: true, globalEnforce: false, globalAllow: ["*"], providerOverrideKeys: [] }).join("\n")).toContain("Per-agent scope (enforce, strict): a/b");
	});

	it("does not duplicate the routing policy or the delegation policy", () => {
		const once = appendRoutingPolicy(appendDelegationPolicy("BASE"), true);
		const twice = appendRoutingPolicy(appendDelegationPolicy(once), true);
		expect(twice).toBe(once);
		expect(twice.split(ROUTING_MARKER)).toHaveLength(2);
		expect(appendRoutingPolicy("BASE", false)).toBe("BASE");
	});
});
