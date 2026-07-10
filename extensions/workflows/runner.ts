/**
 * Child-agent execution for the workflows extension, delegated to the pi-subagents runtime.
 *
 * Instead of hand-rolling a `pi --mode json -p` spawner (JSON line parsing, prompt tmpfiles,
 * SIGTERM plumbing), workflow agents run through pi-subagents' runSync(), which provides:
 * robust pi-binary resolution, AbortSignal/timeout handling, system-prompt + skills injection,
 * model fallback, and — most importantly — a live Pi session transcript per child
 * (`--session <file>`), so the orchestrating agent can inspect a running subagent's
 * output-so-far (Claude Code BashOutput-style) via renderSessionTail().
 *
 * This module is the ONLY place that touches pi-subagents' internal run APIs (deep
 * `pi-subagents/src/**` imports are not a stable public surface; the version is pinned in
 * bun.lock). Keep the adapter surface small so churn in pi-subagents stays contained here.
 *
 * Acceptance contracts are deliberately not configured, and the generic inferred mutation
 * completion guard is disabled on the cloned agent config: workflow scripts own their explicit
 * schema and reviewer/adversarial verification contracts.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "pi-subagents/src/agents/agents.ts";
import { runSync } from "pi-subagents/src/runs/foreground/execution.ts";
import { cleanupStructuredOutputRuntime, createStructuredOutputRuntime } from "pi-subagents/src/runs/shared/structured-output.ts";

export interface ChildUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface ChildRunRequest {
	cwd: string;
	workspaceRoot: string;
	agent: AgentConfig;
	task: string;
	/** Workflow run id; namespaced with the label to form the child run id. */
	runId: string;
	label: string;
	/** Fresh path for the child's live session transcript (must not already exist). */
	sessionFile: string;
	/** Explicit "provider/id" model override; falls back to agent.model, then parentModel. */
	model?: string;
	parentModel: string;
	thinking?: string;
	tools?: string[];
	timeoutMs?: number;
	maxTokens?: number;
	/** Explicitly approved shell-network capability; secure default is false. */
	network?: boolean;
	/** Mount an ephemeral GitHub token into Bash; implies network and must be source-approved. */
	githubAuth?: boolean;
	/** Native JSON Schema contract passed to pi-subagents' structured_output tool. */
	schema?: Record<string, unknown>;
	artifactDir: string;
	signal: AbortSignal;
}

export interface ChildRunResult {
	exitCode: number;
	text: string;
	messages: Message[];
	usage: ChildUsage;
	error?: string;
	/** True when the child was explicitly stopped or its parent signal was aborted. */
	cancelled: boolean;
	/** True only for the child runtime's own deadline. */
	timedOut: boolean;
	structuredOutput?: unknown;
	sessionFile: string;
}

const CHILD_GUARD_PATH = fileURLToPath(new URL("./child-guard.ts", import.meta.url));

function finalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

// Agent extensions/custom tools run in the child Pi host outside Bash's namespace. Workflow
// children receive only path-guarded built-ins; mutations must go through sandboxed Bash.
export function confineAgentConfig(source: AgentConfig, tools?: string[], thinking?: string): AgentConfig {
	const requestedTools = tools ?? source.tools ?? ["read", "grep", "find", "ls", "bash"];
	const safeTools = ["read", "grep", "find", "ls", "bash"];
	const confinedTools = requestedTools.includes("*")
		? safeTools
		: requestedTools.filter((tool) => safeTools.includes(tool));
	return {
		...source,
		thinking: thinking ?? source.thinking,
		tools: confinedTools,
		mcpDirectTools: [],
		extensions: [CHILD_GUARD_PATH],
		defaultReads: [],
		output: undefined,
		interactive: false,
		completionGuard: false,
	};
}

export async function runWorkflowChild(req: ChildRunRequest): Promise<ChildRunResult> {
	// Clone the agent config so per-call overrides never leak into shared discovery results.
	const agent = confineAgentConfig(req.agent, req.tools, req.thinking);
	const modelOverride = req.model ?? req.agent.model ?? (req.parentModel || undefined);
	const structuredRuntime = req.schema
		? createStructuredOutputRuntime(req.schema, path.join(req.artifactDir, "structured-runtime"))
		: undefined;
	const policyStem = path.join(path.dirname(req.workspaceRoot), `.policy-${path.basename(req.workspaceRoot)}`);
	const policyPath = `${policyStem}.json`;
	const tokenPath = `${policyStem}.github-token`;
	try {
		await fs.promises.writeFile(policyPath, JSON.stringify({ network: req.network === true || req.githubAuth === true }), { mode: 0o600 });
		let githubToken = req.githubAuth ? (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN) : undefined;
		if (req.githubAuth && !githubToken) {
			try { githubToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; }
			catch { /* child will report an ordinary authentication failure */ }
		}
		if (githubToken) await fs.promises.writeFile(tokenPath, githubToken, { mode: 0o600 });
		const result = await runSync(req.cwd, [agent], agent.name, req.task, {
			runId: `${req.runId}-${req.label}`,
			cwd: req.cwd,
			signal: req.signal,
			timeoutMs: req.timeoutMs,
			maxTokens: req.maxTokens,
			sessionFile: req.sessionFile,
			modelOverride,
			structuredOutput: structuredRuntime,
		});
		const messages = result.messages ?? [];
		const text = (result.finalOutput ?? "").trim() || finalAssistantText(messages);
		return {
			exitCode: result.exitCode,
			text,
			messages,
			usage: result.usage,
			error: result.error ?? (result.timedOut ? `timed out after ${req.timeoutMs}ms` : undefined),
			cancelled: Boolean(result.interrupted || (req.signal.aborted && !result.timedOut)),
			timedOut: Boolean(result.timedOut),
			structuredOutput: result.structuredOutput,
			sessionFile: result.sessionFile ?? req.sessionFile,
		};
	} finally {
		try { cleanupStructuredOutputRuntime(structuredRuntime); }
		finally {
			await Promise.all([
				fs.promises.rm(policyPath, { force: true }),
				fs.promises.rm(tokenPath, { force: true }),
			]);
		}
	}
}

/**
 * Render a compact "output so far" view from a child's Pi session transcript. Works for both
 * running and finished agents: assistant text is shown verbatim, tool calls as one-liners
 * (`→ bash {"command":"..."}`); thinking blocks and tool results are omitted for brevity.
 */
export function renderSessionTail(sessionFile: string, maxLines = 40, maxChars = 6000): string {
	if (!sessionFile || !fs.existsSync(sessionFile)) return "(no transcript yet)";
	let raw: string;
	try {
		// Transcript inspection is a status surface, not an archival reader. Bound I/O so a
		// multi-gigabyte child session cannot stall the parent process.
		const stat = fs.statSync(sessionFile);
		const maxReadBytes = 256 * 1024;
		const start = Math.max(0, stat.size - maxReadBytes);
		const length = stat.size - start;
		const fd = fs.openSync(sessionFile, "r");
		try {
			const buffer = Buffer.alloc(length);
			fs.readSync(fd, buffer, 0, length, start);
			raw = buffer.toString("utf8");
			if (start > 0) raw = raw.slice(Math.max(0, raw.indexOf("\n") + 1));
		} finally {
			fs.closeSync(fd);
		}
	} catch (error: any) {
		return `(unable to read transcript: ${error?.message ?? String(error)})`;
	}
	const lines: string[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		for (const part of entry.message.content) {
			if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
				lines.push(...part.text.trim().split("\n"));
			} else if (part?.type === "toolCall") {
				let argSummary = "";
				try {
					argSummary = JSON.stringify(part.arguments ?? part.input ?? {});
				} catch {
					argSummary = "(unserialisable arguments)";
				}
				if (argSummary.length > 160) argSummary = `${argSummary.slice(0, 160)}…`;
				lines.push(`→ ${part.name ?? "tool"} ${argSummary}`);
			}
		}
	}
	if (lines.length === 0) return "(transcript exists but contains no assistant output yet)";
	const tail = lines.slice(-maxLines);
	const omitted = lines.length - tail.length;
	let text = tail.join("\n");
	if (text.length > maxChars) text = `…${text.slice(-maxChars)}`;
	return omitted > 0 ? `[… ${omitted} earlier transcript line(s) omitted]\n${text}` : text;
}

/** Fresh session path for a child; `--session` on an existing file would RESUME it. */
export function freshAgentSessionPath(runDir: string, safeLabel: string): string {
	const dir = path.join(runDir, "agents");
	fs.mkdirSync(dir, { recursive: true });
	let candidate = path.join(dir, `${safeLabel}.session.jsonl`);
	for (let n = 2; fs.existsSync(candidate); n++) {
		candidate = path.join(dir, `${safeLabel}-${n}.session.jsonl`);
	}
	return candidate;
}
