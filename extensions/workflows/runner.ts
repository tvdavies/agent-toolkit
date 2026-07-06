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
 * Acceptance contracts are deliberately NOT configured (omitting `acceptance` disables them):
 * workflow scripts do their own verification via reviewer/adversarial stages.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "pi-subagents/src/agents/agents.ts";
import { runSync } from "pi-subagents/src/runs/foreground/execution.ts";

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
	signal: AbortSignal;
}

export interface ChildRunResult {
	exitCode: number;
	text: string;
	messages: Message[];
	usage: ChildUsage;
	error?: string;
	/** True when the child was stopped (abort signal, interrupt, or timeout) rather than failing. */
	cancelled: boolean;
	sessionFile: string;
}

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

export async function runWorkflowChild(req: ChildRunRequest): Promise<ChildRunResult> {
	// Clone the agent config so per-call thinking/tools overrides never leak into the shared
	// discovery results (runSync reads thinking/tools from the AgentConfig, not from options).
	const agent: AgentConfig = {
		...req.agent,
		thinking: req.thinking ?? req.agent.thinking,
		tools: req.tools ?? req.agent.tools,
	};
	const modelOverride = req.model ?? req.agent.model ?? (req.parentModel || undefined);
	const result = await runSync(req.cwd, [agent], agent.name, req.task, {
		runId: `${req.runId}-${req.label}`,
		cwd: req.cwd,
		signal: req.signal,
		timeoutMs: req.timeoutMs,
		sessionFile: req.sessionFile,
		modelOverride,
	});
	const messages = result.messages ?? [];
	const text = (result.finalOutput ?? "").trim() || finalAssistantText(messages);
	return {
		exitCode: result.exitCode,
		text,
		messages,
		usage: result.usage,
		error: result.error ?? (result.timedOut ? `timed out after ${req.timeoutMs}ms` : undefined),
		cancelled: Boolean(result.interrupted || result.timedOut || req.signal.aborted),
		sessionFile: result.sessionFile ?? req.sessionFile,
	};
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
		raw = fs.readFileSync(sessionFile, "utf8");
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
