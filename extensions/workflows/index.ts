/**
 * Pi Dynamic Workflows extension.
 *
 * Discover trusted workflow scripts, approve project scripts by content hash,
 * run workflows in the background, orchestrate isolated Pi subagents, stream compact
 * progress via status/widget, post final reports, and persist run details to disk.
 *
 * Three behaviours make this functionally equivalent to Claude Code's Workflow tool
 * (see safeSendWorkflowMessage, the budget plumbing, and the session_start handler):
 *
 * - Wake on completion (transport, ALWAYS ON): when a background run finishes, its report
 *   is delivered via pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true }). When
 *   the agent is idle this triggers a fresh turn; when it is mid-stream the report rides the
 *   tail of the current turn. The runtime checks isStreaming atomically, so there is no
 *   idle/streaming race, and custom messages reach the LLM (convertToLlm maps them to user
 *   content). This is the equivalent of Claude Code resuming on a task-completion
 *   notification, and it is NOT gated on workflow mode — it fires for every run. Workflow
 *   mode only changes how readily the agent REACHES FOR workflows (see below), exactly as
 *   ultracode changes propensity, not the completion transport.
 *
 * - Shared token budget: budget.spent() pools this run's subagent output with the main
 *   loop's output (accumulated from message_end into mainLoopOutputTokens) since the run
 *   started; budget.remaining() is enforced — agent() throws once the per-run target
 *   (workflow_run's `budget` param or the PI_WORKFLOW_BUDGET env var) is exhausted. Null
 *   target => unbounded, matching Claude Code.
 *
 * - Guaranteed activation: session_start additively re-activates the workflow_run tool
 *   (without clobbering other active tools) so its description + guidelines always render,
 *   even under a --tools allowlist that would otherwise drop it.
 *
 * Workflow mode (/workflow-mode on, or PI_WORKFLOW_MODE) is the Pi analogue of ultracode:
 * it injects a standing directive (buildWorkflowSystemPromptAddendum) that overrides the
 * tool's default-to-yourself gate so substantive tasks are orchestrated by default. It is
 * prioritisation only and never affects the wake transport.
 */

import { spawn, execFile as execFileCb } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import { complete, type Message, type UserMessage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "pi-subagents/src/agents/agents.ts";

type RunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
type AgentStatus = "running" | "succeeded" | "failed" | "cancelled";
type WorkflowScope = "project" | "user";

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// Parsed from `export const meta = { ... }` at the top of a workflow script.
interface WorkflowMeta {
	name: string;
	description?: string;
	whenToUse?: string;
	model?: string;
	phases?: Array<{ title: string; detail?: string; model?: string }>;
}

interface CompiledWorkflow {
	meta: WorkflowMeta;
	run: (globals: WorkflowGlobals) => Promise<unknown>;
}

interface WorkflowFile {
	name: string;
	description?: string;
	path: string;
	scope: WorkflowScope;
	hash: string;
}

// Options accepted by the script-facing agent(prompt, opts) global (Claude Code shape).
interface AgentRunOptions {
	label?: string;
	phase?: string;
	schema?: unknown;
	model?: string;
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	isolation?: "none" | "worktree";
	agentType?: string;
}

// The globals injected into a workflow script body.
interface WorkflowGlobals {
	args: unknown;
	budget: { total: number | null; spent: () => number; remaining: () => number };
	agent: (prompt: string, opts?: AgentRunOptions) => Promise<unknown>;
	parallel: (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;
	pipeline: (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>) => Promise<unknown[]>;
	phase: (title: string) => void;
	log: (message: string) => void;
	workflow: (nameOrRef: unknown, args?: unknown) => Promise<unknown>;
}

// Internal options passed to runSingleAgent (the subagent runner).
interface AgentOptions {
	label: string;
	task: string;
	cwd?: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	agentScope?: AgentScope;
	timeoutMs?: number;
	expectedOutput?: "markdown" | "json" | "text";
	isolation?: "none" | "worktree";
	noCache?: boolean;
	// Progress group this agent belongs to. Lets a script attribute an agent to a named phase
	// independently of the global phase() cursor — important inside pipeline()/parallel() stages
	// where the global cursor races. Defaults to the run's current phase.
	phase?: string;
}

interface AgentResult {
	label: string;
	agent: string;
	status: "succeeded" | "failed" | "cancelled";
	text: string;
	json?: unknown;
	messages: Message[];
	usage: UsageStats;
	error?: string;
	worktree?: WorktreeResult;
}

interface WorktreeResult {
	path: string;
	diffPath?: string;
	diffBytes: number;
	status: string;
	preserved: boolean;
}

interface AgentRecord {
	label: string;
	agent: string;
	status: AgentStatus;
	startedAt: number;
	endedAt?: number;
	task?: string;
	error?: string;
	outputBytes?: number;
	usage?: UsageStats;
	cached?: boolean;
	phase?: string;
}

interface PhaseRecord {
	name: string;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
}

interface RunState {
	id: string;
	name: string;
	workflowPath: string;
	scope: WorkflowScope | "builtin" | "script";
	hash: string;
	cwd: string;
	args: string;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	currentPhase?: string;
	phases: PhaseRecord[];
	agents: AgentRecord[];
	agentCache?: Record<string, AgentResult>;
	report?: string;
	error?: string;
	runDir: string;
	meta?: WorkflowMeta;
	// Token budget (output tokens) for the whole run; null/undefined means unbounded.
	budgetTotal?: number | null;
	// mainLoopOutputTokens snapshot when the run started, so spent() counts only main-loop
	// output produced during the run.
	budgetBaselineOutput?: number;
}

const execFile = promisify(execFileCb);

const MAX_CONCURRENT_AGENTS = Math.max(1, Math.min(16, os.cpus().length - 2));
const MAX_AGENTS_PER_RUN = 1000;
const MAX_AGENT_OUTPUT_BYTES = 50 * 1024;
function parseMaxRunDurationMs(): number {
	const raw = process.env.PI_WORKFLOW_MAX_RUN_HOURS?.trim();
	if (!raw) return 6 * 60 * 60 * 1000;
	const hours = Number(raw);
	if (!Number.isFinite(hours) || hours <= 0) return 6 * 60 * 60 * 1000;
	return Math.min(hours, 24) * 60 * 60 * 1000;
}

const MAX_RUN_DURATION_MS = parseMaxRunDurationMs();
const EXTENSION_KEY = "workflows";
const USER_WORKFLOW_DIR = path.join(os.homedir(), ".pi", "agent", "workflows");
const USER_APPROVAL_FILE = path.join(os.homedir(), ".pi", "agent", "workflow-approvals.json");
const WORKFLOW_MODE_FILE = path.join(os.homedir(), ".pi", "agent", "workflow-mode.json");

const activeRuns = new Map<string, RunState>();
const abortControllers = new Map<string, AbortController>();
let lastCtx: any;
let lastPi: ExtensionAPI | undefined;

// Cumulative output tokens produced by the MAIN agent loop this session, accumulated from
// message_end events. Combined with each run's subagent output it gives budget.spent() a
// shared pool (main loop + workflow agents), matching Claude Code's turn-level budget.
let mainLoopOutputTokens = 0;

// Prefixed to the report when a finished background workflow is delivered back into the
// session. The delivery WAKES the agent (triggerTurn), so the framing tells it the message
// is an automated completion notification it should act on — not a user prompt.
const WORKFLOW_RESULT_BANNER =
	"[Automated background notification — NOT a user message. A workflow you launched has finished. If the task is still in progress, act on these results now (e.g. read them and launch the next phase); otherwise summarise the outcome for the user.]";

function parseBudgetEnv(): number | null {
	const raw = process.env.PI_WORKFLOW_BUDGET?.trim();
	if (!raw) return null;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function sha256(text: string): string {
	return crypto.createHash("sha256").update(text).digest("hex");
}

function shortHash(text: string): string {
	return sha256(text).slice(0, 12);
}

function safeName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
}

function nowIso(): string {
	return new Date().toISOString();
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return mins > 0 ? `${mins}m${secs.toString().padStart(2, "0")}s` : `${secs}s`;
}

function findProjectRoot(cwd: string): string | null {
	let current = cwd;
	while (true) {
		if (fs.existsSync(path.join(current, ".git")) || fs.existsSync(path.join(current, ".pi"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function projectWorkflowDir(cwd: string): string | null {
	const root = findProjectRoot(cwd);
	return root ? path.join(root, ".pi", "workflows") : null;
}

function runBaseDir(cwd: string): string {
	const root = findProjectRoot(cwd);
	if (root) return path.join(root, ".pi", "workflow-runs");
	return path.join(os.homedir(), ".pi", "agent", "workflow-runs", shortHash(cwd));
}

function readJsonFile<T>(filePath: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch {
		return fallback;
	}
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await fs.promises.appendFile(filePath, `${JSON.stringify({ ts: nowIso(), ...value })}\n`, "utf8");
}

function discoverWorkflows(cwd: string): WorkflowFile[] {
	const dirs: Array<{ dir: string; scope: WorkflowScope }> = [];
	const projectDir = projectWorkflowDir(cwd);
	if (projectDir) dirs.push({ dir: projectDir, scope: "project" });
	dirs.push({ dir: USER_WORKFLOW_DIR, scope: "user" });

	const byName = new Map<string, WorkflowFile>();
	for (const { dir, scope } of dirs) {
		if (!fs.existsSync(dir)) continue;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !/\.(ts|js|mjs|cjs)$/.test(entry.name)) continue;
			const filePath = path.join(dir, entry.name);
			let source = "";
			try {
				source = fs.readFileSync(filePath, "utf8");
			} catch {
				continue;
			}
			const name = safeName(path.basename(entry.name).replace(/\.(ts|js|mjs|cjs)$/, ""));
			const wf = { name, path: filePath, scope, hash: sha256(source) };
			// Project workflows shadow user workflows because dirs are ordered project first.
			if (!byName.has(name)) byName.set(name, wf);
		}
	}
	return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

type WorkflowMode = { enabled: boolean; source: "command" | "env" | "default" };

function parseEnvFlag(raw: string | undefined): boolean | undefined {
	if (raw === undefined) return undefined;
	const value = raw.trim().toLowerCase();
	if (["1", "true", "on", "yes"].includes(value)) return true;
	if (["0", "false", "off", "no", ""].includes(value)) return false;
	return undefined;
}

// Standing workflow mode: an explicit /workflow-mode choice (persisted) wins; otherwise the
// PI_WORKFLOW_MODE env var sets the default for headless/automation runs; otherwise off.
function readWorkflowMode(): WorkflowMode {
	const stored = readJsonFile<{ enabled?: unknown } | null>(WORKFLOW_MODE_FILE, null);
	if (stored && typeof stored.enabled === "boolean") return { enabled: stored.enabled, source: "command" };
	const envFlag = parseEnvFlag(process.env.PI_WORKFLOW_MODE);
	if (envFlag !== undefined) return { enabled: envFlag, source: "env" };
	return { enabled: false, source: "default" };
}

async function writeWorkflowMode(enabled: boolean): Promise<void> {
	await writeJsonFile(WORKFLOW_MODE_FILE, { enabled });
}

async function clearWorkflowMode(): Promise<void> {
	await fs.promises.rm(WORKFLOW_MODE_FILE, { force: true });
}

// Injected into the main agent's system prompt before each turn. When workflow mode is ON this
// carries a STANDING orchestration directive that explicitly overrides the workflow_run tool's
// conservative default-to-yourself gate (the Pi analogue of Claude Code's ultracode mode); when
// OFF it states the conservative default. It also lists runnable saved workflows and subagents.
function buildWorkflowSystemPromptAddendum(cwd: string): string | null {
	const mode = readWorkflowMode();
	const workflows = discoverWorkflows(cwd);
	if (!mode.enabled && workflows.length === 0) return null;

	const sections: string[] = ["## Workflow orchestration (workflow_run tool)"];

	if (mode.enabled) {
		sections.push(
			"Workflow mode is ON. This is a STANDING directive that OVERRIDES the workflow_run tool's default-to-yourself decision gate. For every substantive task — anything needing breadth (a surface too large to cover serially), confidence (independent perspectives or adversarial verification before a risky output), or scale (more than one context can hold) — author and run a workflow by DEFAULT instead of doing the work serially yourself. Optimise for the most thorough, correct result; token cost is not the constraint. Scout the work-list inline first (list the files, the diff, the items), then fan out; for multi-phase work run several workflows in sequence and act on each report as it arrives (the tool wakes you when each finishes). Handle only trivial, mechanical, or conversational turns inline. Prefer mode:'script' so you control the orchestration; use pipeline() by default and add an adversarial verification pass for anything risky.",
		);
	} else {
		sections.push(
			"Default to handling tasks yourself. Reach for workflow_run only when a task genuinely needs breadth, confidence, or scale that serial work cannot give. (Enable standing orchestration with /workflow-mode on.)",
		);
	}

	const workflowLines = workflows.length
		? workflows.map((w) => `- ${w.name} (${w.scope})`).join("\n")
		: "- (none saved — use workflow_run mode:'script' to author one inline, or mode:'generate')";
	sections.push(`Saved workflows (run with workflow_run mode:'saved'):\n${workflowLines}`);

	try {
		const agents = discoverAgents(cwd, "user").agents;
		const agentLines = agents
			.slice(0, 24)
			.map((a) => {
				const summary = a.description ? ` — ${a.description.split("\n")[0].slice(0, 100)}` : "";
				return `- ${a.name}${summary}`;
			})
			.join("\n");
		if (agentLines) sections.push(`Subagents available to workflow scripts (agent(prompt, { agentType }), default scope):\n${agentLines}`);
	} catch {
		// Agent discovery is best-effort; a missing roster must not block the turn.
	}

	return sections.join("\n\n");
}

// Blank out string/template/comment contents (preserving length) so pattern checks and
// brace matching only see real code, not prompt text that may contain "process" etc.
function stripStringsAndComments(src: string): string {
	let out = "";
	let i = 0;
	const n = src.length;
	while (i < n) {
		const c = src[i];
		const next = src[i + 1];
		if (c === "/" && next === "/") {
			while (i < n && src[i] !== "\n") { out += " "; i++; }
			continue;
		}
		if (c === "/" && next === "*") {
			out += "  "; i += 2;
			while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
			if (i < n) { out += "  "; i += 2; }
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			out += " "; i++;
			while (i < n) {
				if (src[i] === "\\") { out += "  "; i += 2; continue; }
				if (src[i] === quote) { out += " "; i++; break; }
				out += src[i] === "\n" ? "\n" : " "; i++;
			}
			continue;
		}
		out += c; i++;
	}
	return out;
}

function findMatchingBrace(src: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function extractMeta(source: string): WorkflowMeta {
	const stripped = stripStringsAndComments(source);
	const match = stripped.match(/export\s+const\s+meta\s*=\s*/);
	if (!match || match.index === undefined) throw new Error("Workflow must define `export const meta = { name, description }`.");
	const braceStart = stripped.indexOf("{", match.index + match[0].length);
	if (braceStart === -1) throw new Error("`meta` must be an object literal.");
	const braceEnd = findMatchingBrace(stripped, braceStart);
	if (braceEnd === -1) throw new Error("Unterminated `meta` object literal.");
	const literal = source.slice(braceStart, braceEnd + 1);
	let meta: WorkflowMeta;
	try {
		const sandbox = vm.createContext(Object.create(null));
		meta = new vm.Script(`"use strict";(${literal})`, { timeout: 1000 }).runInContext(sandbox, { timeout: 1000 }) as WorkflowMeta;
	} catch (error: any) {
		throw new Error(`meta must be a plain object literal: ${error?.message ?? String(error)}`);
	}
	if (!meta || typeof meta.name !== "string" || !meta.name.trim()) throw new Error("`meta.name` is required and must be a non-empty string.");
	return meta;
}

function validateScript(source: string): string[] {
	const errors: string[] = [];
	const code = stripStringsAndComments(source);
	if (/(^|\n)\s*import\b/.test(code)) {
		errors.push("Workflow scripts must not import anything; use the injected globals (agent, parallel, pipeline, phase, log, workflow, args, budget).");
	}
	if (/(^|\n)\s*export\s+(?!const\s+meta\b)/.test(code)) {
		errors.push("Only `export const meta` is allowed; the rest of the script uses the injected globals.");
	}
	const forbidden = [/\brequire\s*\(/, /\bprocess\b/, /\bDate\.now\s*\(/, /\bMath\.random\s*\(/, /\bnew\s+Date\s*\(\s*\)/, /\beval\s*\(/, /\bFunction\s*\(/, /\bimport\s*\(/];
	for (const re of forbidden) {
		if (re.test(code)) errors.push(`Forbidden pattern (non-deterministic or unsafe): ${re}`);
	}
	if (!/export\s+const\s+meta\s*=/.test(code)) {
		errors.push("Workflow must define `export const meta = { name, description }`.");
	}
	return errors;
}

function loadWorkflowFromSource(source: string, filePath: string): CompiledWorkflow {
	const errors = validateScript(source);
	if (errors.length > 0) throw new Error(errors.join("\n"));
	const meta = extractMeta(source);
	// Neutralise the meta export so the remaining body can run inside a function wrapper.
	const body = source.replace(/(^|\n)(\s*)export\s+const\s+meta\s*=/, "$1$2const meta =");
	const wrapped = `"use strict";\n__workflowRun = async function (agent, parallel, pipeline, phase, log, workflow, args, budget) {\n${body}\n};`;
	try {
		const sandbox = vm.createContext(Object.create(null));
		Object.defineProperty(sandbox, "__workflowRun", { value: undefined, writable: true, enumerable: true });
		new vm.Script(wrapped, { filename: filePath }).runInContext(sandbox);
		const fn = (sandbox as any).__workflowRun as ((...injected: unknown[]) => Promise<unknown>) | undefined;
		if (typeof fn !== "function") throw new Error("Workflow body did not compile to a runnable function.");
		return {
			meta,
			run: (g) => Promise.resolve(fn(g.agent, g.parallel, g.pipeline, g.phase, g.log, g.workflow, g.args, g.budget)),
		};
	} catch (error: any) {
		throw new Error(`Failed to load ${filePath}: ${error?.message ?? String(error)}`);
	}
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) if (part.type === "text") return part.text;
		}
	}
	return "";
}

function truncateBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let out = text.slice(0, maxBytes);
	while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
	return `${out}\n\n[truncated; full output preserved on disk]`;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-agent-"));
	const filePath = path.join(tmpDir, `prompt-${safeName(agentName)}.md`);
	await withFileMutationQueue(filePath, async () => fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 }));
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
		return true;
	} catch {
		return false;
	}
}

async function createAgentWorktree(run: RunState, label: string, cwd: string): Promise<{ path: string; relativeCwd: string }> {
	if (!(await isGitRepo(cwd))) throw new Error('Agent requested isolation: "worktree", but cwd is not inside a git work tree.');
	const { stdout: rootStdout } = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd });
	const root = rootStdout.trim();
	const relativeCwd = path.relative(root, cwd) || ".";
	const worktreeBase = path.join(run.runDir, "worktrees");
	await fs.promises.mkdir(worktreeBase, { recursive: true });
	const worktreePath = path.join(worktreeBase, safeName(label));
	await fs.promises.rm(worktreePath, { recursive: true, force: true });
	await execFile("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], { cwd: root });
	await persistRun(run, { type: "worktree_created", label, path: worktreePath, relativeCwd });
	return { path: worktreePath, relativeCwd };
}

async function finalizeAgentWorktree(run: RunState, label: string, worktreePath: string): Promise<WorktreeResult> {
	let status = "";
	let diff = "";
	try {
		const statusResult = await execFile("git", ["status", "--short"], { cwd: worktreePath });
		status = statusResult.stdout;
	} catch (error: any) {
		status = `Unable to read worktree status: ${error?.message ?? String(error)}`;
	}
	try {
		const diffResult = await execFile("git", ["diff", "--binary", "HEAD"], { cwd: worktreePath, maxBuffer: 50 * 1024 * 1024 });
		diff = diffResult.stdout;
		const untracked = (await execFile("git", ["ls-files", "--others", "--exclude-standard"], { cwd: worktreePath })).stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		for (const file of untracked) {
			try {
				const untrackedDiff = await execFile("git", ["diff", "--no-index", "--binary", "--", "/dev/null", file], { cwd: worktreePath, maxBuffer: 50 * 1024 * 1024 });
				diff += untrackedDiff.stdout;
			} catch (error: any) {
				// git diff --no-index exits non-zero when files differ; stdout still contains the patch.
				if (error?.stdout) diff += error.stdout;
				else diff += `\n--- untracked ${file}\n${await fs.promises.readFile(path.join(worktreePath, file), "utf8").catch(() => "(binary or unreadable)")}\n`;
			}
		}
	} catch (error: any) {
		diff = `Unable to read worktree diff: ${error?.message ?? String(error)}`;
	}
	const hasChanges = status.trim().length > 0 || diff.trim().length > 0;
	let diffPath: string | undefined;
	if (hasChanges) {
		const diffDir = path.join(run.runDir, "worktree-diffs");
		await fs.promises.mkdir(diffDir, { recursive: true });
		diffPath = path.join(diffDir, `${safeName(label)}.diff`);
		await fs.promises.writeFile(diffPath, diff || status, "utf8");
		await persistRun(run, { type: "worktree_preserved", label, path: worktreePath, diffPath, diffBytes: Buffer.byteLength(diff || status, "utf8"), status });
		return { path: worktreePath, diffPath, diffBytes: Buffer.byteLength(diff || status, "utf8"), status, preserved: true };
	}
	try {
		await execFile("git", ["worktree", "remove", "--force", worktreePath], { cwd: worktreePath });
	} catch {
		await fs.promises.rm(worktreePath, { recursive: true, force: true });
	}
	await persistRun(run, { type: "worktree_removed", label, path: worktreePath });
	return { path: worktreePath, diffBytes: 0, status, preserved: false };
}

async function runSingleAgent(run: RunState, agentName: string, options: AgentOptions, signal: AbortSignal, parentModel: string): Promise<AgentResult> {
	const cacheKey = agentCacheKey(run, agentName, options);
	const cached = options.noCache ? undefined : run.agentCache?.[cacheKey];
	if (cached?.status === "succeeded") {
		const record: AgentRecord = {
			label: options.label,
			agent: agentName,
			status: "succeeded",
			startedAt: Date.now(),
			endedAt: Date.now(),
			task: options.task,
			outputBytes: Buffer.byteLength(cached.text || "", "utf8"),
			usage: zeroUsage(),
			cached: true,
			phase: options.phase ?? run.currentPhase,
		};
		run.agents.push(record);
		await persistRun(run, { type: "agent_cache_hit", label: options.label, agent: agentName, cacheKey });
		updateUi(run);
		return { ...cached, usage: zeroUsage(), messages: cached.messages ?? [] };
	}

	const agentScope = options.agentScope ?? "user";
	const discovery = discoverAgents(options.cwd ?? run.cwd, agentScope);
	const agent = discovery.agents.find((a) => a.name === agentName);
	const record: AgentRecord = { label: options.label, agent: agentName, status: "running", startedAt: Date.now(), task: options.task, phase: options.phase ?? run.currentPhase };
	run.agents.push(record);
	await persistRun(run, { type: "agent_start", label: options.label, agent: agentName, task: options.task, cacheKey });
	updateUi(run);

	if (!agent) {
		const available = discovery.agents.map((a) => a.name).join(", ") || "none";
		record.status = "failed";
		record.endedAt = Date.now();
		record.error = `Unknown agent ${agentName}. Available: ${available}`;
		await persistRun(run, { type: "agent_end", label: options.label, status: record.status, error: record.error });
		return { label: options.label, agent: agentName, status: "failed", text: "", messages: [], usage: zeroUsage(), error: record.error };
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let executionCwd = options.cwd ?? run.cwd;
	let worktreePath: string | undefined;
	let worktreeResult: WorktreeResult | undefined;
	const messages: Message[] = [];
	let stderr = "";
	let wasAborted = false;
	const usage = zeroUsage();
	let stopReason: string | undefined;
	let errorMessage: string | undefined;

	try {
		if (options.isolation === "worktree") {
			const worktree = await createAgentWorktree(run, options.label, executionCwd);
			worktreePath = worktree.path;
			executionCwd = path.join(worktree.path, worktree.relativeCwd);
		}

		const args = ["--mode", "json", "-p", "--no-session"];
		args.push("--model", options.model ?? agent.model ?? parentModel);
		if (options.thinking) args.push("--thinking", options.thinking);
		const tools = options.tools ?? agent.tools;
		if (tools && tools.length > 0) args.push("--tools", tools.join(","));
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}
		args.push(`Task: ${options.task}`);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, { cwd: executionCwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";
			const timeout = options.timeoutMs ? setTimeout(() => {
				wasAborted = true;
				proc.kill("SIGTERM");
			}, options.timeoutMs) : null;

			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
			};
			if (signal.aborted) killProc(); else signal.addEventListener("abort", killProc, { once: true });

			const processLine = async (line: string) => {
				if (!line.trim()) return;
				await appendJsonl(path.join(run.runDir, "agents", `${safeName(options.label)}.jsonl`), { raw: line });
				let event: any;
				try { event = JSON.parse(line); } catch { return; }
				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					messages.push(msg);
					if (msg.role === "assistant") {
						usage.turns++;
						const msgUsage = msg.usage;
						if (msgUsage) {
							usage.input += msgUsage.input || 0;
							usage.output += msgUsage.output || 0;
							usage.cacheRead += msgUsage.cacheRead || 0;
							usage.cacheWrite += msgUsage.cacheWrite || 0;
							usage.cost += msgUsage.cost?.total || 0;
						}
						stopReason = msg.stopReason;
						errorMessage = msg.errorMessage;
					}
				}
				if (event.type === "tool_result_end" && event.message) messages.push(event.message as Message);
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) void processLine(line);
			});
			proc.stderr.on("data", (data) => { stderr += data.toString(); });
			proc.on("close", (code) => {
				if (timeout) clearTimeout(timeout);
				if (buffer.trim()) void processLine(buffer);
				resolve(code ?? 0);
			});
			proc.on("error", () => resolve(1));
		});

		if (worktreePath) worktreeResult = await finalizeAgentWorktree(run, options.label, worktreePath);

		const output = getFinalOutput(messages);
		const failed = exitCode !== 0 || stopReason === "error" || stopReason === "aborted" || wasAborted;
		record.status = failed ? (wasAborted ? "cancelled" : "failed") : "succeeded";
		record.endedAt = Date.now();
		record.outputBytes = Buffer.byteLength(output, "utf8");
		record.usage = usage;
		record.error = failed ? (errorMessage || stderr || `exit code ${exitCode}`) : undefined;
		const worktreeNote = worktreeResult?.preserved
			? `\n\n[Worktree changes preserved at ${worktreeResult.path}; diff: ${worktreeResult.diffPath}]`
			: "";
		const result: AgentResult = {
			label: options.label,
			agent: agentName,
			status: record.status === "succeeded" ? "succeeded" : record.status === "cancelled" ? "cancelled" : "failed",
			text: truncateBytes(`${output || record.error || ""}${worktreeNote}`, MAX_AGENT_OUTPUT_BYTES),
			messages,
			usage,
			error: record.error,
			worktree: worktreeResult,
		};
		if (options.expectedOutput === "json" && result.text) {
			try { result.json = JSON.parse(result.text); } catch { /* leave undefined */ }
		}
		if (result.status === "succeeded" && !options.noCache) {
			run.agentCache ??= {};
			run.agentCache[cacheKey] = result;
		}
		await persistRun(run, { type: "agent_end", label: options.label, status: record.status, usage, error: record.error, cacheKey });
		updateUi(run);
		return result;
	} finally {
		if (worktreePath && !worktreeResult) {
			try { await finalizeAgentWorktree(run, options.label, worktreePath); } catch { /* preserve on unexpected cleanup failure */ }
		}
		if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
	}
}

function zeroUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")}}`;
}

function agentCacheKey(run: RunState, agentName: string, options: AgentOptions): string {
	return sha256(stableJson({
		workflowHash: run.hash,
		args: run.args,
		label: options.label,
		agent: agentName,
		task: options.task,
		cwd: options.cwd ?? run.cwd,
		model: options.model,
		thinking: options.thinking,
		tools: options.tools,
		agentScope: options.agentScope ?? "user",
		expectedOutput: options.expectedOutput,
		isolation: options.isolation ?? "none",
		noCache: options.noCache ?? false,
	}));
}

function aggregateUsage(run: RunState): UsageStats {
	const total = zeroUsage();
	for (const agent of run.agents) {
		if (!agent.usage) continue;
		total.input += agent.usage.input;
		total.output += agent.usage.output;
		total.cacheRead += agent.usage.cacheRead;
		total.cacheWrite += agent.usage.cacheWrite;
		total.cost += agent.usage.cost;
		total.turns += agent.usage.turns;
	}
	return total;
}

// budget.spent() = output tokens spent by this run's subagents PLUS main-loop output produced
// since the run started (a shared pool, like Claude Code). remaining() is Infinity when no
// budget was set, otherwise max(0, total - spent).
function workflowSpent(run: RunState): number {
	const baseline = run.budgetBaselineOutput ?? mainLoopOutputTokens;
	const mainLoopDelta = Math.max(0, mainLoopOutputTokens - baseline);
	return aggregateUsage(run).output + mainLoopDelta;
}

function workflowRemaining(run: RunState): number {
	if (run.budgetTotal == null) return Number.POSITIVE_INFINITY;
	return Math.max(0, run.budgetTotal - workflowSpent(run));
}

async function persistRun(run: RunState, event: Record<string, unknown>): Promise<void> {
	await fs.promises.mkdir(run.runDir, { recursive: true });
	await appendJsonl(path.join(run.runDir, "events.jsonl"), event);
	await writeJsonFile(path.join(run.runDir, "state.json"), run);
	await writeJsonFile(path.join(run.runDir, "manifest.json"), {
		id: run.id, name: run.name, args: run.args, cwd: run.cwd, workflowPath: run.workflowPath, scope: run.scope, hash: run.hash,
		startedAt: run.startedAt, endedAt: run.endedAt, status: run.status,
	});
}

function updateUi(run: RunState): void {
	try {
		if (!lastCtx?.ui) return;
		const total = run.agents.length;
		const done = run.agents.filter((a) => a.status !== "running").length;
		const running = run.agents.filter((a) => a.status === "running").length;
		const failed = run.agents.filter((a) => a.status === "failed").length;
		lastCtx.ui.setStatus(EXTENSION_KEY, `flow: ${run.name} ${done}/${total}${running ? ` (${running} running)` : ""}`);
		const lines = [`Workflow ${run.name}: ${run.status}`, `Phase: ${run.currentPhase ?? "-"}`, `Agents: ${done}/${total} done, ${running} running${failed ? `, ${failed} failed` : ""}`];
		for (const phase of run.phases.slice(-5)) {
			const icon = phase.status === "succeeded" ? "✓" : phase.status === "running" ? "⏳" : phase.status === "failed" ? "✗" : "○";
			const inPhase = run.agents.filter((a) => a.phase === phase.name);
			const phaseDone = inPhase.filter((a) => a.status !== "running").length;
			lines.push(`${icon} ${phase.name}${inPhase.length ? ` (${phaseDone}/${inPhase.length})` : ""}`);
		}
		lastCtx.ui.setWidget(EXTENSION_KEY, lines);
	} catch {
		// Command contexts can become stale after print-mode command completion. UI
		// progress is best-effort; persisted events remain authoritative.
	}
}

async function clearUiIfNoActive(): Promise<void> {
	try {
		if (!lastCtx?.ui) return;
		if (Array.from(activeRuns.values()).some((r) => r.status === "running" || r.status === "pending")) return;
		lastCtx.ui.setStatus(EXTENSION_KEY, "flow: idle");
		lastCtx.ui.setWidget(EXTENSION_KEY, []);
	} catch {
		// Best-effort UI cleanup only.
	}
}

// Deliver the final workflow report back into the session AND wake the agent to act on it.
// triggerTurn:true triggers a fresh turn when the agent is idle; deliverAs:"followUp" makes it
// ride the tail of an in-flight turn instead (the runtime checks isStreaming atomically, so
// there is no idle/streaming race). Custom messages are surfaced to the LLM as user content,
// so the woken agent sees the report. This is what lets it chain workflow phases the way
// Claude Code resumes on a task-completion notification, rather than fire-and-forget.
function safeSendWorkflowMessage(pi: ExtensionAPI, content: string): void {
	const framed = `${WORKFLOW_RESULT_BANNER}\n\n${content}`;
	try {
		pi.sendMessage({ customType: "workflow-result", display: true, content: framed }, { deliverAs: "followUp", triggerTurn: true });
	} catch {
		// In print mode or after session replacement the extension API may be stale.
		// The final report remains available in the persisted run state.
	}
}

// Maps Claude-style agentType names onto the Pi subagents this runtime can spawn.
const AGENT_TYPE_ALIASES: Record<string, string> = {
	"general-purpose": "delegate",
	general: "delegate",
	explore: "scout",
	search: "scout",
	plan: "planner",
	"code-reviewer": "reviewer",
	review: "reviewer",
	research: "researcher",
};

function safeDiscoverAgentNames(cwd: string): string[] {
	try {
		return discoverAgents(cwd, "user").agents.map((a) => a.name);
	} catch {
		return ["delegate"];
	}
}

function mapAgentType(agentType: unknown, knownAgents: Set<string>): string {
	if (typeof agentType !== "string" || !agentType.trim()) return "delegate";
	const raw = agentType.trim();
	if (knownAgents.has(raw)) return raw;
	const alias = AGENT_TYPE_ALIASES[raw.toLowerCase()];
	if (alias && knownAgents.has(alias)) return alias;
	return knownAgents.has("delegate") ? "delegate" : raw;
}

// Pi uses "provider/id" model identifiers; bare Claude aliases (sonnet/opus/...) are ignored
// so the subagent inherits the parent model rather than failing to resolve.
function mapModel(model: unknown): string | undefined {
	return typeof model === "string" && model.includes("/") ? model : undefined;
}

function mapEffort(effort: unknown): ThinkingLevel | undefined {
	switch (effort) {
		case "low": return "low";
		case "medium": return "medium";
		case "high": return "high";
		case "xhigh":
		case "max": return "xhigh";
		default: return undefined;
	}
}

function createSemaphore(max: number) {
	let active = 0;
	const queue: Array<() => void> = [];
	return {
		async acquire(): Promise<void> {
			if (active < max) { active++; return; }
			await new Promise<void>((resolve) => queue.push(resolve));
			active++;
		},
		release(): void {
			active--;
			const next = queue.shift();
			if (next) next();
		},
	};
}

function buildAgentTask(prompt: string, schema?: unknown): string {
	if (schema === undefined) return prompt;
	return `${prompt}\n\nReturn ONLY a single JSON value matching this JSON Schema, with no prose and no code fence:\n${JSON.stringify(schema)}`;
}

function parseLooseJson(text: string): unknown {
	const trimmed = (text ?? "").trim();
	const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = fence ? fence[1].trim() : trimmed;
	try { return JSON.parse(candidate); } catch { return null; }
}

function parseWorkflowArgs(args: string): unknown {
	const trimmed = (args ?? "").trim();
	if (!trimmed) return undefined;
	try { return JSON.parse(trimmed); } catch { return args; }
}

function formatWorkflowResult(result: unknown): string {
	if (typeof result === "string") return result;
	if (result === undefined || result === null) return "(workflow completed with no result)";
	try { return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``; } catch { return String(result); }
}

function closeOpenPhase(run: RunState, status: RunStatus = "succeeded"): void {
	const current = run.phases[run.phases.length - 1];
	if (current && current.status === "running") {
		current.status = status;
		current.endedAt = Date.now();
		void persistRun(run, { type: "phase_end", name: current.name, status });
	}
}

// Shared per-run state so nested workflow() calls reuse one concurrency budget and agent counter.
interface WorkflowEngine {
	semaphore: ReturnType<typeof createSemaphore>;
	agentCount: { n: number };
	labelSeq: { n: number };
	depth: number;
}

function resolveNestedWorkflow(nameOrRef: unknown, cwd: string): WorkflowFile {
	if (nameOrRef && typeof nameOrRef === "object" && typeof (nameOrRef as { scriptPath?: unknown }).scriptPath === "string") {
		const scriptPath = (nameOrRef as { scriptPath: string }).scriptPath;
		if (!fs.existsSync(scriptPath)) throw new Error(`workflow() scriptPath not found: ${scriptPath}`);
		const source = fs.readFileSync(scriptPath, "utf8");
		return { name: safeName(path.basename(scriptPath).replace(/\.[^.]+$/, "")), path: scriptPath, scope: "user", hash: sha256(source) };
	}
	const name = typeof nameOrRef === "string"
		? nameOrRef
		: nameOrRef && typeof (nameOrRef as { name?: unknown }).name === "string"
			? (nameOrRef as { name: string }).name
			: "";
	if (!name) throw new Error("workflow(nameOrRef) requires a saved workflow name or { scriptPath }.");
	const wf = discoverWorkflows(cwd).find((w) => w.name === safeName(name));
	if (!wf) throw new Error(`Nested workflow not found: ${name}`);
	return wf;
}

// Builds the Claude Code workflow-script globals on top of the Pi run machinery.
function createWorkflowGlobals(
	run: RunState,
	controller: AbortController,
	parentModel: string,
	knownAgents: Set<string>,
	args: unknown,
	engine: WorkflowEngine = { semaphore: createSemaphore(MAX_CONCURRENT_AGENTS), agentCount: { n: 0 }, labelSeq: { n: 0 }, depth: 0 },
): WorkflowGlobals {
	const runAgent = async (prompt: string, opts: AgentRunOptions = {}): Promise<unknown> => {
		if (typeof prompt !== "string" || !prompt.trim()) throw new Error("agent(prompt) requires a non-empty prompt string.");
		if (controller.signal.aborted) return null;
		engine.agentCount.n++;
		if (engine.agentCount.n > MAX_AGENTS_PER_RUN) throw new Error(`Workflow exceeded the per-run agent limit (${MAX_AGENTS_PER_RUN}).`);
		if (run.budgetTotal != null && workflowRemaining(run) <= 0) {
			throw new Error(`Workflow exhausted its token budget (${run.budgetTotal} output tokens; spent ${workflowSpent(run)}). Gate loops on budget.remaining() to stop before this throws.`);
		}
		const label = typeof opts.label === "string" && opts.label.trim() ? opts.label.trim() : `agent-${++engine.labelSeq.n}`;
		const options: AgentOptions = {
			label,
			task: buildAgentTask(prompt, opts.schema),
			model: mapModel(opts.model),
			thinking: mapEffort(opts.effort),
			expectedOutput: opts.schema !== undefined ? "json" : "text",
			isolation: opts.isolation === "worktree" ? "worktree" : "none",
			phase: typeof opts.phase === "string" && opts.phase.trim() ? opts.phase.trim() : run.currentPhase,
		};
		await engine.semaphore.acquire();
		let result: AgentResult;
		try {
			result = await runSingleAgent(run, mapAgentType(opts.agentType, knownAgents), options, controller.signal, parentModel);
		} finally {
			engine.semaphore.release();
		}
		if (result.status !== "succeeded") return null;
		if (opts.schema !== undefined) return result.json ?? parseLooseJson(result.text);
		return result.text;
	};

	return {
		args,
		budget: { total: run.budgetTotal ?? null, spent: () => workflowSpent(run), remaining: () => workflowRemaining(run) },
		agent: runAgent,
		async parallel(thunks) {
			if (!Array.isArray(thunks)) throw new Error("parallel(thunks) requires an array of functions.");
			if (thunks.length > 4096) throw new Error("parallel() accepts at most 4096 thunks.");
			return Promise.all(thunks.map((thunk) => Promise.resolve().then(() => thunk()).catch(() => null)));
		},
		async pipeline(items, ...stages) {
			if (!Array.isArray(items)) throw new Error("pipeline(items, ...stages) requires an array of items.");
			if (items.length > 4096) throw new Error("pipeline() accepts at most 4096 items.");
			return Promise.all(items.map(async (item, index) => {
				try {
					let prev: unknown = item;
					for (const stage of stages) prev = await stage(prev, item, index);
					return prev;
				} catch {
					return null;
				}
			}));
		},
		phase(title) {
			closeOpenPhase(run);
			const record: PhaseRecord = { name: String(title), status: "running", startedAt: Date.now() };
			run.currentPhase = String(title);
			run.phases.push(record);
			void persistRun(run, { type: "phase_start", name: record.name });
			updateUi(run);
		},
		log(message) {
			void persistRun(run, { type: "log", message: String(message) });
			updateUi(run);
		},
		async workflow(nameOrRef, subArgs) {
			if (engine.depth >= 1) throw new Error("workflow() nesting is one level only.");
			const wf = resolveNestedWorkflow(nameOrRef, run.cwd);
			const source = await fs.promises.readFile(wf.path, "utf8");
			const compiled = loadWorkflowFromSource(source, wf.path);
			await persistRun(run, { type: "nested_workflow_start", name: compiled.meta.name, parent: run.name });
			const childGlobals = createWorkflowGlobals(run, controller, parentModel, knownAgents, subArgs, { ...engine, depth: engine.depth + 1 });
			const result = await compiled.run(childGlobals);
			await persistRun(run, { type: "nested_workflow_end", name: compiled.meta.name });
			return result;
		},
	};
}

async function startRun(pi: ExtensionAPI, workflowFile: WorkflowFile, args: string, ctx: any, options?: { reuseFrom?: RunState; budget?: number | null }): Promise<RunState> {
	lastCtx = ctx;
	lastPi = pi;
	const source = await fs.promises.readFile(workflowFile.path, "utf8");
	const compiled = loadWorkflowFromSource(source, workflowFile.path);
	const name = safeName(compiled.meta.name || workflowFile.name);
	const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
	const runDir = path.join(runBaseDir(ctx.cwd), id);
	const inheritedCache = options?.reuseFrom?.hash === workflowFile.hash && options.reuseFrom.args === args ? options.reuseFrom.agentCache : undefined;
	const budgetTotal = options?.budget != null && Number.isFinite(options.budget) && options.budget > 0 ? options.budget : parseBudgetEnv();
	const run: RunState = { id, name, workflowPath: workflowFile.path, scope: workflowFile.scope, hash: workflowFile.hash, cwd: ctx.cwd, args, status: "pending", startedAt: Date.now(), phases: [], agents: [], agentCache: inheritedCache ? { ...inheritedCache } : {}, runDir, meta: compiled.meta, budgetTotal, budgetBaselineOutput: mainLoopOutputTokens };
	const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
	const knownAgents = new Set<string>(safeDiscoverAgentNames(ctx.cwd));
	await fs.promises.mkdir(runDir, { recursive: true });
	await fs.promises.writeFile(path.join(runDir, "script.ts"), source, "utf8");
	await persistRun(run, { type: "run_created" });
	activeRuns.set(id, run);
	const controller = new AbortController();
	abortControllers.set(id, controller);

	void (async () => {
		const runTimeout = setTimeout(() => {
			controller.abort();
			void persistRun(run, { type: "run_timeout", maxRunDurationMs: MAX_RUN_DURATION_MS });
		}, MAX_RUN_DURATION_MS);
		run.status = "running";
		await persistRun(run, { type: "run_start" });
		updateUi(run);
		try {
			const globals = createWorkflowGlobals(run, controller, parentModel, knownAgents, parseWorkflowArgs(args));
			const result = await compiled.run(globals);
			closeOpenPhase(run);
			run.status = "succeeded";
			run.report = formatWorkflowResult(result);
			run.endedAt = Date.now();
			await persistRun(run, { type: "run_end", status: run.status, reportBytes: Buffer.byteLength(run.report, "utf8") });
			const usage = aggregateUsage(run);
			const budgetNote = run.budgetTotal != null ? ` (budget ${workflowSpent(run)}/${run.budgetTotal} output tokens)` : "";
			safeSendWorkflowMessage(pi, `# Workflow complete: ${run.name}\n\n${run.report}\n\n---\nRun: ${run.id}\nAgents: ${run.agents.length}\nUsage: ${usage.turns} turns, ${usage.output} output tokens${budgetNote}, $${usage.cost.toFixed(4)}\nDetails: ${run.runDir}`);
		} catch (error: any) {
			run.status = controller.signal.aborted ? "cancelled" : "failed";
			closeOpenPhase(run, run.status);
			run.error = error?.message ?? String(error);
			run.endedAt = Date.now();
			await persistRun(run, { type: "run_end", status: run.status, error: run.error });
			safeSendWorkflowMessage(pi, `# Workflow ${run.status}: ${run.name}\n\n${run.error}\n\nRun: ${run.id}\nDetails: ${run.runDir}`);
		} finally {
			clearTimeout(runTimeout);
			abortControllers.delete(id);
			updateUi(run);
			await clearUiIfNoActive();
		}
	})();
	return run;
}

function approvalKey(wf: WorkflowFile, cwd: string): string {
	return `${cwd}|${wf.path}|${wf.hash}`;
}

async function ensureApproved(wf: WorkflowFile, ctx: any): Promise<boolean> {
	if (wf.scope !== "project") return true;
	const approvals = readJsonFile<Record<string, boolean>>(USER_APPROVAL_FILE, {});
	const key = approvalKey(wf, ctx.cwd);
	if (approvals[key]) return true;
	if (!ctx.hasUI) return false;
	const ok = await ctx.ui.confirm("Run project workflow?", `Workflow: ${wf.name}\nPath: ${wf.path}\nHash: ${wf.hash.slice(0, 12)}\n\nProject workflows are repo-controlled code and run with your permissions. Only continue for trusted repositories.`);
	if (!ok) return false;
	approvals[key] = true;
	await writeJsonFile(USER_APPROVAL_FILE, approvals);
	return true;
}

async function runNamedWorkflow(pi: ExtensionAPI, name: string, args: string, ctx: any): Promise<void> {
	lastCtx = ctx;
	const wf = discoverWorkflows(ctx.cwd).find((w) => w.name === safeName(name));
	if (!wf) {
		ctx.ui.notify(`Workflow not found: ${name}`, "error");
		return;
	}
	if (!(await ensureApproved(wf, ctx))) {
		ctx.ui.notify("Workflow cancelled: not approved.", "warning");
		return;
	}
	const run = await startRun(pi, wf, args, ctx);
	ctx.ui.notify(`Started workflow ${run.name} (${run.id}). Details: ${run.runDir}`, "info");
}

function listPersistedRuns(cwd: string): RunState[] {
	const base = runBaseDir(cwd);
	if (!fs.existsSync(base)) return [];
	const runs: RunState[] = [];
	for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const state = readJsonFile<RunState | null>(path.join(base, entry.name, "state.json"), null);
		if (state) runs.push(state);
	}
	return runs.sort((a, b) => b.startedAt - a.startedAt);
}

function summarizeRuns(cwd: string): string {
	const discovered = discoverWorkflows(cwd);
	const runs = listPersistedRuns(cwd).slice(0, 20);
	const workflowLines = discovered.length ? discovered.map((w) => `- ${w.name} (${w.scope}) — ${w.path}`).join("\n") : "(none)";
	const runLines = runs.length ? runs.map((r) => {
		const done = r.agents.filter((a) => a.status !== "running").length;
		const usage = aggregateUsage(r);
		return `- ${r.name} ${r.status} ${done}/${r.agents.length} agents ${formatDuration((r.endedAt ?? Date.now()) - r.startedAt)} $${usage.cost.toFixed(4)} — ${r.id}`;
	}).join("\n") : "(none)";
	return `Workflows:\n${workflowLines}\n\nRecent runs:\n${runLines}`;
}

function findAgentDiffPath(run: RunState, agentLabel: string): string | undefined {
	const cacheEntry = run.agentCache ? Object.values(run.agentCache).find((r) => r.label === agentLabel) : undefined;
	return cacheEntry?.worktree?.diffPath ?? path.join(run.runDir, "worktree-diffs", `${safeName(agentLabel)}.diff`);
}

async function applyWorkflowPatch(run: RunState, agentLabel: string, cwd: string, dryRun: boolean): Promise<string> {
	const diffPath = findAgentDiffPath(run, agentLabel);
	if (!diffPath || !fs.existsSync(diffPath)) throw new Error(`No diff found for agent ${agentLabel} in run ${run.id}.`);
	if (!(await isGitRepo(cwd))) throw new Error(`Patch target is not inside a git repository: ${cwd}`);
	await execFile("git", ["apply", "--check", diffPath], { cwd });
	if (dryRun) return `Patch applies cleanly: ${diffPath}`;
	await execFile("git", ["apply", diffPath], { cwd });
	return `Applied workflow patch for ${run.id}/${agentLabel} to ${cwd}\nDiff: ${diffPath}`;
}

function workflowRunDetails(run: RunState, agentLabel?: string): string {
	const usage = aggregateUsage(run);
	if (agentLabel) {
		const agent = run.agents.find((a) => a.label === agentLabel);
		const cacheEntry = run.agentCache ? Object.values(run.agentCache).find((r) => r.label === agentLabel) : undefined;
		if (!agent) return `Agent not found in run ${run.id}: ${agentLabel}`;
		const diffPath = findAgentDiffPath(run, agent.label);
		return [
			`Workflow: ${run.name}`,
			`Run: ${run.id}`,
			`Agent: ${agent.label} (${agent.agent})`,
			`Status: ${agent.status}${agent.cached ? " (cached)" : ""}`,
			`Duration: ${formatDuration((agent.endedAt ?? Date.now()) - agent.startedAt)}`,
			`Usage: ${agent.usage?.turns ?? 0} turns, $${(agent.usage?.cost ?? 0).toFixed(4)}`,
			`Raw events: ${path.join(run.runDir, "agents", `${safeName(agent.label)}.jsonl`)}`,
			...(diffPath && fs.existsSync(diffPath) ? [`Diff: ${diffPath}`] : []),
			"",
			"Task:",
			agent.task ?? "(task was not recorded by this runtime version)",
			"",
			"Output:",
			cacheEntry?.text ?? agent.error ?? "(output available in raw events)",
		].join("\n");
	}
	const phaseLines = run.phases.length ? run.phases.map((p) => `- ${p.name}: ${p.status} (${formatDuration((p.endedAt ?? Date.now()) - p.startedAt)})`).join("\n") : "(none)";
	const agentLines = run.agents.length ? run.agents.map((a) => `- ${a.label} (${a.agent})${a.phase ? ` [${a.phase}]` : ""}: ${a.status}${a.cached ? " cached" : ""} ${a.usage ? `$${a.usage.cost.toFixed(4)}` : ""}`).join("\n") : "(none)";
	return [
		`Workflow: ${run.name}`,
		`Run: ${run.id}`,
		`Status: ${run.status}`,
		`Args: ${run.args || "(none)"}`,
		`Duration: ${formatDuration((run.endedAt ?? Date.now()) - run.startedAt)}`,
		`Usage: ${usage.turns} turns, $${usage.cost.toFixed(4)}`,
		`Details: ${run.runDir}`,
		"",
		"Phases:",
		phaseLines,
		"",
		"Agents:",
		agentLines,
		"",
		"Report:",
		run.report ?? run.error ?? "(none)",
	].join("\n");
}

// The authoring contract for a workflow script. Shared by BOTH the inline-authoring path
// (folded into the workflow_run tool description, so the orchestrating agent sees it whenever
// it writes a mode:'script' workflow) AND the generate-mode system prompt — so a hand-written
// script and a generated one obey exactly the same rules and patterns.
const WORKFLOW_AUTHORING_GUIDE = `A workflow script is plain JavaScript (NOT TypeScript — no type annotations, interfaces, or generics; they fail to parse). It ONLY orchestrates: every repository, shell, file, and web action happens inside agent() subagents, never in the script body.

Required shape:
- Begin with: export const meta = { name, description, phases } — a PURE object literal (no variables, function calls, spreads, or template interpolation). name is stable kebab-case; description is one line; phases is an array of { title } in run order.
- After meta, write the orchestration body directly using the injected globals. Top-level await and a top-level return are allowed; the value you return becomes the report (return a markdown string, or an object that is rendered as JSON).

Injected globals (do NOT import anything — these are already in scope):
- agent(prompt, opts?) -> Promise<string | object | null>. Spawns ONE bounded-concurrency subagent. opts: { label, phase, schema, model, effort, agentType, isolation }. With a JSON-Schema 'schema' it returns the parsed JSON value; otherwise the agent's final text. Returns null if the agent fails (filter results with .filter(Boolean)).
- parallel(thunks) -> Promise<any[]>. Runs an array of () => Promise thunks concurrently and awaits them ALL (a barrier). A failed thunk becomes null. Use ONLY when you genuinely need every result together.
- pipeline(items, stage1, stage2, ...) -> Promise<any[]>. Runs each item through all stages independently with NO barrier between stages; each stage receives (prevResult, originalItem, index). Wall-clock is the slowest single item, not the sum of stages. THIS IS THE DEFAULT for multi-stage work.
- phase(title) -> mark the start of a named phase (use titles from meta.phases).
- log(message) -> emit a progress line.
- args -> the parsed workflow arguments (a JSON value, or undefined).
- budget -> { total, spent(), remaining() }. total is the caller's output-token target (null when none was set). spent() = output tokens spent so far across this run's subagents AND the main loop. remaining() = max(0, total - spent()) or Infinity. Once exhausted, further agent() calls THROW — so gate loops on it: while (budget.total && budget.remaining() > 50000) { ... }.
- workflow(nameOrRef, args?) -> run a saved workflow by name (or { scriptPath }) inline as a sub-step and return its result. Nesting is one level only.

agentType selects the subagent (these are real Pi subagents): default "delegate" (general-purpose, inherits project context and the parent model). Specialists: "scout" (fast read-only recon), "researcher" (web/docs research), "planner" (read-and-plan, no edits), "reviewer" (critique/verification), "worker" (implementation/edits), "oracle" (second opinion / challenge assumptions), "context-builder". Claude-style aliases also map (general-purpose/general->delegate, explore/search->scout, code-reviewer/review->reviewer, plan->planner, research->researcher). Prefer delegate unless a specialist clearly fits. effort maps to thinking depth (low|medium|high|xhigh|max). isolation:"worktree" gives a file-mutating agent its own git worktree.

Orchestration patterns — pick what the task needs:
- Pipeline by default: pipeline(items, (prev, item) => agent("find ... " + item), (found) => agent("Verify this finding: " + found, { agentType: "reviewer" })). Each item flows through its stages independently; verification of item A overlaps discovery of item B.
- Barrier only when a stage needs the whole set: collect with await parallel([...]) before the next stage ONLY to dedup/merge across items, early-exit on a zero count, or compare items. Otherwise keep stages inside pipeline.
- Adversarial verify: for audits, research, plans, or risky outputs, add a verification phase that spawns independent skeptics (or distinct lenses such as correctness, security, reproduction) prompted to REFUTE each finding; keep only findings that survive a majority, defaulting to rejection when uncertain.
- Judge panel: for design or decision tasks, generate N independent attempts from different angles, score with parallel judges, synthesize from the winner.
- Loop until dry: for unknown-size discovery, keep spawning finders until K consecutive rounds surface nothing new (dedup against everything seen). Never silently cap at top-N; if you must cap, log() what was dropped.
- Loop until budget: while (budget.total && budget.remaining() > 50000) { ... } to scale depth to the caller's token target.

Scale to the goal: a quick check needs a few agents and one verification pass; "thorough", "comprehensive", or "audit" needs a larger finder pool, a 3-5 way adversarial pass, and a final synthesis stage.

Hard constraints (the script is validated and REJECTED if violated):
- import nothing; only 'export const meta' may be exported.
- do not use require, process, fetch, eval, Function, dynamic import(), Date.now(), Math.random(), or argless new Date() (they break deterministic replay). Vary agent prompts and labels by index instead of relying on randomness; pass timestamps via args.
- a single parallel()/pipeline() call accepts at most 4096 items; concurrency is capped automatically.`;

// Always-present description for the workflow_run tool. Folds in the authoring contract so the
// orchestrating agent is fully scaffolded when it writes a script inline (mode:'script') —
// instead of only seeing the contract in generate mode.
const WORKFLOW_RUN_DESCRIPTION = `Run a multi-subagent workflow in the background. A workflow decomposes a task across many bounded-concurrency Pi subagents for one of three reasons: BREADTH (cover a surface too large to read serially), CONFIDENCE (independent perspectives or adversarial verification before a risky output), or SCALE (more work than one agent's context can hold) — e.g. broad codebase audits, large migrations, cross-checked research, exhaustive multi-dimension reviews.

Modes:
- 'script' (preferred for one-offs): you author the orchestration inline as a JavaScript workflow script (see the authoring contract below). You control the structure.
- 'saved': run a known workflow by name.
- 'generate': a script is written from a natural-language goal and a human approves it.

Background + wake semantics: this tool returns IMMEDIATELY with a run id. The workflow runs in the background; when it finishes its report is delivered back into this session and WAKES you (an idle agent gets a fresh turn; an in-flight turn gets the report appended to its tail) so you can read the results and launch the next phase — exactly like resuming on a task-completion notification. Do NOT block waiting on it, and do NOT re-run the same workflow to "check" on it; inspect progress with /workflows or /workflow-show. For multi-phase work (understand -> design -> implement -> review), run several workflows in sequence, acting on each report as it arrives.

Decision gate: a workflow spends real tokens across many agents. Reach for it when breadth, confidence, or scale genuinely change the outcome; for anything a single agent can finish inline in this session, do it directly — UNLESS workflow mode is on, in which case orchestrate substantive tasks by default (the standing workflow-mode directive overrides this gate). Either way: scout the work-list inline first (list the files, the diff, the items), THEN fan out.

--- Workflow script authoring contract (modes 'script' and 'generate') ---
${WORKFLOW_AUTHORING_GUIDE}`;

const FLOW_GENERATOR_SYSTEM_PROMPT = `You generate workflow scripts for a deterministic multi-agent orchestrator that fans work out across many bounded-concurrency subagents. Return exactly ONE JavaScript module, no prose, no code fence.

${WORKFLOW_AUTHORING_GUIDE}`;

function extractGeneratedScript(text: string): string {
	const fence = text.match(/```(?:ts|typescript|js|javascript)?\s*([\s\S]*?)```/i);
	return (fence ? fence[1] : text).trim();
}

async function generateWorkflowScript(goal: string, ctx: any): Promise<string> {
	if (!ctx.model) throw new Error("No active model is selected.");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: `Create a Pi workflow script for this goal:\n\n${goal}` }],
		timestamp: Date.now(),
	};
	const response = await complete(ctx.model, { systemPrompt: FLOW_GENERATOR_SYSTEM_PROMPT, messages: [userMessage] }, { apiKey: auth.apiKey, headers: auth.headers });
	const text = response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
	return extractGeneratedScript(text);
}

class WorkflowsBrowser {
	private selected = 0;
	private detail = false;
	private items: RunState[];
	constructor(private runs: RunState[], private workflows: WorkflowFile[], private done: () => void) {
		this.items = runs;
	}
	invalidate(): void { /* no cached rendering */ }
	private selectedRun(): RunState | undefined { return this.items[this.selected]; }
	render(width: number): string[] {
		const line = (text: string) => text.length > width ? text.slice(0, Math.max(0, width - 1)) : text;
		const lines: string[] = [];
		lines.push(line("Pi Workflows  ↑/↓ select • enter details • esc/q close"));
		lines.push(line(`Saved workflows: ${this.workflows.map((w) => `${w.name}(${w.scope})`).join(", ") || "none"}`));
		lines.push("".padEnd(Math.min(width, 1), " "));
		if (this.items.length === 0) {
			lines.push("No persisted workflow runs.");
			return lines;
		}
		if (!this.detail) {
			lines.push(line("Recent runs:"));
			this.items.slice(0, 20).forEach((run, index) => {
				const usage = aggregateUsage(run);
				const marker = index === this.selected ? "›" : " ";
				const done = run.agents.filter((a) => a.status !== "running").length;
				lines.push(line(`${marker} ${run.name.padEnd(18)} ${run.status.padEnd(11)} ${done}/${run.agents.length} agents ${formatDuration((run.endedAt ?? Date.now()) - run.startedAt).padStart(6)} $${usage.cost.toFixed(4)} ${run.id}`));
			});
			return lines;
		}
		const run = this.selectedRun();
		if (!run) return ["No run selected."];
		const usage = aggregateUsage(run);
		lines.push(line(`Workflow: ${run.name}`));
		lines.push(line(`Run: ${run.id}`));
		lines.push(line(`Status: ${run.status}  Args: ${run.args || "(none)"}`));
		lines.push(line(`Usage: ${usage.turns} turns, $${usage.cost.toFixed(4)}  Details: ${run.runDir}`));
		lines.push("");
		lines.push("Phases:");
		for (const phase of run.phases) lines.push(line(`  ${phase.status === "succeeded" ? "✓" : phase.status === "running" ? "⏳" : phase.status === "failed" ? "✗" : "○"} ${phase.name} ${phase.status}`));
		lines.push("");
		lines.push("Agents:");
		for (const agent of run.agents) {
			const diffPath = findAgentDiffPath(run, agent.label);
			lines.push(line(`  ${agent.status === "succeeded" ? "✓" : agent.status === "running" ? "⏳" : "✗"} ${agent.label} (${agent.agent})${agent.cached ? " cached" : ""}${diffPath && fs.existsSync(diffPath) ? " diff" : ""}`));
		}
		lines.push("");
		lines.push("Report preview:");
		for (const reportLine of (run.report ?? run.error ?? "(none)").split("\n").slice(0, 8)) lines.push(line(`  ${reportLine}`));
		return lines;
	}
	handleInput(data: string): void {
		if (data === "q" || data === "\u001b") { this.done(); return; }
		if (data === "\r" || data === "\n") { this.detail = !this.detail; return; }
		if (data === "\u001b[A") this.selected = Math.max(0, this.selected - 1);
		if (data === "\u001b[B") this.selected = Math.min(Math.max(0, this.items.length - 1), this.selected + 1);
	}
}

const WorkflowRunParams = Type.Object({
	mode: StringEnum(["saved", "generate", "script"] as const, { description: "Run a saved workflow, generate one from a goal, or run a provided script." }),
	name: Type.Optional(Type.String({ description: "Workflow name for saved mode" })),
	goal: Type.Optional(Type.String({ description: "Natural-language goal for generate mode" })),
	script: Type.Optional(Type.String({ description: "Workflow JavaScript source for script mode (plain JS, not TypeScript; see the tool description's authoring contract)" })),
	args: Type.Optional(Type.String({ description: "Raw workflow arguments" })),
	save: Type.Optional(Type.Boolean({ description: "Save generated/script workflow to the user workflow directory before running", default: false })),
	budget: Type.Optional(Type.Number({ description: "Optional output-token target for the whole run. When set, budget.remaining() drives the script's loops and agent() throws once exhausted. Falls back to the PI_WORKFLOW_BUDGET env var." })),
	requireApproval: Type.Optional(Type.Boolean({ default: true })),
});

export default function (pi: ExtensionAPI) {
	lastPi = pi;

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		mainLoopOutputTokens = 0;
		// Registered tools auto-activate on a normal startup, but a --tools allowlist (or another
		// extension narrowing the active set) can drop workflow_run, which silently hides its
		// description + guidelines. Defensively re-add it without clobbering other active tools.
		try {
			const active = pi.getActiveTools();
			if (!active.includes("workflow_run")) pi.setActiveTools([...new Set([...active, "workflow_run"])]);
		} catch {
			// Best-effort: if the host narrowed tools deliberately or the API is unavailable, skip.
		}
		const interrupted = listPersistedRuns(ctx.cwd).filter((r) => r.status === "running" || r.status === "pending");
		for (const run of interrupted) {
			run.status = "interrupted";
			run.endedAt = Date.now();
			await persistRun(run, { type: "run_interrupted", reason: "session_start" });
		}
	});

	// Accumulate the MAIN agent loop's output tokens so a workflow's budget.spent() reflects a
	// shared pool (main loop + its subagents), matching Claude Code's turn-level budget.
	pi.on("message_end", async (event) => {
		try {
			const msg = (event as { message?: { role?: string; usage?: { output?: number } } }).message;
			if (msg?.role === "assistant" && typeof msg.usage?.output === "number") {
				mainLoopOutputTokens += msg.usage.output;
			}
		} catch {
			// Budget accounting is best-effort; never disrupt the turn.
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (typeof event.systemPrompt !== "string") return;
			const addendum = buildWorkflowSystemPromptAddendum(ctx.cwd);
			if (!addendum) return;
			return { systemPrompt: `${event.systemPrompt}\n\n${addendum}` };
		} catch {
			// Best-effort context injection; never block the agent from starting.
			return;
		}
	});

	pi.registerCommand("workflow-mode", {
		description: "Standing workflow mode — nudge the agent to orchestrate substantial tasks: /workflow-mode [on|off|auto|status]",
		handler: async (input, ctx) => {
			const arg = (input || "").trim().toLowerCase();
			const describe = () => {
				const mode = readWorkflowMode();
				const source = mode.source === "command" ? "set explicitly" : mode.source === "env" ? "from PI_WORKFLOW_MODE" : "default";
				return `Workflow mode: ${mode.enabled ? "on" : "off"} (${source}).`;
			};
			if (arg === "status") {
				ctx.ui.notify(describe(), "info");
				return;
			}
			if (arg === "auto") {
				await clearWorkflowMode();
				ctx.ui.notify(`Cleared explicit workflow mode. ${describe()}`, "info");
				return;
			}
			if (arg === "on" || arg === "off") {
				await writeWorkflowMode(arg === "on");
				ctx.ui.notify(describe(), "info");
				return;
			}
			if (arg === "" || arg === "toggle") {
				await writeWorkflowMode(!readWorkflowMode().enabled);
				ctx.ui.notify(describe(), "info");
				return;
			}
			ctx.ui.notify("Usage: /workflow-mode [on|off|auto|status]", "warning");
		},
	});

	pi.registerCommand("workflow", {
		description: "Run a saved workflow: /workflow <name> [args...]",
		handler: async (input, ctx) => {
			const [name, ...rest] = (input || "").trim().split(/\s+/);
			if (!name) {
				ctx.ui.notify(summarizeRuns(ctx.cwd), "info");
				return;
			}
			await runNamedWorkflow(pi, name, rest.join(" "), ctx);
		},
		getArgumentCompletions: (prefix: string) => discoverWorkflows(lastCtx?.cwd ?? process.cwd()).filter((w) => w.name.startsWith(prefix)).map((w) => ({ value: w.name, label: `${w.name} (${w.scope})` })),
	});

	pi.registerCommand("workflows", {
		description: "List saved workflows and recent workflow runs",
		handler: async (args, ctx) => {
			const summary = summarizeRuns(ctx.cwd);
			const workflows = discoverWorkflows(ctx.cwd);
			const runs = listPersistedRuns(ctx.cwd).slice(0, 20);
			if (ctx.hasUI && (args || "").trim() === "tui") {
				await ctx.ui.custom((_tui: unknown, _theme: unknown, _keybindings: unknown, done: () => void) => new WorkflowsBrowser(runs, workflows, done), { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%" } });
				return;
			}
			if (!ctx.hasUI || (args || "").trim() === "list") {
				ctx.ui.notify(summary, "info");
				return;
			}
			const choices = [
				...workflows.map((w) => `Run workflow: ${w.name} (${w.scope})`),
				...runs.map((r) => `Inspect run: ${r.name} ${r.status} ${r.id}`),
				"Show text summary",
				"Cancel",
			];
			const choice = await ctx.ui.select("Workflows", choices);
			if (!choice || choice === "Cancel") return;
			if (choice === "Show text summary") { ctx.ui.notify(summary, "info"); return; }
			if (choice.startsWith("Run workflow: ")) {
				const name = choice.slice("Run workflow: ".length).split(" ")[0];
				await runNamedWorkflow(pi, name, "", ctx);
				return;
			}
			if (choice.startsWith("Inspect run: ")) {
				const id = choice.trim().split(/\s+/).pop() ?? "";
				const run = runs.find((r) => r.id === id);
				if (!run) return;
				const agentsWithDiffs = run.agents.filter((a) => {
					const diffPath = findAgentDiffPath(run, a.label);
					return Boolean(diffPath && fs.existsSync(diffPath));
				});
				const detailChoices = [
					"Show run details",
					...run.agents.map((a) => `Show agent: ${a.label}`),
					...agentsWithDiffs.map((a) => `Check patch: ${a.label}`),
					...agentsWithDiffs.map((a) => `Apply patch: ${a.label}`),
					...(run.status === "running" || run.status === "pending" ? ["Stop run"] : []),
					"Rerun fresh",
					"Rerun with cache reuse",
					"Save script to user workflows",
					"Back",
				];
				const detail = await ctx.ui.select(`Run ${run.id}`, detailChoices);
				if (!detail || detail === "Back") return;
				if (detail === "Show run details") ctx.ui.notify(workflowRunDetails(run), "info");
				else if (detail.startsWith("Show agent: ")) ctx.ui.notify(workflowRunDetails(run, detail.slice("Show agent: ".length)), "info");
				else if (detail.startsWith("Check patch: ")) ctx.ui.notify(await applyWorkflowPatch(run, detail.slice("Check patch: ".length), ctx.cwd, true), "info");
				else if (detail.startsWith("Apply patch: ")) ctx.ui.notify(await applyWorkflowPatch(run, detail.slice("Apply patch: ".length), ctx.cwd, false), "info");
				else if (detail === "Stop run") abortControllers.get(run.id)?.abort();
				else if (detail === "Rerun fresh") await startRun(pi, { name: run.name, path: path.join(run.runDir, "script.ts"), scope: "user", hash: run.hash }, run.args, ctx, { budget: run.budgetTotal ?? undefined });
				else if (detail === "Rerun with cache reuse") await startRun(pi, { name: run.name, path: path.join(run.runDir, "script.ts"), scope: "user", hash: run.hash }, run.args, ctx, { reuseFrom: run, budget: run.budgetTotal ?? undefined });
				else if (detail === "Save script to user workflows") {
					await fs.promises.mkdir(USER_WORKFLOW_DIR, { recursive: true });
					const target = path.join(USER_WORKFLOW_DIR, `${safeName(run.name)}.ts`);
					await fs.promises.copyFile(path.join(run.runDir, "script.ts"), target);
					ctx.ui.notify(`Saved ${target}. Run /reload to refresh dynamic commands.`, "info");
				}
			}
		},
	});

	pi.registerCommand("workflow-show", {
		description: "Inspect a persisted workflow run: /workflow-show <run-id> [agent-label]",
		handler: async (input, ctx) => {
			const [id, agentLabel] = (input || "").trim().split(/\s+/);
			if (!id) { ctx.ui.notify("Usage: /workflow-show <run-id> [agent-label]", "warning"); return; }
			const run = listPersistedRuns(ctx.cwd).find((r) => r.id === id || r.id.startsWith(id));
			if (!run) { ctx.ui.notify(`Run not found: ${id}`, "error"); return; }
			ctx.ui.notify(workflowRunDetails(run, agentLabel), "info");
		},
	});

	pi.registerCommand("flow", {
		description: "Generate a one-off workflow from a natural-language goal",
		handler: async (goal, ctx) => {
			const trimmedGoal = (goal || "").trim();
			if (!trimmedGoal) { ctx.ui.notify("Usage: /flow <goal>", "warning"); return; }
			if (!ctx.hasUI) { ctx.ui.notify("/flow requires interactive UI approval.", "warning"); return; }
			try {
				ctx.ui.notify("Generating workflow script...", "info");
				const script = await generateWorkflowScript(trimmedGoal, ctx);
				const errors = validateScript(script);
				if (errors.length > 0) {
					ctx.ui.notify(`Generated workflow failed validation:\n${errors.join("\n")}`, "error");
					return;
				}
				let finalScript = script;
				let def = loadWorkflowFromSource(finalScript, "<generated>");
				let name = safeName(def.meta.name);
				let choice = await ctx.ui.select("Generated workflow", [
					`Run once: ${name}`,
					`Save to user workflows and run: ${name}`,
					`Save to project workflows and run: ${name}`,
					"View raw script",
					"Edit script",
					"Cancel",
				]);
				if (!choice || choice === "Cancel") return;
				if (choice === "View raw script") {
					ctx.ui.notify(finalScript, "info");
					return;
				}
				if (choice === "Edit script") {
					const edited = await ctx.ui.editor("Edit generated workflow script", finalScript);
					if (!edited?.trim()) return;
					const editedErrors = validateScript(edited);
					if (editedErrors.length > 0) {
						ctx.ui.notify(`Edited workflow failed validation:\n${editedErrors.join("\n")}`, "error");
						return;
					}
					finalScript = edited;
					def = loadWorkflowFromSource(finalScript, "<edited generated>");
					name = safeName(def.meta.name);
					choice = await ctx.ui.select("Run edited workflow", [
						`Run once: ${name}`,
						`Save to user workflows and run: ${name}`,
						`Save to project workflows and run: ${name}`,
						"Cancel",
					]);
					if (!choice || choice === "Cancel") return;
				}
				let filePath: string;
				let scope: WorkflowScope;
				if (choice.startsWith("Save to project")) {
					const dir = projectWorkflowDir(ctx.cwd) ?? path.join(ctx.cwd, ".pi", "workflows");
					await fs.promises.mkdir(dir, { recursive: true });
					filePath = path.join(dir, `${name}.ts`);
					scope = "project";
					await fs.promises.writeFile(filePath, finalScript, "utf8");
				} else if (choice.startsWith("Save to user")) {
					await fs.promises.mkdir(USER_WORKFLOW_DIR, { recursive: true });
					filePath = path.join(USER_WORKFLOW_DIR, `${name}.ts`);
					scope = "user";
					await fs.promises.writeFile(filePath, finalScript, "utf8");
				} else {
					const dir = path.join(os.tmpdir(), "pi-generated-workflows");
					await fs.promises.mkdir(dir, { recursive: true });
					filePath = path.join(dir, `${name}-${Date.now()}.ts`);
					scope = "user";
					await fs.promises.writeFile(filePath, finalScript, "utf8");
				}
				const wf: WorkflowFile = { name, path: filePath, scope, hash: sha256(finalScript), description: def.meta.description };
				if (!(await ensureApproved(wf, ctx))) return;
				const run = await startRun(pi, wf, "", ctx);
				ctx.ui.notify(`Started generated workflow ${run.name} (${run.id}).`, "info");
			} catch (error: any) {
				ctx.ui.notify(`Flow generation failed: ${error?.message ?? String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("workflow-stop", {
		description: "Stop a running workflow by run id",
		handler: async (runId, ctx) => {
			const id = (runId || "").trim();
			const controller = abortControllers.get(id);
			if (!controller) { ctx.ui.notify(`No active workflow run: ${id}`, "warning"); return; }
			controller.abort();
			ctx.ui.notify(`Stopping workflow ${id}`, "info");
		},
	});

	pi.registerCommand("workflow-save", {
		description: "Save a previous run's script: /workflow-save <run-id> [user|project]",
		handler: async (input, ctx) => {
			const [id, dest = "user"] = (input || "").trim().split(/\s+/);
			if (!id) { ctx.ui.notify("Usage: /workflow-save <run-id> [user|project]", "warning"); return; }
			const run = listPersistedRuns(ctx.cwd).find((r) => r.id === id || r.id.startsWith(id));
			if (!run) { ctx.ui.notify(`Run not found: ${id}`, "error"); return; }
			const source = path.join(run.runDir, "script.ts");
			if (!fs.existsSync(source)) { ctx.ui.notify(`Run has no script snapshot: ${run.id}`, "error"); return; }
			const dir = dest === "project" ? (projectWorkflowDir(ctx.cwd) ?? path.join(ctx.cwd, ".pi", "workflows")) : USER_WORKFLOW_DIR;
			await fs.promises.mkdir(dir, { recursive: true });
			const target = path.join(dir, `${safeName(run.name)}.ts`);
			await fs.promises.copyFile(source, target);
			ctx.ui.notify(`Saved workflow to ${target}. Run /reload to refresh dynamic slash commands.`, "info");
		},
	});

	pi.registerCommand("workflow-rerun", {
		description: "Rerun the exact script and args from a previous run: /workflow-rerun <run-id> [fresh|reuse]",
		handler: async (input, ctx) => {
			const [runId, mode = "fresh"] = (input || "").trim().split(/\s+/);
			if (!runId) { ctx.ui.notify("Usage: /workflow-rerun <run-id> [fresh|reuse]", "warning"); return; }
			const prior = listPersistedRuns(ctx.cwd).find((r) => r.id === runId || r.id.startsWith(runId));
			if (!prior) { ctx.ui.notify(`Run not found: ${runId}`, "error"); return; }
			const scriptPath = path.join(prior.runDir, "script.ts");
			if (!fs.existsSync(scriptPath)) { ctx.ui.notify(`Run has no script snapshot: ${prior.id}`, "error"); return; }
			const source = await fs.promises.readFile(scriptPath, "utf8");
			const wf: WorkflowFile = { name: prior.name, path: scriptPath, scope: "user", hash: sha256(source) };
			const reuseFrom = mode === "reuse" ? prior : undefined;
			const next = await startRun(pi, wf, prior.args, ctx, { reuseFrom, budget: prior.budgetTotal ?? undefined });
			ctx.ui.notify(`Rerunning workflow ${next.name} (${next.id})${reuseFrom ? " with cache reuse" : ""}.`, "info");
		},
	});

	pi.registerCommand("workflow-apply", {
		description: "Apply a worktree-isolated agent diff: /workflow-apply <run-id> <agent-label> [cwd] [--check]",
		handler: async (input, ctx) => {
			const parts = (input || "").trim().split(/\s+/).filter(Boolean);
			const dryRun = parts.includes("--check");
			const filtered = parts.filter((part) => part !== "--check");
			const [runId, agentLabel, targetCwd = ctx.cwd] = filtered;
			if (!runId || !agentLabel) { ctx.ui.notify("Usage: /workflow-apply <run-id> <agent-label> [cwd] [--check]", "warning"); return; }
			const run = listPersistedRuns(ctx.cwd).find((r) => r.id === runId || r.id.startsWith(runId));
			if (!run) { ctx.ui.notify(`Run not found: ${runId}`, "error"); return; }
			try {
				const message = await applyWorkflowPatch(run, agentLabel, targetCwd, dryRun);
				ctx.ui.notify(message, "info");
			} catch (error: any) {
				ctx.ui.notify(`Workflow patch ${dryRun ? "check" : "apply"} failed: ${error?.message ?? String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("workflow-test", {
		description: "Create and run a small built-in example workflow in the current project",
		handler: async (_args, ctx) => {
			const dir = projectWorkflowDir(ctx.cwd) ?? USER_WORKFLOW_DIR;
			await fs.promises.mkdir(dir, { recursive: true });
			const filePath = path.join(dir, "workflow-test.ts");
			if (!fs.existsSync(filePath)) {
				await fs.promises.writeFile(
					filePath,
					`export const meta = {
  name: "workflow-test",
  description: "Run two tiny subagents concurrently",
  phases: [{ title: "smoke test" }],
};

phase("smoke test");
const results = await parallel([
  () => agent("Report the current working directory. Do not modify any files.", { label: "pwd", agentType: "scout" }),
  () => agent("List up to five top-level files or directories. Do not modify any files.", { label: "list", agentType: "scout" }),
]);
return "## Smoke test results\\n\\n" + results.map((r, i) => "### agent " + (i + 1) + "\\n" + (r || "(no output)")).join("\\n\\n");
`,
					"utf8",
				);
			}
			await runNamedWorkflow(pi, "workflow-test", "", ctx);
		},
	});

	for (const wf of discoverWorkflows(process.cwd())) {
		pi.registerCommand(wf.name, {
			description: `Run workflow ${wf.name}`,
			handler: async (args, ctx) => runNamedWorkflow(pi, wf.name, args || "", ctx),
		});
	}

	pi.registerTool({
		name: "workflow_run",
		label: "Workflow Run",
		description: WORKFLOW_RUN_DESCRIPTION,
		parameters: WorkflowRunParams,
		promptSnippet:
			"Run a background multi-agent workflow (script/saved/generate) for breadth, independent verification, or scale — audits, migrations, cross-checked research, exhaustive reviews. Returns a run id and wakes you with the report when it finishes.",
		promptGuidelines: [
			"workflow_run fans a task out across many bounded-concurrency subagents and reports back asynchronously; it WAKES you when done (idle -> new turn; streaming -> appended to the turn's tail), so you can read the results and chain the next phase. Do not block on it or re-run it to check progress (use /workflows).",
			"Decision gate: reach for it when a task needs breadth (too large to cover serially), confidence (independent or adversarial verification), or scale (more than one context can hold). For work a single agent can finish inline, do it directly — UNLESS workflow mode is on, in which case orchestrate substantive tasks by default. Scout the work-list inline first, then fan out.",
			"Prefer mode:'script' for one-offs — author the orchestration directly (the full authoring contract is in this tool's description). Use pipeline() by default; use a barrier (parallel) only when a stage needs the whole set (dedup/merge, zero-count early exit, cross-item compare).",
			"Verify adversarially for audits/research/plans/risky outputs: spawn independent skeptics or distinct lenses (correctness, security, reproduction) prompted to refute each finding, keep only those that survive a majority. Converge (loop until dry / until budget) rather than silently capping at top-N.",
			"Scale to the ask: a quick check = a few finders + one verification pass; 'thorough'/'comprehensive'/'audit' = a larger finder pool, a 3-5 way adversarial pass, then a synthesis stage. Pass a token budget for large runs; gate loops on budget.remaining().",
		],
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let wf: WorkflowFile | undefined;
			let generatedScript: string | undefined;

			if (params.mode === "saved") {
				if (!params.name) return { content: [{ type: "text", text: "Saved workflow mode requires name." }], isError: true };
				wf = discoverWorkflows(ctx.cwd).find((w) => w.name === safeName(params.name));
				if (!wf) return { content: [{ type: "text", text: `Workflow not found: ${params.name}` }], isError: true };
			} else if (params.mode === "generate") {
				if (!params.goal) return { content: [{ type: "text", text: "Generate workflow mode requires goal." }], isError: true };
				if ((params.requireApproval ?? true) && !ctx.hasUI) return { content: [{ type: "text", text: "Generate mode requires interactive approval unless requireApproval=false." }], isError: true };
				generatedScript = await generateWorkflowScript(params.goal, ctx);
				const def = loadWorkflowFromSource(generatedScript, "<generated tool workflow>");
				const name = safeName(def.meta.name);
				const dir = params.save ? USER_WORKFLOW_DIR : path.join(os.tmpdir(), "pi-generated-workflows");
				await fs.promises.mkdir(dir, { recursive: true });
				const filePath = path.join(dir, params.save ? `${name}.ts` : `${name}-${Date.now()}.ts`);
				await fs.promises.writeFile(filePath, generatedScript, "utf8");
				wf = { name, path: filePath, scope: "user", hash: sha256(generatedScript), description: def.meta.description };
			} else if (params.mode === "script") {
				if (!params.script) return { content: [{ type: "text", text: "Script workflow mode requires script." }], isError: true };
				if ((params.requireApproval ?? true) && !ctx.hasUI) return { content: [{ type: "text", text: "Script mode requires interactive approval unless requireApproval=false." }], isError: true };
				generatedScript = params.script;
				const def = loadWorkflowFromSource(generatedScript, "<tool script workflow>");
				const name = safeName(def.meta.name);
				const dir = params.save ? USER_WORKFLOW_DIR : path.join(os.tmpdir(), "pi-script-workflows");
				await fs.promises.mkdir(dir, { recursive: true });
				const filePath = path.join(dir, params.save ? `${name}.ts` : `${name}-${Date.now()}.ts`);
				await fs.promises.writeFile(filePath, generatedScript, "utf8");
				wf = { name, path: filePath, scope: "user", hash: sha256(generatedScript), description: def.meta.description };
			}

			if (!wf) return { content: [{ type: "text", text: "Unable to prepare workflow." }], isError: true };
			if ((params.requireApproval ?? true) && params.mode === "saved" && !(await ensureApproved(wf, ctx))) return { content: [{ type: "text", text: "Workflow not approved." }], isError: true };
			if ((params.requireApproval ?? true) && params.mode !== "saved" && ctx.hasUI) {
				const ok = await ctx.ui.confirm("Run generated workflow?", `Workflow: ${wf.name}\nPath: ${wf.path}\n\nGenerated/script workflows run with your permissions. Only continue if you trust the script.`);
				if (!ok) return { content: [{ type: "text", text: "Workflow not approved." }], isError: true };
			}
			const run = await startRun(pi, wf, params.args ?? "", ctx, { budget: params.budget });
			return { content: [{ type: "text", text: `Started workflow ${run.name} (${run.id}). Details: ${run.runDir}` }], details: run };
		},
	});
}
