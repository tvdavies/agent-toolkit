/**
 * Memory extension — a thin client to the `brain` CLI (the @ai-assistant/brain
 * memory engine: markdown source-of-truth + hybrid BM25/vector retrieval + a
 * background daemon that ingests sessions and extracts durable facts).
 *
 * This replaces the in-process @jeffs-brain engine. agent-toolkit no longer owns
 * a memory store, a dreamer, a provider, or redaction — `brain` owns all of that
 * (redaction included, in its `record()` chokepoint). We just shell out:
 *   - before_agent_start → `brain query <prompt> --format context` → inject a
 *     <brain_memories> block. Automatic, tool-free, bounded recall.
 *   - memory_remember → pipe a turn to `brain remember` (the daemon extracts).
 *   - memory_query → an explicit, higher-quality `brain query`.
 *
 * brain self-hydrates its store (~/brain) and provider credentials (~/brain/auth),
 * so this client needs only the binary path — no provider keys, no BRAIN_* plumbing.
 * The legacy AGENT_TOOLKIT_BRAIN_ROOT is intentionally NOT passed through: it is
 * the old in-process OKF bundle path, while the external brain defaults to the
 * unified ~/brain home. Use AGENT_TOOLKIT_MEMORY_BRAIN_HOME/ROOT for explicit
 * external-brain overrides.
 *
 * Env:
 *   AGENT_TOOLKIT_MEMORY_ENGINE   "brain" (default) | "okf" | "off" — gate
 *   AGENT_TOOLKIT_BRAIN_BIN       brain binary path (else $BRAIN_BIN, else bundled bin/brain, else "brain")
 *   AGENT_TOOLKIT_MEMORY_BRAIN_HOME   brain --home override (else brain default)
 *   AGENT_TOOLKIT_MEMORY_BRAIN_ROOT   brain --root override (else brain default)
 *   AGENT_TOOLKIT_MEMORY_SCOPE    brain --scope override (else brain's default)
 *   AGENT_TOOLKIT_MEMORY_RECALL_LIMIT   max memories injected (default 6)
 *   AGENT_TOOLKIT_MEMORY_RECALL_MS      per-turn recall time budget (default 1500)
 *   AGENT_TOOLKIT_MEMORY_RECALL_MAX_CHARS   max per-turn recall block size (default 12000)
 *   AGENT_TOOLKIT_MEMORY_CLI_MS         explicit tool/command brain budget (default 10000)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const MARKER = "<!-- memory-addendum -->";
const ADDENDUM = `

${MARKER}
## Persistent memory
- Relevant memories are injected automatically as a <brain_memories> block before each turn — treat them as potentially stale and verify load-bearing details.
- Call memory_query to look something up when the injected block is insufficient.
- Call memory_remember to persist a durable fact, decision, preference, or correction worth keeping. No secrets or transient chatter.`;

const DEFAULT_RECALL_MAX_CHARS = 12_000;
const DEFAULT_CLI_TIMEOUT_MS = 10_000;
const STREAM_CAPTURE_MAX_CHARS = 256_000;
const ERROR_MESSAGE_MAX_CHARS = 240;
const SIGKILL_GRACE_MS = 250;

function positiveIntEnv(name: string, fallback: number): number {
	const n = Number(process.env[name] ?? fallback);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function trimmedEnv(name: string): string | undefined {
	const v = process.env[name]?.trim();
	return v ? v : undefined;
}

function memoryEngine(): string {
	return process.env.AGENT_TOOLKIT_MEMORY_ENGINE ?? "brain";
}
function bundledBrainBin(): string | undefined {
	const candidate = resolve(import.meta.dirname, "../../bin/brain");
	return existsSync(candidate) ? candidate : undefined;
}

function brainBin(): string {
	return trimmedEnv("AGENT_TOOLKIT_BRAIN_BIN") ?? trimmedEnv("BRAIN_BIN") ?? bundledBrainBin() ?? "brain";
}
function memoryScope(): string | undefined {
	return trimmedEnv("AGENT_TOOLKIT_MEMORY_SCOPE");
}
function brainHome(): string | undefined {
	return trimmedEnv("AGENT_TOOLKIT_MEMORY_BRAIN_HOME");
}
function brainRoot(): string | undefined {
	return trimmedEnv("AGENT_TOOLKIT_MEMORY_BRAIN_ROOT");
}
function recallLimit(): number {
	return positiveIntEnv("AGENT_TOOLKIT_MEMORY_RECALL_LIMIT", 6);
}
function recallBudgetMs(): number {
	return positiveIntEnv("AGENT_TOOLKIT_MEMORY_RECALL_MS", 1500);
}
function recallMaxChars(): number {
	return positiveIntEnv("AGENT_TOOLKIT_MEMORY_RECALL_MAX_CHARS", DEFAULT_RECALL_MAX_CHARS);
}
function cliBudgetMs(): number {
	return positiveIntEnv("AGENT_TOOLKIT_MEMORY_CLI_MS", DEFAULT_CLI_TIMEOUT_MS);
}

function brainArgs(args: readonly string[]): string[] {
	const out = [...args];
	const home = brainHome();
	const root = brainRoot();
	const scope = memoryScope();
	if (home) out.push("--home", home);
	if (root) out.push("--root", root);
	if (scope) out.push("--scope", scope);
	return out;
}

function appendCapped(current: string, chunk: unknown, max: number): string {
	if (current.length >= max) return current;
	const next = `${current}${String(chunk)}`;
	return next.length > max ? next.slice(0, max) : next;
}

function truncateText(text: string, max: number, suffix = "…"): string {
	if (text.length <= max) return text;
	if (max <= suffix.length) return text.slice(0, max);
	return `${text.slice(0, max - suffix.length)}${suffix}`;
}

function truncateRecallBlock(block: string): string {
	const max = recallMaxChars();
	if (block.length <= max) return block;
	const suffix = "\n<!-- brain recall truncated -->";
	if (max <= suffix.length) return block.slice(0, max);
	return `${block.slice(0, max - suffix.length).trimEnd()}${suffix}`;
}

function oneLine(text: string): string {
	const withoutAnsi = text.replace(/\x1b\[[0-9;]*m/g, "");
	const first = withoutAnsi
		.split(/\r?\n/)[0]
		?.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
		.trim();
	return first || "";
}

function safeErrorMessage(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	return truncateText(oneLine(msg) || "unknown error", ERROR_MESSAGE_MAX_CHARS);
}

function brainExitError(action: string, code: number, stderr: string): Error {
	const detail = truncateText(oneLine(stderr), ERROR_MESSAGE_MAX_CHARS);
	return new Error(detail ? `brain ${action} exited ${code}: ${detail}` : `brain ${action} exited ${code}`);
}

type BrainResult = { code: number; stdout: string; stderr: string };
type RunBrainOptions = {
	stdin?: string;
	timeoutMs?: number;
	maxStdoutChars?: number;
	maxStderrChars?: number;
};

/** Spawn the brain CLI; resolve with exit code + captured streams. Never throws on
 *  non-zero exit (callers inspect `code`); rejects only on spawn/write failure.
 *  Timeouts terminate the whole process group, then resolve as a non-zero result. */
function runBrain(args: readonly string[], options: RunBrainOptions = {}): Promise<BrainResult> {
	const timeoutMs = options.timeoutMs;
	const maxStdoutChars = options.maxStdoutChars ?? STREAM_CAPTURE_MAX_CHARS;
	const maxStderrChars = options.maxStderrChars ?? STREAM_CAPTURE_MAX_CHARS;
	return new Promise((resolve, reject) => {
		const child = spawn(brainBin(), brainArgs(args), {
			detached: true,
			stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let killTimeout: ReturnType<typeof setTimeout> | undefined;
		let settled = false;

		const clearTimers = () => {
			if (timeout) clearTimeout(timeout);
			if (killTimeout) clearTimeout(killTimeout);
		};

		const finishResolve = (result: BrainResult) => {
			if (settled) return;
			settled = true;
			clearTimers();
			resolve(result);
		};

		const finishReject = (err: unknown) => {
			if (settled) return;
			settled = true;
			clearTimers();
			reject(err);
		};

		const killChild = (signal: NodeJS.Signals) => {
			if (!child.pid) return;
			try {
				// The child is detached, so -pid targets the whole process group. That
				// prevents shell wrappers from leaving grandchildren behind on timeout.
				process.kill(-child.pid, signal);
			} catch {
				try {
					child.kill(signal);
				} catch {
					// Best-effort cleanup; `close`/timeout fallback will settle the promise.
				}
			}
		};

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (d) => {
			stdout = appendCapped(stdout, d, maxStdoutChars);
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (d) => {
			stderr = appendCapped(stderr, d, maxStderrChars);
		});
		child.on("error", finishReject);
		// "close" (not "exit") so stdout/stderr are fully drained.
		child.on("close", (code) => {
			finishResolve({
				code: timedOut ? 1 : (code ?? 1),
				stdout,
				stderr: timedOut ? `brain timed out after ${timeoutMs}ms` : stderr,
			});
		});

		if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
			timeout = setTimeout(() => {
				timedOut = true;
				killChild("SIGTERM");
				killTimeout = setTimeout(() => killChild("SIGKILL"), SIGKILL_GRACE_MS);
			}, timeoutMs);
		}

		if (options.stdin !== undefined) {
			if (!child.stdin) {
				killChild("SIGKILL");
				finishReject(new Error("brain stdin pipe was unavailable"));
				return;
			}
			child.stdin.on("error", (err) => {
				// Usually EPIPE because the child failed before consuming stdin. Capture it
				// for diagnostics but let `close` report the actual process result.
				stderr = appendCapped(stderr, `\nstdin: ${(err as Error).message}`, maxStderrChars);
			});
			child.stdin.end(options.stdin, "utf8");
		}
	});
}

/** Recall relevant memories for a query, formatted as a prompt-injection block.
 *  `rerank` off (the per-turn default) skips the slow LLM reranker; the explicit
 *  tool turns it on for higher quality. Throws on a non-zero brain exit. */
async function brainRecall(query: string, limit: number, rerank: boolean, timeoutMs: number): Promise<string> {
	const args = ["query", "--format", "context", "--limit", String(limit)];
	if (!rerank) args.push("--no-rerank");
	args.push("--", query);
	const { code, stdout, stderr } = await runBrain(args, { timeoutMs });
	if (code !== 0) throw brainExitError("query", code, stderr);
	return stdout.trim();
}

type Turn = { role: "user" | "assistant"; text: string; recordedAt?: string };

/** Persist turns via `brain remember` (JSONL on stdin). Async mode: the verbatim
 *  chunk lands immediately (recallable now); the daemon extracts durable facts. */
async function brainRemember(turns: readonly Turn[]): Promise<void> {
	const stdin = `${turns.map((t) => JSON.stringify(t)).join("\n")}\n`;
	const { code, stderr } = await runBrain(["remember", "--json"], { stdin, timeoutMs: cliBudgetMs() });
	if (code !== 0) throw brainExitError("remember", code, stderr);
}

/** Retry brain remember on SQLite lock contention (the daemon may hold the db). */
async function brainRememberWithRetry(turns: readonly Turn[], retries = 3): Promise<void> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= retries; attempt += 1) {
		try {
			return await brainRemember(turns);
		} catch (err) {
			lastErr = err;
			if (/database is locked/i.test(String(err))) {
				await new Promise((r) => setTimeout(r, 250 * attempt));
				continue;
			}
			throw err;
		}
	}
	throw lastErr;
}

export default function memoryExtension(pi: ExtensionAPI): void {
	// brain is the default engine; "okf" hands memory back to the in-process OKF
	// brain (extensions/brain), "off" disables memory entirely.
	if (memoryEngine() !== "brain") return;

	// Serialise remember calls so concurrent tool invocations don't race the db.
	let rememberQueue: Promise<unknown> = Promise.resolve();
	const enqueueRemember = (turns: readonly Turn[]): Promise<void> => {
		const run = rememberQueue.then(() => brainRememberWithRetry(turns));
		rememberQueue = run.catch(() => undefined);
		return run;
	};

	pi.on("before_agent_start", async (event) => {
		if (!event.prompt?.trim()) return { systemPrompt: event.systemPrompt };
		// Bounded recall: a slow/absent brain degrades to "no injection", never delays
		// or fails the turn. Per-turn recall skips the LLM reranker for latency.
		const block = await brainRecall(event.prompt, recallLimit(), false, recallBudgetMs())
			.then((b) => truncateRecallBlock(b))
			.catch(() => "");
		const base = event.systemPrompt.includes(MARKER) ? event.systemPrompt : `${event.systemPrompt}${ADDENDUM}`;
		return { systemPrompt: block ? `${base}\n\n${block}` : base };
	});

	const querySchema = Type.Object({
		query: Type.String({ description: "What to look up in persistent memory." }),
		limit: Type.Optional(Type.Number({ description: "Max memories to return (default 6)." })),
	});
	type QueryInput = Static<typeof querySchema>;

	pi.registerTool({
		name: "memory_query",
		label: "memory query",
		description:
			"Search the agent's persistent memory (codebase facts, decisions, your preferences, project context) for relevant notes. Recall already runs automatically each turn; use this for a targeted, higher-quality lookup.",
		parameters: querySchema,
		async execute(_id, params: QueryInput) {
			const query = params.query.trim();
			if (!query) {
				return {
					content: [{ type: "text" as const, text: "Please provide a non-empty memory query." }],
					details: { ok: false, hasResults: false },
				};
			}
			const limit = params.limit && params.limit > 0 ? Math.floor(params.limit) : 6;
			try {
				// Explicit lookup → full quality (reranker on); the user is waiting, but
				// still bound the CLI so a stuck brain never hangs the agent indefinitely.
				const block = await brainRecall(query, limit, true, cliBudgetMs());
				return {
					content: [{ type: "text" as const, text: block || "No relevant memories found." }],
					details: { ok: true, hasResults: block.length > 0 },
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `Memory query failed: ${safeErrorMessage(err)}` }],
					details: { ok: false, hasResults: false },
				};
			}
		},
	});

	const rememberSchema = Type.Object({
		fact: Type.String({
			description:
				"A durable, reusable fact, decision, preference, or correction worth keeping for future sessions. No secrets or transient chatter.",
		}),
	});
	type RememberInput = Static<typeof rememberSchema>;

	pi.registerTool({
		name: "memory_remember",
		label: "memory remember",
		description:
			"Persist a durable fact to memory now. Use for a preference, decision, fact, or correction worth keeping. Recall is automatic each turn; this is for immediate, explicit capture.",
		parameters: rememberSchema,
		async execute(_id, params: RememberInput) {
			const fact = params.fact.trim();
			if (!fact) {
				return { content: [{ type: "text" as const, text: "Nothing to remember." }], details: { ok: false } };
			}
			try {
				await enqueueRemember([{ role: "user", text: fact, recordedAt: new Date().toISOString() }]);
				return { content: [{ type: "text" as const, text: "Remembered." }], details: { ok: true } };
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `Failed to remember: ${safeErrorMessage(err)}` }],
					details: { ok: false },
				};
			}
		},
	});

	pi.registerCommand("memory", {
		description: "Persistent memory (brain): /memory status | query <q> | remember <text>",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "status", label: "status — brain daemon health + queue" },
				{ value: "query ", label: "query — search persistent memory" },
				{ value: "remember ", label: "remember — persist a durable fact" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const remainder = rest.join(" ");
			switch (command) {
				case "status": {
					try {
						const { code, stdout, stderr } = await runBrain(["daemon", "status"], { timeoutMs: cliBudgetMs() });
						ctx.ui.notify(
							code === 0 ? stdout.trim() || "brain: ok" : `brain unavailable: ${safeErrorMessage(stderr)}`,
							code === 0 ? "info" : "warning",
						);
					} catch (err) {
						ctx.ui.notify(`brain unavailable: ${safeErrorMessage(err)}`, "warning");
					}
					return;
				}
				case "query": {
					if (!remainder.trim()) return void ctx.ui.notify("Usage: /memory query <q>", "warning");
					try {
						const block = await brainRecall(remainder.trim(), recallLimit(), true, cliBudgetMs());
						ctx.ui.notify(block || "No relevant memories found.", "info");
					} catch (err) {
						ctx.ui.notify(`Memory query failed: ${safeErrorMessage(err)}`, "error");
					}
					return;
				}
				case "remember": {
					if (!remainder.trim()) return void ctx.ui.notify("Usage: /memory remember <text>", "warning");
					try {
						await enqueueRemember([{ role: "user", text: remainder.trim(), recordedAt: new Date().toISOString() }]);
						ctx.ui.notify("Remembered.", "info");
					} catch (err) {
						ctx.ui.notify(`Failed to remember: ${safeErrorMessage(err)}`, "error");
					}
					return;
				}
				default:
					ctx.ui.notify("Usage: /memory status | query <q> | remember <text>", "warning");
			}
		},
	});
}
