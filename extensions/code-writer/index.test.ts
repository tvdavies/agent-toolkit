import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codeWriterExtension, { ANTHROPIC_PROVIDER_EXTENSION_PATH, CODE_WRITER_AGENT_FILE, describeStored, EXAMPLE_HIERARCHY, ROUTING_DEFAULT_SETTING, ROUTING_ENTRY, ROUTING_MARKER } from "./index";
import { appendRoutingPolicy, readRoutingState, resolveRouting, ROUTING_ADDENDUM, ROUTING_OPENING, ROUTING_ROLES, routingAddendum } from "./routing";
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
	agentFileExists?: boolean | (() => boolean);
}

function harness(home: string, options: Options = {}) {
	const hooks: Record<string, Handler> = {};
	const commands: Record<string, (args: string, ctx: any) => Promise<void>> = {};
	const specs: Record<string, { description?: string; getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null }> = {};
	const notices: { text: string; level: string }[] = [];
	const dialogs: { title: string; body: string }[] = [];
	const branch: Entry[] = [...(options.branch ?? [])];
	const other: Entry[] = [...(options.otherBranches ?? [])];
	const cwd = options.cwd ?? join(home, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	if (options.projectSettings !== undefined) writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(options.projectSettings));
	const pi = {
		on(event: string, handler: Handler) { hooks[event] = handler; },
		registerCommand(name: string, value: { description?: string; getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null; handler: (args: string, ctx: any) => Promise<void> }) { commands[name] = value.handler; specs[name] = value; },
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
		agentFileExists: () => { const a = options.agentFileExists ?? true; return typeof a === "function" ? a() : a; },
		isChildProcess: () => options.child ?? false,
		now: () => 1_700_000_000_000,
	});
	return {
		hooks, commands, specs, notices, dialogs, branch, settingsPath, ctx, cwd,
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
		// The inherited-default addendum shares the marker, so it is deduplicated against the session one and vice versa.
		expect(appendRoutingPolicy(once, true, "default")).toBe(once);
		expect(appendRoutingPolicy(appendRoutingPolicy("BASE", true, "default"), true, "session")).toBe(appendRoutingPolicy("BASE", true, "default"));
	});

	describe("user-level routing default", () => {
		const ON = { type: "custom", customType: ROUTING_ENTRY, data: { preferred: true, changedAt: 1 } };
		const OFF = { type: "custom", customType: ROUTING_ENTRY, data: { preferred: false, changedAt: 2 } };
		const withDefault = (enabled: boolean, extra: Record<string, unknown> = {}) => ({ ...EXPECTED_WRITE, codeWriter: { routingDefault: enabled }, ...extra });
		const writeUser = (h: { settingsPath: string }, settings: unknown) => {
			mkdirSync(join(home, ".pi", "agent"), { recursive: true });
			writeFileSync(h.settingsPath, JSON.stringify(settings));
		};

		it("keeps a fresh session off when the flag is absent or false, and inherits preferred mode from a true flag without entries or writes", async () => {
			const absent = harness(home);
			writeUser(absent, EXPECTED_WRITE);
			absent.start();
			expect(absent.prompt()).toBe("BASE");
			await absent.run("status");
			expect(absent.last()?.text).toContain("Session routing: off");
			expect(absent.last()?.text).toContain(`Stored routing default (${ROUTING_DEFAULT_SETTING}, user settings only): off`);
			expect(absent.last()?.text).toContain("Routing source: none (no explicit session choice; stored default off)");

			const off = harness(home);
			writeUser(off, withDefault(false));
			off.start();
			expect(off.prompt()).toBe("BASE");

			const on = harness(home);
			const raw = JSON.stringify(withDefault(true));
			writeUser(on, withDefault(true));
			on.start();
			const prompt = on.prompt();
			expect(prompt).toContain(ROUTING_MARKER);
			expect(prompt).toContain("## Code-writer routing (inherited default preference)");
			expect(prompt).toContain(ROUTING_OPENING.default);
			expect(prompt).not.toContain(ROUTING_OPENING.session);
			expect(prompt).toContain('subagent({ agent: "code-writer"');
			expect(prompt).toContain("None of these roles has a shell or runs tests");
			expect(prompt).toContain("/code-writer off");
			// Never materialised as a session entry, never written back, and stable across turns.
			expect(on.branch).toEqual([]);
			expect(readFileSync(on.settingsPath, "utf8")).toBe(raw);
			expect(on.prompt(prompt)).toBe(prompt);
			expect(on.notices).toEqual([]);
			await on.run("status");
			expect(on.last()?.text).toContain("Session routing: preferred");
			expect(on.last()?.text).toContain("Routing source: inherited from the stored user default");
			expect(on.last()?.text).toContain(`Stored routing default (${ROUTING_DEFAULT_SETTING}, user settings only): on`);
			expect(on.last()?.text).not.toContain("explicit session choice");
		});

		it("lets the last explicit entry on the active branch beat the default in both directions and never leaks other branches", async () => {
			const optedOut = harness(home, { branch: [ON, OFF], otherBranches: [ON] });
			writeUser(optedOut, withDefault(true));
			optedOut.start("resume");
			expect(optedOut.prompt()).toBe("BASE");
			await optedOut.run("status");
			expect(optedOut.last()?.text).toContain("Session routing: off");
			expect(optedOut.last()?.text).toContain("Routing source: explicit session choice (/code-writer off recorded on this branch); it overrides the stored default on");

			const optedIn = harness(home, { branch: [OFF, ON], otherBranches: [OFF] });
			writeUser(optedIn, withDefault(false));
			optedIn.start("fork");
			expect(optedIn.prompt()).toContain(ROUTING_OPENING.session);
			await optedIn.run("status");
			expect(optedIn.last()?.text).toContain("Routing source: explicit session choice (/code-writer on recorded on this branch)");
			expect(optedIn.last()?.text).not.toContain("overrides the stored default");

			// An opt-out on an abandoned branch does not suppress the default on a fresh branch, and vice versa.
			const fresh = harness(home, { branch: [], otherBranches: [OFF] });
			writeUser(fresh, withDefault(true));
			fresh.start("new");
			expect(fresh.prompt()).toContain(ROUTING_OPENING.default);
			// Tree navigation onto a branch with an explicit off switches to off; back to a bare branch restores the default.
			fresh.branch.push(OFF);
			fresh.tree();
			expect(fresh.prompt()).toBe("BASE");
			fresh.branch.length = 0;
			fresh.tree();
			expect(fresh.prompt()).toContain(ROUTING_OPENING.default);
			// A session /code-writer off opts out of the global default and is recorded as an explicit entry.
			await fresh.run("off");
			expect(fresh.branch).toEqual([{ type: "custom", customType: ROUTING_ENTRY, data: { preferred: false, changedAt: 1_700_000_000_000 } }]);
			expect(fresh.prompt()).toBe("BASE");
			expect(JSON.parse(readFileSync(fresh.settingsPath, "utf8"))).toEqual(withDefault(true));
			// Invalid entries are skipped by the same reader as before.
			expect(resolveRouting(readRoutingState([{ type: "custom", customType: ROUTING_ENTRY, data: { preferred: "yes" } }]), true)).toEqual({ storedDefault: true, preferred: true, source: "default" });
			expect(resolveRouting(readRoutingState([ON, OFF]), true)).toEqual({ session: { preferred: false, changedAt: 2 }, storedDefault: true, defaultProblem: undefined, preferred: false, source: "session" });
		});

		it("writes only the owned flag after confirmation, preserving unknown siblings and every unrelated key", async () => {
			const h = harness(home);
			const before = {
				theme: "dark",
				defaultProvider: "openai-codex",
				defaultModel: "gpt-6-astra",
				codeWriter: { experimental: { keep: 1 } },
				subagents: {
					...EXPECTED_WRITE.subagents,
					agentOverrides: { ...EXPECTED_WRITE.subagents.agentOverrides, "routine-worker": { model: "openai-codex/gpt-5.6-luna", thinking: "medium" } },
					modelScope: { enforce: true, strict: true, allow: ["inherit", "anthropic-claude-code/claude-fable-5-1", "openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna"], agents: { ...EXPECTED_WRITE.subagents.modelScope.agents, scout: { allow: ["openai-codex/gpt-5.6-luna"] } } },
				},
				worktrees: { copyFiles: [".env"] },
			};
			mkdirSync(join(home, ".pi", "agent"), { recursive: true });
			writeFileSync(h.settingsPath, `${JSON.stringify(before, null, "\t")}\n`);
			h.start();
			await h.run("default on");
			expect(h.dialogs).toHaveLength(1);
			expect(h.dialogs[0]!.title).toBe("Turn the code-writer routing default on for new sessions?");
			expect(h.dialogs[0]!.body).toContain(`${h.settingsPath} (${ROUTING_DEFAULT_SETTING}: true)`);
			expect(h.dialogs[0]!.body).toContain("future parent sessions");
			expect(h.dialogs[0]!.body).toContain("Hierarchy in effect: 1. anthropic-claude-code/claude-fable-5-1  2. openai-codex/gpt-6-astra  3. openai-codex/gpt-5.6-luna:low");
			expect(h.last()?.level).toBe("info");
			expect(h.last()?.text).toContain(`Wrote ${ROUTING_DEFAULT_SETTING}: true to ${h.settingsPath}`);
			expect(h.last()?.text).toContain("Routing source: inherited from the stored user default");
			const written = readFileSync(h.settingsPath, "utf8");
			expect(written.startsWith("{\n\t\"theme\": \"dark\"")).toBe(true);
			expect(JSON.parse(written)).toEqual({ ...before, codeWriter: { experimental: { keep: 1 }, routingDefault: true } });
			// No session entry was materialised; the current session inherits immediately.
			expect(h.branch).toEqual([]);
			expect(h.prompt()).toContain(ROUTING_OPENING.default);
			await h.run("default off");
			expect(h.dialogs).toHaveLength(2);
			expect(h.dialogs[1]!.title).toBe("Turn the code-writer routing default off for new sessions?");
			expect(JSON.parse(readFileSync(h.settingsPath, "utf8"))).toEqual({ ...before, codeWriter: { experimental: { keep: 1 }, routingDefault: false } });
			expect(h.prompt()).toBe("BASE");
			expect(h.branch).toEqual([]);
		});

		it("does nothing when declined or without a UI, and refuses malformed default syntax", async () => {
			const declined = harness(home, { confirm: false });
			const raw = JSON.stringify(EXPECTED_WRITE);
			writeUser(declined, EXPECTED_WRITE);
			declined.start();
			await declined.run("default on");
			expect(declined.dialogs).toHaveLength(1);
			expect(declined.last()?.text).toContain("Cancelled; nothing was changed");
			expect(readFileSync(declined.settingsPath, "utf8")).toBe(raw);
			await declined.run("default off");
			expect(declined.dialogs).toHaveLength(2);
			expect(readFileSync(declined.settingsPath, "utf8")).toBe(raw);

			const headless = harness(home, { hasUI: false });
			headless.start();
			await headless.run("default on");
			expect(headless.dialogs).toEqual([]);
			expect(headless.last()?.text).toContain("refused without a UI");
			await headless.run("default off");
			expect(headless.last()?.text).toContain("refused without a UI");
			expect(readFileSync(headless.settingsPath, "utf8")).toBe(raw);

			const h = harness(home);
			h.start();
			for (const args of ["default", "default maybe", "default on off", "default true", "default on extra"]) {
				await h.run(args);
				expect(h.last()?.level, args).toBe("warning");
				expect(h.last()?.text, args).toContain("Usage: /code-writer default on|off");
			}
			expect(h.dialogs).toEqual([]);
			expect(readFileSync(h.settingsPath, "utf8")).toBe(raw);
			expect(h.specs["code-writer"]!.description).toContain("default on|off");
			expect(h.specs["code-writer"]!.getArgumentCompletions!("def")?.map((item) => item.value)).toEqual(["default on", "default off"]);
			expect(h.specs["code-writer"]!.getArgumentCompletions!("zzz")).toBeNull();
		});

		it("refuses default-on when the writer cannot activate, and blocks a conflict introduced during confirmation while keeping benign changes", async () => {
			const unconfigured = harness(home);
			unconfigured.start();
			await unconfigured.run("default on");
			expect(unconfigured.last()?.level).toBe("error");
			expect(unconfigured.last()?.text).toContain("No code-writer hierarchy is configured");
			expect(unconfigured.dialogs).toEqual([]);
			expect(existsSync(unconfigured.settingsPath)).toBe(false);

			const noAgent = harness(home, { agentFileExists: false });
			writeUser(noAgent, EXPECTED_WRITE);
			noAgent.start();
			await noAgent.run("default on");
			expect(noAgent.last()?.text).toContain("agent definition is missing");
			expect(noAgent.dialogs).toEqual([]);
			expect(JSON.parse(readFileSync(noAgent.settingsPath, "utf8"))).toEqual(EXPECTED_WRITE);

			const project = harness(home, { cwd: join(home, "scoped"), projectSettings: { subagents: { modelScope: { enforce: true, allow: ["*"] } } } });
			writeUser(project, EXPECTED_WRITE);
			project.start();
			await project.run("default on");
			expect(project.last()?.text).toContain("would be ineffective");
			expect(project.dialogs).toEqual([]);
			expect(JSON.parse(readFileSync(project.settingsPath, "utf8"))).toEqual(EXPECTED_WRITE);

			let duringDialog: () => void = () => {};
			const h = harness(home, { confirm: () => { duringDialog(); return true; } });
			writeUser(h, EXPECTED_WRITE);
			h.start();
			// The writer override is disabled while the dialog is open: refused, nothing written, the disabling edit preserved.
			duringDialog = () => {
				const s = JSON.parse(readFileSync(h.settingsPath, "utf8"));
				s.subagents.agentOverrides["code-writer"].disabled = true;
				writeFileSync(h.settingsPath, JSON.stringify(s));
			};
			await h.run("default on");
			expect(h.dialogs).toHaveLength(1);
			expect(h.last()?.level).toBe("error");
			expect(h.last()?.text).toContain("disabled");
			const disabled = JSON.parse(JSON.stringify(EXPECTED_WRITE));
			disabled.subagents.agentOverrides["code-writer"].disabled = true;
			expect(JSON.parse(readFileSync(h.settingsPath, "utf8"))).toEqual(disabled);
			expect(h.prompt()).toBe("BASE");
			// A project conflict introduced during the dialog is read freshly and blocks the write too.
			writeFileSync(h.settingsPath, JSON.stringify(EXPECTED_WRITE));
			duringDialog = () => writeFileSync(join(h.cwd, ".pi", "settings.json"), JSON.stringify({ subagents: { agentOverrides: { "code-writer": { fallbackModels: false } } } }));
			await h.run("default on");
			expect(h.last()?.level).toBe("error");
			expect(h.last()?.text).toContain("project subagents.agentOverrides.code-writer.fallbackModels");
			expect(JSON.parse(readFileSync(h.settingsPath, "utf8"))).toEqual(EXPECTED_WRITE);
			rmSync(join(h.cwd, ".pi", "settings.json"));
			// A benign unrelated change during the dialog survives alongside the flag.
			duringDialog = () => {
				const s = JSON.parse(readFileSync(h.settingsPath, "utf8"));
				s.theme = "light";
				writeFileSync(h.settingsPath, JSON.stringify(s));
			};
			await h.run("default on");
			expect(h.last()?.level).toBe("info");
			expect(JSON.parse(readFileSync(h.settingsPath, "utf8"))).toEqual({ ...EXPECTED_WRITE, theme: "light", codeWriter: { routingDefault: true } });
			expect(h.branch).toEqual([]);
		});

		it("lets default-off disable the flag despite an unusable writer configuration, leaving session decisions alone", async () => {
			const broken = JSON.parse(JSON.stringify(withDefault(true)));
			broken.subagents.agentOverrides["code-writer"].disabled = true;
			const h = harness(home, { branch: [ON], projectSettings: { subagents: { projectRootResolution: "sometimes" } } });
			writeUser(h, broken);
			h.start("resume");
			expect(h.prompt()).toContain(ROUTING_OPENING.session); // explicit session decision retains existing behaviour
			await h.run("default off");
			expect(h.dialogs).toHaveLength(1);
			expect(h.last()?.level).toBe("info");
			expect(JSON.parse(readFileSync(h.settingsPath, "utf8"))).toEqual({ ...broken, codeWriter: { routingDefault: false } });
			expect(h.branch).toEqual([ON]);
			expect(h.prompt()).toContain(ROUTING_OPENING.session);
			// Missing hierarchy and absent file: off still works and creates only the owned namespace.
			const empty = harness(home);
			rmSync(empty.settingsPath);
			empty.start();
			await empty.run("default off");
			expect(JSON.parse(readFileSync(empty.settingsPath, "utf8"))).toEqual({ codeWriter: { routingDefault: false } });
			// Malformed root / unsupported namespace shapes are refused rather than overwritten, for both directions.
			for (const raw of ["{ broken", "[]", JSON.stringify({ ...EXPECTED_WRITE, codeWriter: "yes" }), JSON.stringify({ ...EXPECTED_WRITE, codeWriter: { routingDefault: "true" } })]) {
				writeFileSync(empty.settingsPath, raw);
				await empty.run("default off");
				expect(empty.last()?.level, raw).toBe("error");
				await empty.run("default on");
				expect(empty.last()?.level, raw).toBe("error");
				expect(readFileSync(empty.settingsPath, "utf8"), raw).toBe(raw);
			}
			expect(empty.dialogs).toHaveLength(1);
			// A pre-existing settings lock refuses the write.
			writeFileSync(empty.settingsPath, JSON.stringify(withDefault(true)));
			mkdirSync(`${empty.settingsPath}.lock`);
			await empty.run("default off");
			expect(empty.last()?.text).toContain("locked by another Pi process");
			expect(JSON.parse(readFileSync(empty.settingsPath, "utf8"))).toEqual(withDefault(true));
		});

		it("fails closed on an enabled default that cannot activate here, explains why in status and warns once per reason", async () => {
			let cases = 0;
			const attempt = async (settings: unknown, fragment: string, options: Options = {}) => {
				const h = harness(home, { cwd: join(home, `case-${cases++}`), ...options });
				const raw = typeof settings === "string" ? settings : JSON.stringify(settings);
				mkdirSync(join(home, ".pi", "agent"), { recursive: true });
				writeFileSync(h.settingsPath, raw);
				expect(() => h.start()).not.toThrow();
				expect(h.prompt(), fragment).toBe("BASE");
				expect(h.prompt(), fragment).toBe("BASE");
				expect(h.branch, fragment).toEqual([]);
				expect(readFileSync(h.settingsPath, "utf8"), fragment).toBe(raw);
				const warnings = h.notices.filter((notice) => notice.level === "warning");
				expect(warnings, fragment).toHaveLength(1);
				expect(warnings[0]!.text, fragment).toContain(fragment);
				await h.run("status");
				expect(h.last()?.text, fragment).toContain("Session routing: off");
				expect(h.last()?.text, fragment).toContain(fragment);
				return h;
			};
			// Deliberately invalid fixtures are built through a checked object accessor rather than an untyped mutator.
			type JsonObject = Record<string, unknown>;
			const at = (root: JsonObject, ...path: string[]): JsonObject => {
				let node = root;
				for (const key of path) {
					const next: unknown = node[key];
					if (typeof next !== "object" || next === null || Array.isArray(next)) throw new Error(`fixture path ${path.join(".")} is not an object`);
					node = next as JsonObject;
				}
				return node;
			};
			const edited = (edit: (s: JsonObject) => void): JsonObject => { const s: JsonObject = JSON.parse(JSON.stringify(withDefault(true))); edit(s); return s; };
			let h = await attempt({ codeWriter: { routingDefault: true } }, "No code-writer hierarchy is configured");
			expect(h.last()?.text).toContain("Routing source: none. The stored default is on but ineffective here: No code-writer hierarchy is configured");
			expect(h.last()?.text).toContain(`Stored routing default (${ROUTING_DEFAULT_SETTING}, user settings only): on`);
			await attempt(withDefault(true), "agent definition is missing", { agentFileExists: false });
			await attempt(edited((s) => { at(s, "subagents", "agentOverrides", "code-writer").disabled = true; }), "disabled");
			await attempt(edited((s) => { delete at(s, "subagents", "agentOverrides")["code-writer"]; }), "No code-writer hierarchy is configured");
			await attempt(edited((s) => { at(s, "subagents", "modelScope", "agents", "code-writer").strict = false; }), "rule is missing, not enforced strict");
			await attempt(edited((s) => { delete at(s, "subagents", "modelScope", "agents")["code-writer"]; }), "rule is missing, not enforced strict");
			await attempt(edited((s) => { at(s, "subagents", "agentOverrides", "code-writer").extensions = []; }), "lacks the provider extension");
			await attempt(edited((s) => { at(s, "subagents").agentOverridesByProvider = { "openai-codex": { "code-writer": { model: "openai-codex/gpt-5.6-luna" } } }; }), "user subagents.agentOverridesByProvider.openai-codex.code-writer.model");
			await attempt(edited((s) => { at(s, "subagents", "agentOverrides", "code-writer").tools = 7; }), "'subagents.agentOverrides.code-writer.tools'");
			await attempt(edited((s) => { const scope = at(s, "subagents", "modelScope"); scope.enforce = true; scope.allow = ["openai-codex/*"]; }), "outside the global scope");
			await attempt(withDefault(true), "would be ineffective", { projectSettings: { subagents: { modelScope: { enforce: true, allow: ["*"] } } } });
			await attempt(withDefault(true), "project subagents.agentOverrides.code-writer.model", { projectSettings: { subagents: { agentOverrides: { "code-writer": { model: "openai-codex/gpt-5.6-luna" } } } } });
			await attempt(withDefault(true), "unsupported 'subagents.projectRootResolution'", { projectSettings: { subagents: { projectRootResolution: "sometimes" } } });
			// Malformed namespace/flag: reported, not coerced; a string "true" is not on.
			h = await attempt({ ...EXPECTED_WRITE, codeWriter: { routingDefault: "true" } }, `'${ROUTING_DEFAULT_SETTING}'`);
			expect(h.last()?.text).toContain(`Stored routing default (${ROUTING_DEFAULT_SETTING}, user settings only): unreadable/invalid, treated as off: ${ROUTING_DEFAULT_SETTING} could not be read:`);
			expect(h.last()?.text).not.toContain("user settings only): off");
			await attempt({ ...EXPECTED_WRITE, codeWriter: [] }, "'codeWriter'");
			await attempt("{ broken", "not valid JSON");
			// Project settings cannot supply the flag.
			const projectOnly = harness(home, { cwd: join(home, "project-only"), projectSettings: { codeWriter: { routingDefault: true } } });
			writeUser(projectOnly, EXPECTED_WRITE);
			projectOnly.start();
			expect(projectOnly.prompt()).toBe("BASE");
			expect(projectOnly.notices).toEqual([]);
			// The warning repeats only when the reason changes, and clears once the default becomes effective.
			const changing = harness(home);
			writeUser(changing, { codeWriter: { routingDefault: true } });
			changing.start();
			changing.prompt();
			changing.prompt();
			expect(changing.notices.filter((notice) => notice.level === "warning")).toHaveLength(1);
			writeUser(changing, edited((s) => { at(s, "subagents", "agentOverrides", "code-writer").disabled = true; }));
			changing.prompt();
			changing.prompt();
			expect(changing.notices.filter((notice) => notice.level === "warning")).toHaveLength(2);
			writeUser(changing, withDefault(true));
			expect(changing.prompt()).toContain(ROUTING_OPENING.default);
			expect(changing.notices.filter((notice) => notice.level === "warning")).toHaveLength(2);
			// An explicit session choice is unaffected by an ineffective default and is labelled as such.
			const explicit = harness(home, { branch: [ON] });
			writeUser(explicit, edited((s) => { at(s, "subagents", "agentOverrides", "code-writer").disabled = true; }));
			explicit.start("resume");
			expect(explicit.prompt()).toContain(ROUTING_OPENING.session);
			expect(explicit.notices).toEqual([]);
			await explicit.run("status");
			expect(explicit.last()?.text).toContain("Routing source: explicit session choice (/code-writer on recorded on this branch)");
			expect(explicit.last()?.text).not.toContain("inherited");
		});

		it("refuses default-on when the packaged agent disappears while the dialog is open", async () => {
			let agentPresent = true;
			const h = harness(home, { agentFileExists: () => agentPresent, confirm: () => { agentPresent = false; return true; } });
			const raw = JSON.stringify(EXPECTED_WRITE);
			writeUser(h, EXPECTED_WRITE);
			h.start();
			await h.run("default on");
			expect(h.dialogs).toHaveLength(1); // the pre-dialog check passed; the locked recheck refused
			expect(h.last()?.level).toBe("error");
			expect(h.last()?.text).toContain("agent definition is missing (run scripts/sync.sh and /reload); refusing to enable the routing default. Nothing was written.");
			expect(readFileSync(h.settingsPath, "utf8")).toBe(raw);
			expect(existsSync(`${h.settingsPath}.lock`)).toBe(false);
			expect(h.branch).toEqual([]);
			expect(h.prompt()).toBe("BASE");
			// Restoring the agent lets the pre-dialog check pass again, but the locked recheck still refuses because the dialog removes it once more.
			agentPresent = true;
			await h.run("default on");
			expect(h.dialogs).toHaveLength(2);
			expect(h.last()?.level).toBe("error");
			expect(readFileSync(h.settingsPath, "utf8")).toBe(raw);
			expect(h.branch).toEqual([]);
		});

		it("keeps explicit ON/OFF precedence over an unreadable stored default and reports the default as unreadable, not off", async () => {
			const invalid: [unknown, string][] = [
				[{ ...EXPECTED_WRITE, codeWriter: { routingDefault: "true" } }, `unsupported '${ROUTING_DEFAULT_SETTING}' value; expected a boolean`],
				[{ ...EXPECTED_WRITE, codeWriter: [] }, "unsupported 'codeWriter' value; expected an object"],
			];
			for (const [settings, reason] of invalid) {
				const on = harness(home, { branch: [ON] });
				const raw = JSON.stringify(settings);
				writeUser(on, settings);
				on.start("resume");
				expect(on.prompt(), reason).toContain(ROUTING_OPENING.session);
				expect(on.notices, reason).toEqual([]);
				await on.run("status");
				expect(on.last()?.text, reason).toContain("Session routing: preferred");
				expect(on.last()?.text, reason).toContain("Routing source: explicit session choice (/code-writer on recorded on this branch); the stored default could not be read, so branches without an explicit choice cannot inherit it.");
				expect(on.last()?.text, reason).toContain(`Stored routing default (${ROUTING_DEFAULT_SETTING}, user settings only): unreadable/invalid, treated as off: ${ROUTING_DEFAULT_SETTING} could not be read: user settings.json has an ${reason}`);
				expect(on.last()?.text, reason).not.toContain("user settings only): off");
				expect(on.last()?.text, reason).not.toContain("user settings only): on");
				expect(readFileSync(on.settingsPath, "utf8"), reason).toBe(raw);
				expect(on.branch, reason).toEqual([ON]);

				const off = harness(home, { branch: [ON, OFF] });
				writeUser(off, settings);
				off.start("resume");
				expect(off.prompt(), reason).toBe("BASE");
				expect(off.notices, reason).toEqual([]);
				await off.run("status");
				expect(off.last()?.text, reason).toContain("Session routing: off");
				expect(off.last()?.text, reason).toContain("Routing source: explicit session choice (/code-writer off recorded on this branch); the stored default could not be read, so branches without an explicit choice cannot inherit it.");
				expect(off.last()?.text, reason).not.toContain("overrides the stored default on");
				expect(off.last()?.text, reason).toContain(`unreadable/invalid, treated as off: ${ROUTING_DEFAULT_SETTING} could not be read:`);
				expect(readFileSync(off.settingsPath, "utf8"), reason).toBe(raw);
				expect(off.branch, reason).toEqual([ON, OFF]);
			}
			// Well-formed defaults keep the existing wording alongside an explicit choice.
			const wellFormed = harness(home, { branch: [ON] });
			writeUser(wellFormed, withDefault(false));
			wellFormed.start("resume");
			await wellFormed.run("status");
			expect(wellFormed.last()?.text).toContain("Routing source: explicit session choice (/code-writer on recorded on this branch).");
			expect(wellFormed.last()?.text).toContain(`Stored routing default (${ROUTING_DEFAULT_SETTING}, user settings only): off.`);
		});

		it("stays inert in child processes regardless of the stored default", () => {
			const h = harness(home, { child: true });
			writeUser(h, withDefault(true));
			expect(Object.keys(h.hooks)).toEqual([]);
			expect(Object.keys(h.commands)).toEqual([]);
			expect(h.hooks.before_agent_start).toBeUndefined();
		});

		it("keeps the addendum body identical across sources apart from the truthful opening", () => {
			const session = routingAddendum("session");
			const inherited = routingAddendum("default");
			expect(session).toBe(ROUTING_ADDENDUM);
			expect(session).toContain(ROUTING_OPENING.session);
			expect(inherited).toContain(ROUTING_OPENING.default);
			expect(inherited).not.toContain("with `/code-writer on`.");
			const body = (text: string) => text.slice(text.indexOf("What stays in this session"));
			expect(body(inherited)).toBe(body(session));
			expect(inherited.split(ROUTING_MARKER)).toHaveLength(2);
		});
	});
});
