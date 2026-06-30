import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import memoryExtension from "./index";

/** Minimal fake ExtensionAPI that captures everything the extension registers. */
function fakePi() {
	// biome-ignore lint/suspicious/noExplicitAny: test double
	const hooks: Record<string, (event: any) => any> = {};
	// biome-ignore lint/suspicious/noExplicitAny: test double
	const tools: Record<string, any> = {};
	// biome-ignore lint/suspicious/noExplicitAny: test double
	const commands: Record<string, any> = {};
	const api = {
		on(event: string, handler: (event: unknown) => unknown) {
			hooks[event] = handler;
		},
		registerTool(spec: { name: string }) {
			tools[spec.name] = spec;
		},
		registerCommand(name: string, spec: unknown) {
			commands[name] = spec;
		},
	};
	return { api: api as never, hooks, tools, commands };
}

/** Fetch a registered hook, asserting it exists (narrows away `undefined`). */
function hook(pi: ReturnType<typeof fakePi>, name: string) {
	const h = pi.hooks[name];
	if (!h) throw new Error(`hook ${name} not registered`);
	return h;
}

function command(pi: ReturnType<typeof fakePi>, name: string) {
	const c = pi.commands[name];
	if (!c) throw new Error(`command ${name} not registered`);
	return c;
}

function fakeCommandContext() {
	const notifications: Array<{ text: string; level: string }> = [];
	return {
		notifications,
		ctx: {
			ui: {
				notify(text: string, level: string) {
					notifications.push({ text, level });
				},
			},
		},
	};
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A fake `brain` executable: records argv + stdin, branches on the subcommand, and
 *  fails when BRAIN_FAIL is set so the degradation paths are exercised. */
const FAKE_BRAIN = `#!/usr/bin/env bash
printf '%s\n' "$@" > "$BRAIN_ARGS_OUT"
if [ -n "$BRAIN_PID_OUT" ]; then printf '%s\n' "$$" > "$BRAIN_PID_OUT"; fi
if [ -n "$BRAIN_SLEEP" ]; then exec sleep "$BRAIN_SLEEP"; fi
if [ -n "$BRAIN_FAIL" ]; then
  msg="$BRAIN_FAIL_MESSAGE"
  if [ -z "$msg" ]; then msg="brain: simulated failure"; fi
  printf '%s\n' "$msg" >&2
  exit 1
fi
case "$1" in
  query)
    if [ -n "$BRAIN_BIG_QUERY" ]; then
      printf '<brain_memories>\n'
      i=0
      while [ "$i" -lt 120 ]; do printf 'XXXXXXXXXX'; i=$((i+1)); done
      printf '\n</brain_memories>\n'
    else
      printf '<brain_memories>\nTom prefers bun test.\n</brain_memories>\n'
    fi
    ;;
  remember) cat > "$BRAIN_REMEMBER_OUT" ;;
  daemon) echo "brain daemon: alive" ;;
  *) echo "unknown" >&2; exit 2 ;;
esac
`;

let dir: string;
let argsOut: string;
let rememberOut: string;
const saved: Record<string, string | undefined> = {};

function setEnv(k: string, v: string | undefined) {
	if (!(k in saved)) saved[k] = process.env[k];
	if (v === undefined) delete process.env[k];
	else process.env[k] = v;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mem-client-"));
	const brain = join(dir, "brain");
	writeFileSync(brain, FAKE_BRAIN, { mode: 0o755 });
	chmodSync(brain, 0o755);
	argsOut = join(dir, "args.txt");
	rememberOut = join(dir, "remember.jsonl");
	setEnv("AGENT_TOOLKIT_BRAIN_BIN", brain);
	setEnv("BRAIN_BIN", undefined);
	setEnv("AGENT_TOOLKIT_MEMORY_ENGINE", "brain");
	setEnv("AGENT_TOOLKIT_MEMORY_SCOPE", undefined);
	setEnv("AGENT_TOOLKIT_MEMORY_BRAIN_HOME", undefined);
	setEnv("AGENT_TOOLKIT_MEMORY_BRAIN_ROOT", undefined);
	setEnv("AGENT_TOOLKIT_MEMORY_RECALL_MS", undefined);
	setEnv("AGENT_TOOLKIT_MEMORY_RECALL_MAX_CHARS", undefined);
	setEnv("AGENT_TOOLKIT_MEMORY_CLI_MS", undefined);
	setEnv("AGENT_TOOLKIT_BRAIN_ROOT", undefined);
	setEnv("BRAIN_ARGS_OUT", argsOut);
	setEnv("BRAIN_REMEMBER_OUT", rememberOut);
	setEnv("BRAIN_FAIL", undefined);
	setEnv("BRAIN_FAIL_MESSAGE", undefined);
	setEnv("BRAIN_PID_OUT", undefined);
	setEnv("BRAIN_SLEEP", undefined);
	setEnv("BRAIN_BIG_QUERY", undefined);
});
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	for (const k of Object.keys(saved)) delete saved[k];
	rmSync(dir, { recursive: true, force: true });
});

describe("memory extension — brain client", () => {
	it("is inert under a non-brain engine (registers nothing)", () => {
		setEnv("AGENT_TOOLKIT_MEMORY_ENGINE", "okf");
		const pi = fakePi();
		memoryExtension(pi.api);
		expect(Object.keys(pi.hooks)).toHaveLength(0);
		expect(Object.keys(pi.tools)).toHaveLength(0);
	});

	it("injects the brain_memories block + addendum on before_agent_start (reranker off)", async () => {
		const pi = fakePi();
		memoryExtension(pi.api);
		const res = await hook(pi, "before_agent_start")({ prompt: "how do I run tests?", systemPrompt: "BASE" });
		expect(res.systemPrompt).toContain("BASE");
		expect(res.systemPrompt).toContain("<!-- memory-addendum -->");
		expect(res.systemPrompt).toContain("Tom prefers bun test.");
		const args = readFileSync(argsOut, "utf8");
		expect(args).toContain("query");
		expect(args).toContain("--format");
		expect(args).toContain("context");
		expect(args).toContain("--no-rerank"); // per-turn recall skips the slow reranker
	});

	it("uses BRAIN_BIN when AGENT_TOOLKIT_BRAIN_BIN is unset", async () => {
		setEnv("BRAIN_BIN", process.env.AGENT_TOOLKIT_BRAIN_BIN);
		setEnv("AGENT_TOOLKIT_BRAIN_BIN", undefined);
		const pi = fakePi();
		memoryExtension(pi.api);
		await hook(pi, "before_agent_start")({ prompt: "how do I run tests?", systemPrompt: "BASE" });
		const args = readFileSync(argsOut, "utf8");
		expect(args).toContain("query");
	});

	it("falls back to the bundled bin/brain when no binary override is set", async () => {
		setEnv("AGENT_TOOLKIT_BRAIN_BIN", undefined);
		setEnv("BRAIN_BIN", undefined);
		setEnv("AGENT_TOOLKIT_MEMORY_BRAIN_HOME", join(dir, "brain-home"));
		setEnv("AGENT_TOOLKIT_MEMORY_BRAIN_ROOT", join(dir, "brain-root"));
		const pi = fakePi();
		memoryExtension(pi.api);
		const { ctx, notifications } = fakeCommandContext();
		await command(pi, "memory").handler("status", ctx);
		expect(notifications).toHaveLength(1);
		const [notification] = notifications;
		if (!notification) throw new Error("expected a notification");
		expect(notification.level).toBe("info");
		expect(notification.text).toContain("brain daemon");
	});

	it("ignores blank binary overrides and still falls back to the bundled bin/brain", async () => {
		setEnv("AGENT_TOOLKIT_BRAIN_BIN", "   ");
		setEnv("BRAIN_BIN", "");
		setEnv("AGENT_TOOLKIT_MEMORY_BRAIN_HOME", join(dir, "brain-home"));
		setEnv("AGENT_TOOLKIT_MEMORY_BRAIN_ROOT", join(dir, "brain-root"));
		const pi = fakePi();
		memoryExtension(pi.api);
		const { ctx, notifications } = fakeCommandContext();
		await command(pi, "memory").handler("status", ctx);
		expect(notifications[0]?.level).toBe("info");
		expect(notifications[0]?.text).toContain("brain daemon");
	});

	it("skips brain entirely for an empty prompt", async () => {
		const pi = fakePi();
		memoryExtension(pi.api);
		const res = await hook(pi, "before_agent_start")({ prompt: "   ", systemPrompt: "BASE" });
		expect(res.systemPrompt).toBe("BASE");
		expect(existsSync(argsOut)).toBe(false);
	});

	it("degrades to addendum-only (no throw) when brain fails on recall", async () => {
		setEnv("BRAIN_FAIL", "1");
		const pi = fakePi();
		memoryExtension(pi.api);
		const res = await hook(pi, "before_agent_start")({ prompt: "anything", systemPrompt: "BASE" });
		expect(res.systemPrompt).toContain("BASE");
		expect(res.systemPrompt).toContain("<!-- memory-addendum -->");
		// No actual recall block was injected (the addendum text mentions the tag itself).
		expect(res.systemPrompt).not.toContain("Tom prefers bun test.");
	});

	it("kills the brain process when per-turn recall times out", async () => {
		const pidOut = join(dir, "pid.txt");
		setEnv("BRAIN_PID_OUT", pidOut);
		setEnv("BRAIN_SLEEP", "5");
		setEnv("AGENT_TOOLKIT_MEMORY_RECALL_MS", "25");
		const pi = fakePi();
		memoryExtension(pi.api);
		const started = Date.now();
		const res = await hook(pi, "before_agent_start")({ prompt: "anything", systemPrompt: "BASE" });
		expect(Date.now() - started).toBeLessThan(1500);
		expect(res.systemPrompt).toContain("<!-- memory-addendum -->");
		const pid = Number(readFileSync(pidOut, "utf8").trim());
		expect(Number.isFinite(pid)).toBe(true);
		expect(isProcessAlive(pid)).toBe(false);
	});

	it("caps the automatic recall block before injecting it", async () => {
		setEnv("BRAIN_BIG_QUERY", "1");
		setEnv("AGENT_TOOLKIT_MEMORY_RECALL_MAX_CHARS", "120");
		const pi = fakePi();
		memoryExtension(pi.api);
		const res = await hook(pi, "before_agent_start")({ prompt: "anything", systemPrompt: "BASE" });
		expect(res.systemPrompt).toContain("brain recall truncated");
		expect(res.systemPrompt).not.toContain("X".repeat(300));
	});

	it("memory_remember pipes a well-formed JSONL turn to brain remember", async () => {
		const pi = fakePi();
		memoryExtension(pi.api);
		const out = await pi.tools.memory_remember.execute("id", { fact: "Deploy on Fridays via the release script." });
		expect(out.details.ok).toBe(true);
		const args = readFileSync(argsOut, "utf8");
		expect(args).toContain("remember");
		expect(args).toContain("--json");
		const turn = JSON.parse(readFileSync(rememberOut, "utf8").trim());
		expect(turn.role).toBe("user");
		expect(turn.text).toBe("Deploy on Fridays via the release script.");
		expect(typeof turn.recordedAt).toBe("string");
	});

	it("memory_query runs full-quality (reranker on) and returns the block", async () => {
		const pi = fakePi();
		memoryExtension(pi.api);
		const out = await pi.tools.memory_query.execute("id", { query: "test runner" });
		expect(out.details.ok).toBe(true);
		expect(out.content[0].text).toContain("Tom prefers bun test.");
		const args = readFileSync(argsOut, "utf8");
		expect(args).not.toContain("--no-rerank"); // explicit lookup keeps the reranker
	});

	it("passes a -- sentinel before query text so dash-prefixed queries are not parsed as flags", async () => {
		const pi = fakePi();
		memoryExtension(pi.api);
		const out = await pi.tools.memory_query.execute("id", { query: "--starts-with-dash" });
		expect(out.details.ok).toBe(true);
		const args = readFileSync(argsOut, "utf8");
		expect(args).toContain("--\n--starts-with-dash");
	});

	it("memory_query rejects an empty query without spawning brain", async () => {
		const pi = fakePi();
		memoryExtension(pi.api);
		const out = await pi.tools.memory_query.execute("id", { query: "   " });
		expect(out.details.ok).toBe(false);
		expect(out.content[0].text).toContain("non-empty");
		expect(existsSync(argsOut)).toBe(false);
	});

	it("tools return a graceful, capped first-line error when brain fails", async () => {
		setEnv("BRAIN_FAIL", "1");
		setEnv("BRAIN_FAIL_MESSAGE", `${"A".repeat(500)}\nSECOND-LINE-SECRET`);
		const pi = fakePi();
		memoryExtension(pi.api);
		const q = await pi.tools.memory_query.execute("id", { query: "x" });
		expect(q.details.ok).toBe(false);
		expect(q.content[0].text).not.toContain("SECOND-LINE-SECRET");
		expect(q.content[0].text.length).toBeLessThan(320);
		const r = await pi.tools.memory_remember.execute("id", { fact: "y" });
		expect(r.details.ok).toBe(false);
		expect(r.content[0].text).not.toContain("SECOND-LINE-SECRET");
		expect(r.content[0].text.length).toBeLessThan(320);
	});

	it("a timed-out remember does not poison the serial remember queue", async () => {
		setEnv("AGENT_TOOLKIT_MEMORY_CLI_MS", "25");
		setEnv("BRAIN_SLEEP", "5");
		const pi = fakePi();
		memoryExtension(pi.api);
		const first = await pi.tools.memory_remember.execute("id", { fact: "first" });
		expect(first.details.ok).toBe(false);

		setEnv("BRAIN_SLEEP", undefined);
		const second = await pi.tools.memory_remember.execute("id", { fact: "second" });
		expect(second.details.ok).toBe(true);
		const turn = JSON.parse(readFileSync(rememberOut, "utf8").trim());
		expect(turn.text).toBe("second");
	});

	it("memory_remember handles a missing brain binary without hanging", async () => {
		setEnv("AGENT_TOOLKIT_BRAIN_BIN", join(dir, "missing-brain"));
		const pi = fakePi();
		memoryExtension(pi.api);
		const started = Date.now();
		const out = await pi.tools.memory_remember.execute("id", { fact: "y" });
		expect(Date.now() - started).toBeLessThan(1500);
		expect(out.details.ok).toBe(false);
		expect(out.content[0].text.length).toBeLessThan(320);
	});

	it("/memory status reports brain failures without throwing", async () => {
		setEnv("BRAIN_FAIL", "1");
		setEnv("BRAIN_FAIL_MESSAGE", "first failure line\nSECOND-LINE-SECRET");
		const pi = fakePi();
		memoryExtension(pi.api);
		const { ctx, notifications } = fakeCommandContext();
		await command(pi, "memory").handler("status", ctx);
		expect(notifications).toHaveLength(1);
		const [notification] = notifications;
		if (!notification) throw new Error("expected a notification");
		expect(notification.level).toBe("warning");
		expect(notification.text).toContain("first failure line");
		expect(notification.text).not.toContain("SECOND-LINE-SECRET");
	});

	it("/memory status reports a missing brain binary without throwing", async () => {
		setEnv("AGENT_TOOLKIT_BRAIN_BIN", join(dir, "missing-brain"));
		const pi = fakePi();
		memoryExtension(pi.api);
		const { ctx, notifications } = fakeCommandContext();
		await command(pi, "memory").handler("status", ctx);
		expect(notifications).toHaveLength(1);
		const [notification] = notifications;
		if (!notification) throw new Error("expected a notification");
		expect(notification.level).toBe("warning");
		expect(notification.text).toContain("brain unavailable");
		expect(notification.text.length).toBeLessThan(320);
	});

	it("passes explicit external brain home/root/scope flags and ignores the legacy OKF root", async () => {
		setEnv("AGENT_TOOLKIT_BRAIN_ROOT", "/legacy/okf-root");
		setEnv("AGENT_TOOLKIT_MEMORY_BRAIN_HOME", "/tmp/brain-home");
		setEnv("AGENT_TOOLKIT_MEMORY_BRAIN_ROOT", "/tmp/brain-root");
		setEnv("AGENT_TOOLKIT_MEMORY_SCOPE", "work");
		const pi = fakePi();
		memoryExtension(pi.api);
		await hook(pi, "before_agent_start")({ prompt: "anything", systemPrompt: "BASE" });
		const args = readFileSync(argsOut, "utf8");
		expect(args).toContain("--home\n/tmp/brain-home");
		expect(args).toContain("--root\n/tmp/brain-root");
		expect(args).toContain("--scope\nwork");
		expect(args).not.toContain("/legacy/okf-root");
	});
});
