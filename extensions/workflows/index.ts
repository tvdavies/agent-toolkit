/**
 * Pi Dynamic Workflows extension.
 *
 * MVP: discover trusted workflow scripts, approve project scripts by content hash,
 * run workflows in the background, orchestrate isolated Pi subagents, stream compact
 * progress via status/widget, post final reports, and persist run details to disk.
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

interface WorkflowDefinition {
	name: string;
	description?: string;
	run: (ctx: WorkflowContext, args: string) => Promise<WorkflowReport | string>;
}

interface WorkflowFile {
	name: string;
	description?: string;
	path: string;
	scope: WorkflowScope;
	hash: string;
}

interface WorkflowReport {
	markdown: string;
	details?: unknown;
}

interface AgentOptions {
	label: string;
	task: string;
	cwd?: string;
	model?: string;
	tools?: string[];
	agentScope?: AgentScope;
	timeoutMs?: number;
	expectedOutput?: "markdown" | "json" | "text";
	isolation?: "none" | "worktree";
	noCache?: boolean;
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
}

type WorkflowContext = ReturnType<typeof createWorkflowContext>;
const execFile = promisify(execFileCb);

const MAX_CONCURRENT_AGENTS = 8;
const MAX_AGENTS_PER_RUN = 100;
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

const activeRuns = new Map<string, RunState>();
const abortControllers = new Map<string, AbortController>();
let lastCtx: any;
let lastPi: ExtensionAPI | undefined;

function workflow(def: WorkflowDefinition): WorkflowDefinition {
	if (!def || typeof def.name !== "string" || typeof def.run !== "function") {
		throw new Error("Workflow must export workflow({ name, run })");
	}
	return def;
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

function validateScript(source: string): string[] {
	const errors: string[] = [];
	const allowedImport = /^\s*import\s+\{\s*workflow\s*\}\s+from\s+["']pi-workflows["'];?\s*$/;
	const importStatements = source.match(/(^|\n)\s*import\s+[\s\S]*?;(?=\s|$)/g) ?? [];
	for (const statement of importStatements) {
		if (!allowedImport.test(statement.trim())) errors.push(`Forbidden import: ${statement.trim()}`);
	}
	const forbidden = [/\bfrom\s+["']node:/, /\bfrom\s+["']fs["']/, /\bfrom\s+["']child_process["']/, /\bprocess\b/, /\bDate\.now\s*\(/, /\bMath\.random\s*\(/, /\beval\s*\(/, /\bFunction\s*\(/, /\bimport\s*\(/];
	for (const re of forbidden) {
		if (re.test(source)) errors.push(`Forbidden pattern: ${re}`);
	}
	if (!/export\s+default\s+workflow\s*\(/.test(source) && !/module\.exports\s*=\s*workflow\s*\(/.test(source)) {
		errors.push("Workflow must default-export workflow({ ... })");
	}
	if (!/ctx\.report\s*\(/.test(source)) errors.push("Workflow should return ctx.report(...)");
	return errors;
}

function loadWorkflowFromSource(source: string, filePath: string): WorkflowDefinition {
	const errors = validateScript(source);
	if (errors.length > 0) throw new Error(errors.join("\n"));
	const transformed = source
		.replace(/(^|\n)\s*import\s+\{\s*workflow\s*\}\s+from\s+["']pi-workflows["'];?\s*/g, "$1")
		.replace(/export\s+default\s+workflow\s*\(/, "__workflow = workflow(")
		.replace(/module\.exports\s*=\s*workflow\s*\(/, "__workflow = workflow(");
	try {
		const sandbox = vm.createContext(Object.create(null));
		Object.defineProperty(sandbox, "workflow", { value: workflow, enumerable: true });
		Object.defineProperty(sandbox, "__workflow", { value: undefined, writable: true, enumerable: true });
		new vm.Script(`"use strict";\n${transformed}`, { filename: filePath, timeout: 1000 }).runInContext(sandbox, { timeout: 1000 });
		const loaded = (sandbox as any).__workflow as WorkflowDefinition | undefined;
		if (!loaded) throw new Error("Workflow module did not set a default workflow export.");
		return loaded;
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
		};
		run.agents.push(record);
		await persistRun(run, { type: "agent_cache_hit", label: options.label, agent: agentName, cacheKey });
		updateUi(run);
		return { ...cached, usage: zeroUsage(), messages: cached.messages ?? [] };
	}

	const agentScope = options.agentScope ?? "user";
	const discovery = discoverAgents(options.cwd ?? run.cwd, agentScope);
	const agent = discovery.agents.find((a) => a.name === agentName);
	const record: AgentRecord = { label: options.label, agent: agentName, status: "running", startedAt: Date.now(), task: options.task };
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
			lines.push(`${icon} ${phase.name}`);
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

function safeSendWorkflowMessage(pi: ExtensionAPI, content: string): void {
	try {
		pi.sendMessage({ customType: "workflow-result", display: true, content }, { deliverAs: "followUp", triggerTurn: false });
	} catch {
		// In print mode or after session replacement the extension API may be stale.
		// The final report remains available in the persisted run state.
	}
}

function createWorkflowContext(run: RunState, controller: AbortController, parentModel: string) {
	let agentCount = 0;
	return {
		now: run.startedAt,
		async agent(agentName: string, options: AgentOptions): Promise<AgentResult> {
			agentCount++;
			if (agentCount > MAX_AGENTS_PER_RUN) throw new Error(`Workflow exceeded maxAgentsPerRun=${MAX_AGENTS_PER_RUN}`);
			if (!options?.label || !options?.task) throw new Error("ctx.agent requires stable label and task");
			return runSingleAgent(run, agentName, options, controller.signal, parentModel);
		},
		async phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
			const phase: PhaseRecord = { name, status: "running", startedAt: Date.now() };
			run.currentPhase = name;
			run.phases.push(phase);
			await persistRun(run, { type: "phase_start", name });
			updateUi(run);
			try {
				const result = await fn();
				phase.status = "succeeded";
				phase.endedAt = Date.now();
				await persistRun(run, { type: "phase_end", name, status: phase.status });
				updateUi(run);
				return result;
			} catch (error: any) {
				phase.status = "failed";
				phase.endedAt = Date.now();
				await persistRun(run, { type: "phase_end", name, status: phase.status, error: error?.message ?? String(error) });
				updateUi(run);
				throw error;
			}
		},
		async mapLimit<TIn, TOut>(items: TIn[], limit: number, fn: (item: TIn, index: number) => Promise<TOut>): Promise<TOut[]> {
			const concurrency = Math.max(1, Math.min(limit, MAX_CONCURRENT_AGENTS, items.length || 1));
			const results = new Array<TOut>(items.length);
			let next = 0;
			const workers = new Array(concurrency).fill(null).map(async () => {
				while (!controller.signal.aborted) {
					const index = next++;
					if (index >= items.length) return;
					results[index] = await fn(items[index], index);
				}
			});
			await Promise.all(workers);
			return results;
		},
		parallel<TIn, TOut>(items: TIn[], fn: (item: TIn, index: number) => Promise<TOut>): Promise<TOut[]> {
			return this.mapLimit(items, MAX_CONCURRENT_AGENTS, fn);
		},
		shard<T>(items: T[], shardCountOrSize: number): T[][] {
			if (items.length === 0) return [];
			const n = Math.max(1, Math.floor(shardCountOrSize));
			const size = n >= items.length ? 1 : Math.ceil(items.length / n);
			const out: T[][] = [];
			for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
			return out;
		},
		report(markdown: string, details?: unknown): WorkflowReport {
			return { markdown, details };
		},
		summarize(results: unknown): string {
			return JSON.stringify(results, (_key, value) => {
				if (value && typeof value === "object" && "messages" in value) return { ...value, messages: undefined };
				return value;
			}, 2).slice(0, MAX_AGENT_OUTPUT_BYTES);
		},
		async log(message: string, details?: unknown): Promise<void> {
			await persistRun(run, { type: "log", message, details });
		},
		async checkpoint(key: string, value: unknown): Promise<void> {
			await writeJsonFile(path.join(run.runDir, "checkpoints", `${safeName(key)}.json`), value);
			await persistRun(run, { type: "checkpoint", key });
		},
		getCheckpoint(key: string): unknown {
			return readJsonFile(path.join(run.runDir, "checkpoints", `${safeName(key)}.json`), undefined);
		},
		async retry<T>(fn: () => Promise<T>, options?: { retries?: number; delayMs?: number }): Promise<T> {
			const retries = options?.retries ?? 2;
			let lastError: unknown;
			for (let i = 0; i <= retries; i++) {
				try { return await fn(); } catch (error) { lastError = error; if (i < retries && options?.delayMs) await new Promise((r) => setTimeout(r, options.delayMs)); }
			}
			throw lastError;
		},
		fail(message: string): never { throw new Error(message); },
	};
}

async function startRun(pi: ExtensionAPI, workflowFile: WorkflowFile, args: string, ctx: any, options?: { reuseFrom?: RunState }): Promise<RunState> {
	lastCtx = ctx;
	lastPi = pi;
	const source = await fs.promises.readFile(workflowFile.path, "utf8");
	const def = loadWorkflowFromSource(source, workflowFile.path);
	const name = safeName(def.name || workflowFile.name);
	const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
	const runDir = path.join(runBaseDir(ctx.cwd), id);
	const inheritedCache = options?.reuseFrom?.hash === workflowFile.hash && options.reuseFrom.args === args ? options.reuseFrom.agentCache : undefined;
	const run: RunState = { id, name, workflowPath: workflowFile.path, scope: workflowFile.scope, hash: workflowFile.hash, cwd: ctx.cwd, args, status: "pending", startedAt: Date.now(), phases: [], agents: [], agentCache: inheritedCache ? { ...inheritedCache } : {}, runDir };
	const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
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
			const wctx = createWorkflowContext(run, controller, parentModel);
			const result = await def.run(wctx, args);
			const report = typeof result === "string" ? result : result.markdown;
			run.status = "succeeded";
			run.report = report || "(workflow completed with no report)";
			run.endedAt = Date.now();
			await persistRun(run, { type: "run_end", status: run.status, reportBytes: Buffer.byteLength(run.report, "utf8") });
			const usage = aggregateUsage(run);
			safeSendWorkflowMessage(pi, `# Workflow complete: ${run.name}\n\n${run.report}\n\n---\nRun: ${run.id}\nAgents: ${run.agents.length}\nUsage: ${usage.turns} turns, $${usage.cost.toFixed(4)}\nDetails: ${run.runDir}`);
		} catch (error: any) {
			run.status = controller.signal.aborted ? "cancelled" : "failed";
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
	const agentLines = run.agents.length ? run.agents.map((a) => `- ${a.label} (${a.agent}): ${a.status}${a.cached ? " cached" : ""} ${a.usage ? `$${a.usage.cost.toFixed(4)}` : ""}`).join("\n") : "(none)";
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

const FLOW_GENERATOR_SYSTEM_PROMPT = `You generate Pi workflow scripts.

Return exactly one TypeScript module, with no prose, using this import:
import { workflow } from "pi-workflows";

Requirements:
- default export workflow({ name, description, async run(ctx, args) { ... } })
- stable kebab-case workflow name
- agents perform repository/tool work via ctx.agent; the script only orchestrates
- use ctx.phase for named phases
- use ctx.mapLimit with explicit bounded concurrency for fan-out
- use stable unique agent labels
- end by returning ctx.report(markdown)
- do not import anything except pi-workflows
- do not use fs, child_process, process, fetch, eval, dynamic import, Date.now, or Math.random
- include a validation or cross-review phase for audits, research, plans, or risky outputs

Available ctx helpers: agent, phase, mapLimit, parallel, shard, report, summarize, log, checkpoint, getCheckpoint, retry, fail. Use ctx.now for a deterministic run timestamp if needed.
Available agents: delegate (broad multi-step work; inherits the parent model). Use delegate for every workflow agent stream unless the user explicitly asks for a named specialist.`;

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
	script: Type.Optional(Type.String({ description: "Workflow TypeScript source for script mode" })),
	args: Type.Optional(Type.String({ description: "Raw workflow arguments" })),
	save: Type.Optional(Type.Boolean({ description: "Save generated/script workflow to the user workflow directory before running", default: false })),
	requireApproval: Type.Optional(Type.Boolean({ default: true })),
});

export default function (pi: ExtensionAPI) {
	lastPi = pi;

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		const interrupted = listPersistedRuns(ctx.cwd).filter((r) => r.status === "running" || r.status === "pending");
		for (const run of interrupted) {
			run.status = "interrupted";
			run.endedAt = Date.now();
			await persistRun(run, { type: "run_interrupted", reason: "session_start" });
		}
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
				else if (detail === "Rerun fresh") await startRun(pi, { name: run.name, path: path.join(run.runDir, "script.ts"), scope: "user", hash: run.hash }, run.args, ctx);
				else if (detail === "Rerun with cache reuse") await startRun(pi, { name: run.name, path: path.join(run.runDir, "script.ts"), scope: "user", hash: run.hash }, run.args, ctx, { reuseFrom: run });
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
				let name = safeName(def.name);
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
					name = safeName(def.name);
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
				const wf: WorkflowFile = { name, path: filePath, scope, hash: sha256(finalScript), description: def.description };
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
			const next = await startRun(pi, wf, prior.args, ctx, { reuseFrom });
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
				await fs.promises.writeFile(filePath, `import { workflow } from "pi-workflows";\n\nexport default workflow({\n  name: "workflow-test",\n  description: "Run two tiny subagents concurrently",\n  async run(ctx, args) {\n    const tasks = [\n      { label: "pwd", task: "Report the current working directory and do not modify files." },\n      { label: "list", task: "List up to five top-level files or directories and do not modify files." }\n    ];\n    const results = await ctx.phase("parallel smoke test", () =>\n      ctx.mapLimit(tasks, 2, (t) => ctx.agent("delegate", { label: t.label, task: t.task, tools: ["bash"] }))\n    );\n    return ctx.report("## Smoke test results\\n\\n" + results.map((r) => "### " + r.label + "\\n" + r.text).join("\\n\\n"));\n  }\n});\n`, "utf8");
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
		description: "Start a Pi workflow in the background. Supports saved workflows, generated workflows, and provided workflow scripts for repeatable multi-subagent orchestration tasks.",
		parameters: WorkflowRunParams,
		promptSnippet: "Start saved/generated/script Pi workflows for broad multi-agent audits, research, migrations, and validation.",
		promptGuidelines: ["Use workflow_run for broad codebase audits, large migrations, cross-checked research, or validation tasks that benefit from many bounded-concurrency subagents."],
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
				const name = safeName(def.name);
				const dir = params.save ? USER_WORKFLOW_DIR : path.join(os.tmpdir(), "pi-generated-workflows");
				await fs.promises.mkdir(dir, { recursive: true });
				const filePath = path.join(dir, params.save ? `${name}.ts` : `${name}-${Date.now()}.ts`);
				await fs.promises.writeFile(filePath, generatedScript, "utf8");
				wf = { name, path: filePath, scope: "user", hash: sha256(generatedScript), description: def.description };
			} else if (params.mode === "script") {
				if (!params.script) return { content: [{ type: "text", text: "Script workflow mode requires script." }], isError: true };
				if ((params.requireApproval ?? true) && !ctx.hasUI) return { content: [{ type: "text", text: "Script mode requires interactive approval unless requireApproval=false." }], isError: true };
				generatedScript = params.script;
				const def = loadWorkflowFromSource(generatedScript, "<tool script workflow>");
				const name = safeName(def.name);
				const dir = params.save ? USER_WORKFLOW_DIR : path.join(os.tmpdir(), "pi-script-workflows");
				await fs.promises.mkdir(dir, { recursive: true });
				const filePath = path.join(dir, params.save ? `${name}.ts` : `${name}-${Date.now()}.ts`);
				await fs.promises.writeFile(filePath, generatedScript, "utf8");
				wf = { name, path: filePath, scope: "user", hash: sha256(generatedScript), description: def.description };
			}

			if (!wf) return { content: [{ type: "text", text: "Unable to prepare workflow." }], isError: true };
			if ((params.requireApproval ?? true) && params.mode === "saved" && !(await ensureApproved(wf, ctx))) return { content: [{ type: "text", text: "Workflow not approved." }], isError: true };
			if ((params.requireApproval ?? true) && params.mode !== "saved" && ctx.hasUI) {
				const ok = await ctx.ui.confirm("Run generated workflow?", `Workflow: ${wf.name}\nPath: ${wf.path}\n\nGenerated/script workflows run with your permissions. Only continue if you trust the script.`);
				if (!ok) return { content: [{ type: "text", text: "Workflow not approved." }], isError: true };
			}
			const run = await startRun(pi, wf, params.args ?? "", ctx);
			return { content: [{ type: "text", text: `Started workflow ${run.name} (${run.id}). Details: ${run.runDir}` }], details: run };
		},
	});
}
