/**
 * Pi Dynamic Workflows extension.
 *
 * Discover trusted workflow scripts, approve project scripts by content hash,
 * run workflows in the background, orchestrate isolated Pi subagents, stream compact
 * progress via status/widget, post final reports, and persist run details to disk.
 *
 * Security and correctness boundaries:
 *
 * - Workflow JavaScript never executes in the Pi process. It runs in a killable bubblewrap
 *   subprocess with an empty environment, no network or host filesystem, and authenticated
 *   RPC access only to agent/phase/log/declared-workflow capabilities.
 * - Approval and execution use the same immutable root/dependency source snapshots.
 * - Every child uses a unique detached Git clone containing the pinned launch checkout's
 *   tracked state. Child tools are allowlisted; Bash sees only minimal runtimes plus that
 *   writable clone and is networkless unless explicitly requested by validated workflow source;
 *   labels are never identities.
 * - Agent admission is process-wide, fair, abort-aware, and budget-reserved. Child failures,
 *   cancellation, timeouts, and invalid structured output are explicit terminal outcomes.
 * - Run events are sequenced and serialized; snapshots and full result artifacts are written
 *   atomically before completion is queued through an owner-scoped persisted outbox.
 * - pi-subagents provides native structured output validation and live session transcripts;
 *   workflow_status exposes queued/running state and bounded transcript tails.
 *
 * Tool allowlists remain authoritative. The normal tool description is compact; mode:'guide'
 * returns the complete authoring contract only when it is needed.
 *
 * Workflow mode (/workflow-mode on, or PI_WORKFLOW_MODE) makes orchestration available as an
 * escalation path, not a default tax on every substantive task. Its standing directive requires
 * inline deliberation first and keeps fan-out proportional to independently useful work.
 */

import { execFile as execFileCb } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { complete, type Message, type UserMessage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentScope, discoverAgents } from "pi-subagents/src/agents/agents.ts";
import { sandboxCommand } from "./child-guard.ts";
import { freshAgentSessionPath, renderSessionTail, runWorkflowChild } from "./runner.ts";
import { runWorkflowSandbox, type SandboxBudgetSnapshot, type SandboxHost } from "./sandbox.ts";
import { AbortableScheduler } from "./scheduler.ts";
import { extractMeta, validateScript, type WorkflowMeta } from "./script-format.ts";
import { appendJsonLine, atomicWriteFile, atomicWriteJson } from "./store.ts";

export { extractMeta, validateScript } from "./script-format.ts";

type RunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";
type AgentStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
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

interface WorkflowFile {
	name: string;
	description?: string;
	path: string;
	scope: WorkflowScope;
	hash: string;
}

interface PreparedWorkflow extends WorkflowFile {
	source: string;
	meta: WorkflowMeta;
	/** Hash of the root source plus every declared immutable dependency snapshot. */
	approvalHash: string;
	dependencies: Map<string, PreparedWorkflow>;
}

// Options accepted by the script-facing agent(prompt, opts) global (Claude Code shape).
interface AgentRunOptions {
	label?: string;
	phase?: string;
	schema?: unknown;
	model?: string;
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	isolation?: "worktree";
	agentType?: string;
	/** Ordinary child failure becomes null only when this is explicitly true. */
	allowFailure?: boolean;
	/** Cache reuse is opt-in and only applies to successful deterministic calls. */
	cache?: boolean;
	/** Preserved diff artifacts from earlier agents in this run to seed into this child's clone. */
	patches?: string[];
	/** Explicitly allow this child's Bash commands to access the network. Default: false. */
	network?: boolean;
	/** Expose an ephemeral GitHub token inside sandboxed Bash; implies network. */
	githubAuth?: boolean;
	/** Return stable agent/workspace/diff metadata together with the ordinary value. */
	returnMetadata?: boolean;
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
	schema?: Record<string, unknown>;
	isolation: "worktree";
	useCache?: boolean;
	allowFailure?: boolean;
	invocationId: string;
	patches?: string[];
	network?: boolean;
	githubAuth?: boolean;
	// Progress group this agent belongs to. Lets a script attribute an agent to a named phase
	// independently of the global phase() cursor — important inside pipeline()/parallel() stages
	// where the global cursor races. Defaults to the run's current phase.
	phase?: string;
}

interface AgentResult {
	id: string;
	label: string;
	agent: string;
	status: "succeeded" | "failed" | "cancelled" | "timed_out";
	text: string;
	json?: unknown;
	messages: Message[];
	usage: UsageStats;
	error?: string;
	worktree?: WorktreeResult;
	sessionFile?: string;
	outputPath?: string;
	outputHash?: string;
	structuredOutputPath?: string;
	structuredOutputHash?: string;
	requestedModel?: string;
	actualModel?: string;
	modelAttempts?: Array<{ model: string; success: boolean; exitCode?: number; error?: string }>;
}

interface WorktreeResult {
	path: string;
	diffPath?: string;
	diffBytes: number;
	status: string;
	preserved: boolean;
}

interface RepositorySnapshot {
	root: string;
	relativeCwd: string;
	head: string;
	trackedPatchPath?: string;
	trackedPatchHash: string;
	untrackedNames: string[];
	remote?: string;
	hash: string;
}

interface AgentRecord {
	id: string;
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
	sessionFile?: string;
	outputPath?: string;
	outputHash?: string;
	structuredOutputPath?: string;
	structuredOutputHash?: string;
	allowedFailure?: boolean;
	requestedModel?: string;
	actualModel?: string;
	thinking?: ThinkingLevel;
	modelAttempts?: Array<{ model: string; success: boolean; exitCode?: number; error?: string }>;
}

interface PhaseRecord {
	name: string;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
}

export interface RunState {
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
	deadlineAt?: number;
	currentPhase?: string;
	phases: PhaseRecord[];
	agents: AgentRecord[];
	agentCache?: Record<string, AgentResult>;
	report?: string;
	error?: string;
	runDir: string;
	meta?: WorkflowMeta;
	eventSeq?: number;
	ownerSession?: string;
	deliveryStatus?: "pending" | "sent_unacknowledged" | "failed";
	deliveryMessageId?: string;
	deliveryError?: string;
	repositorySnapshotHash?: string;
	repositorySnapshot?: RepositorySnapshot;
	// Token budget for subagent OUTPUT across the whole run; null/undefined means unbounded.
	// It is intentionally not forwarded as pi-subagents' maxTokens, whose resource-limit
	// semantics include broader token traffic and previously killed healthy long-context agents.
	budgetTotal?: number | null;
	/** Legacy persisted field; ignored by current output-only budget accounting. */
	budgetBaselineOutput?: number;
	/** Conservative output-capacity reservations for concurrently queued/running children. */
	budgetReserved?: number;
}

const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

export function transitionRunStatus(run: RunState, next: RunStatus): void {
	if (run.status === next) return;
	if (TERMINAL_RUN_STATUSES.has(run.status)) throw new Error(`Illegal workflow transition ${run.status} -> ${next} for ${run.id}.`);
	const legal = run.status === "pending"
		? next === "running" || next === "cancelled" || next === "timed_out" || next === "interrupted" || next === "failed"
		: run.status === "running" && TERMINAL_RUN_STATUSES.has(next);
	if (!legal) throw new Error(`Illegal workflow transition ${run.status} -> ${next} for ${run.id}.`);
	run.status = next;
}

const execFile = promisify(execFileCb);

function parseMaxAgentsPerRun(): number {
	const configured = Number(process.env.PI_WORKFLOW_MAX_AGENTS_PER_RUN);
	if (!Number.isFinite(configured) || configured <= 0) return 16;
	return Math.max(1, Math.min(64, Math.floor(configured)));
}

const MAX_CONCURRENT_AGENTS = Math.max(1, Math.min(16, os.cpus().length - 2));
// A hard runaway ceiling, not a target. Normal guidance remains four agents or fewer.
const MAX_AGENTS_PER_RUN = parseMaxAgentsPerRun();
const MAX_AGENT_OUTPUT_BYTES = 50 * 1024;
const DEFAULT_AGENT_OUTPUT_RESERVATION = 16_384;
const globalAgentScheduler = new AbortableScheduler(MAX_CONCURRENT_AGENTS);

class WorkflowCancelledError extends Error {
	constructor(message = "Workflow cancelled by user.") { super(message); this.name = "WorkflowCancelledError"; }
}
class WorkflowTimedOutError extends Error {
	constructor(message: string) { super(message); this.name = "WorkflowTimedOutError"; }
}
class WorkflowBudgetError extends Error {
	constructor(message: string) { super(message); this.name = "WorkflowBudgetError"; }
}

export function workflowRetryGuidance(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error ?? "");
	if (/resource limit|token budget|exhausted its token budget|no models? match|model .*not found|failed to load model|unknown agent|requires a git repository|repository changed|missing|not approved|invalid|forbidden|schema/i.test(message)) {
		return "Retry policy: deterministic configuration/input/resource failure. Do not relaunch the whole workflow. Fix the cause or fall back to direct execution.";
	}
	if (/overload|rate.?limit|\b429\b|\b502\b|\b503\b|\b504\b|ECONNRESET|ETIMEDOUT|temporar/i.test(message)) {
		return "Retry policy: potentially transient failure. Retry only the failed child, at most once; do not relaunch the whole workflow.";
	}
	return "Retry policy: unclassified failure. Inspect it before acting; do not automatically relaunch the whole workflow.";
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new WorkflowCancelledError();
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortError(signal);
}
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

// Prefixed to the report when a finished background workflow is delivered back into the
// session. The delivery WAKES the agent (triggerTurn), so the framing tells it the message
// is an automated completion notification it should act on — not a user prompt.
const WORKFLOW_RESULT_BANNER =
	"[Automated background notification — NOT a user message. A workflow you launched has finished. Read the fleet-state note at the END of this message before responding: if OTHER runs you launched are still active, do NOT produce a final answer or complete report — acknowledge progress at most and wait to be woken again. Only when the fleet-state note says all reports are in should you act on the combined results (e.g. launch the next phase) or produce the final synthesis for the user.]";

function parseBudgetEnv(): number | null {
	const raw = process.env.PI_WORKFLOW_BUDGET?.trim();
	if (!raw) return null;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function sha256(text: string | Buffer): string {
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
	await atomicWriteJson(filePath, value);
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

async function readWorkflowSource(filePath: string): Promise<string> {
	const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
	const handle = await fs.promises.open(filePath, flags);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error(`Workflow source is not a regular file: ${filePath}`);
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

export async function prepareWorkflow(
	workflow: WorkflowFile,
	cwd: string,
	depth = 0,
	seen = new Set<string>(),
	sourceOverride?: string,
): Promise<PreparedWorkflow> {
	if (depth > 1) throw new Error("Nested workflow dependencies are limited to one level.");
	const source = sourceOverride ?? await readWorkflowSource(workflow.path);
	const errors = validateScript(source);
	if (errors.length > 0) throw new Error(errors.join("\n"));
	const meta = extractMeta(source);
	const hash = sha256(source);
	const key = `${workflow.path}|${hash}`;
	if (seen.has(key)) throw new Error(`Workflow dependency cycle detected at ${workflow.name}.`);
	const nextSeen = new Set(seen).add(key);
	const dependencies = new Map<string, PreparedWorkflow>();
	for (const dependencyName of meta.dependencies ?? []) {
		const dependency = discoverWorkflows(cwd).find((candidate) => candidate.name === safeName(dependencyName));
		if (!dependency) throw new Error(`Declared workflow dependency not found: ${dependencyName}`);
		const prepared = await prepareWorkflow(dependency, cwd, depth + 1, nextSeen);
		if ((prepared.meta.dependencies?.length ?? 0) > 0) throw new Error(`Nested dependency ${dependencyName} may not declare further dependencies.`);
		dependencies.set(safeName(dependencyName), prepared);
	}
	const dependencyIdentity = [...dependencies.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, prepared]) => ({ name, hash: prepared.approvalHash }));
	const approvalHash = sha256(stableJson({ version: 2, sourceHash: hash, dependencies: dependencyIdentity, sandbox: "bwrap-node-v3-minimal-child-guard" }));
	return {
		...workflow,
		name: safeName(meta.name || workflow.name),
		description: meta.description,
		hash,
		source,
		meta,
		approvalHash,
		dependencies,
	};
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

export function workflowModeGuidance(enabled: boolean): string {
	if (!enabled) {
		return "Default to handling tasks yourself. Reach for workflow_run only when serial work cannot provide the required independent breadth, risk reduction, or scale. Use one direct subagent instead when only one specialist is needed. (Enable orchestration guidance with /workflow-mode on.)";
	}
	return [
		"Workflow mode is ON, but workflows are an ESCALATION path rather than the default for every substantive task.",
		"Think and scout inline first, then explicitly decide whether orchestration earns its coordination cost. Do not launch a workflow merely because a task is non-trivial or extra confidence would be nice.",
		"Use workflow_run only when there are at least two genuinely independent workstreams, the result is high-risk enough to justify independent verification, or the work cannot fit one context. Use one direct subagent for a single specialist or focused second opinion.",
		"Start with at most two agents and one workflow. A normal task should use no more than four total workflow agents. Expand only when the first pass identifies distinct unresolved gaps and novel yield justifies the added wall time; more than six agents or another whole-workflow attempt requires an explicit user request.",
		"Keep adversarial verification for security, migrations, infrastructure, destructive changes, public API compatibility, or similarly costly decisions—not routine analysis or implementation.",
		"Never automatically relaunch a whole failed workflow. Retry only a failed child, at most once, for a classified transient failure. For provider/model unavailability, invalid configuration, missing inputs, repository eligibility, or budget/resource failures, fix the cause or fall back to direct execution.",
		"Prefer parent synthesis. Add a synthesis agent only when the reports genuinely require independent arbitration or exceed the parent's available context.",
	].join(" ");
}

// Injected into the main agent's system prompt before each turn. Workflow mode changes the
// decision rubric, but never removes the option to conclude that direct execution is cheaper
// and sufficient. It also lists runnable saved workflows and subagents.
function buildWorkflowSystemPromptAddendum(cwd: string): string | null {
	const mode = readWorkflowMode();
	const workflows = discoverWorkflows(cwd);
	if (!mode.enabled && workflows.length === 0 && listInFlightRuns().length === 0) return null;

	const sections: string[] = ["## Workflow orchestration (workflow_run tool)"];

	const inFlight = listInFlightRuns();
	if (inFlight.length > 0) {
		sections.push(
			`ACTIVE workflow runs (their reports have NOT been delivered yet):\n${inFlight.map(describeRunLine).join("\n")}\nThese runs are still executing, so their results do not exist yet. Do NOT present final conclusions or a complete report this turn — deliver at most a partial summary that explicitly names the runs still pending. You will be woken with each run's report as it finishes; check progress with the workflow_status tool.`,
		);
	}

	sections.push(workflowModeGuidance(mode.enabled));

	const workflowLines = workflows.length
		? workflows.map((w) => `- ${w.name} (${w.scope})`).join("\n")
		: "- (none saved — use workflow_run mode:'script' to author one inline, or mode:'generate')";
	sections.push(`Saved workflows (run with workflow_run mode:'saved'):\n${workflowLines}`);

	try {
		const agents = discoverAgents(cwd, "user").agents;
		const agentLines = agents
			.slice(0, 24)
			.map((a) => {
				const summary = a.description ? ` — ${(a.description.split("\n")[0] ?? "").slice(0, 100)}` : "";
				return `- ${a.name}${summary}`;
			})
			.join("\n");
		if (agentLines) sections.push(`Subagents available to workflow scripts (agent(prompt, { agentType }), default scope):\n${agentLines}`);
	} catch {
		// Agent discovery is best-effort; a missing roster must not block the turn.
	}

	return sections.join("\n\n");
}

function truncateBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let out = text.slice(0, maxBytes);
	while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
	return `${out}\n\n[truncated; full output preserved on disk]`;
}

async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
		return true;
	} catch {
		return false;
	}
}

function shellArg(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function execWorkspaceGit(workspaceRoot: string, args: string[], maxBuffer = 50 * 1024 * 1024): Promise<{ stdout: string; stderr: string }> {
	const command = ["git", ...args.map(shellArg)].join(" ");
	return execFile("/bin/bash", ["-lc", sandboxCommand(command, workspaceRoot, workspaceRoot)], { maxBuffer, timeout: 60_000, encoding: "utf8" });
}

interface AgentWorktree {
	path: string;
	root: string;
	relativeCwd: string;
	baselineTree: string;
	seededTree: string;
}

export async function createAgentWorktree(run: RunState, record: AgentRecord, _cwd: string, inheritedPatches: string[] = []): Promise<AgentWorktree> {
	const snapshot = run.repositorySnapshot;
	if (!snapshot) throw new Error("Workflow agents require a pinned Git repository snapshot captured at run launch.");
	const { root, relativeCwd, head } = snapshot;
	const worktreeBase = path.join(os.homedir(), ".pi", "agent", "workflow-workspaces", run.id);
	await fs.promises.mkdir(worktreeBase, { recursive: true, mode: 0o700 });
	const worktreePath = path.join(worktreeBase, record.id);
	await execFile("git", ["clone", "--no-hardlinks", "--no-checkout", "--quiet", root, worktreePath], { cwd: worktreeBase });
	try {
	await execWorkspaceGit(worktreePath, ["checkout", "--detach", "--quiet", head]);
	if (snapshot.remote) await execWorkspaceGit(worktreePath, ["remote", "set-url", "origin", snapshot.remote]);
	else await execWorkspaceGit(worktreePath, ["remote", "remove", "origin"]);
	if (snapshot.trackedPatchPath) {
		const launchPatch = await fs.promises.readFile(snapshot.trackedPatchPath, "utf8");
		if (sha256(launchPatch) !== snapshot.trackedPatchHash) throw new Error("Pinned repository patch failed its integrity check.");
		await execFile("git", ["apply", "--binary", snapshot.trackedPatchPath], { cwd: worktreePath, maxBuffer: 50 * 1024 * 1024 });
	}
	await execWorkspaceGit(worktreePath, ["add", "-A"]);
	const baselineTree = (await execWorkspaceGit(worktreePath, ["write-tree"])).stdout.trim();
	await execWorkspaceGit(worktreePath, ["reset", "--mixed", "HEAD"]);
	const diffRoot = path.resolve(run.runDir, "worktree-diffs");
	for (const patchReference of inheritedPatches) {
		const patchPath = path.resolve(patchReference);
		if (!patchPath.startsWith(`${diffRoot}${path.sep}`) || path.extname(patchPath) !== ".diff") {
			throw new Error(`Inherited patch must be a preserved diff from this workflow run: ${patchReference}`);
		}
		await fs.promises.access(patchPath, fs.constants.R_OK);
		await execFile("git", ["apply", "--binary", patchPath], { cwd: worktreePath, maxBuffer: 50 * 1024 * 1024 });
	}
	await execWorkspaceGit(worktreePath, ["add", "-A"]);
	const seededTree = (await execWorkspaceGit(worktreePath, ["write-tree"])).stdout.trim();
	await execWorkspaceGit(worktreePath, ["reset", "--mixed", "HEAD"]);
	await persistRun(run, { type: "worktree_created", agentId: record.id, label: record.label, path: worktreePath, relativeCwd, baselineTree, seededTree, inheritedPatches, omittedUntracked: snapshot.untrackedNames });
	return { path: worktreePath, root, relativeCwd, baselineTree, seededTree };
	} catch (error) {
		await fs.promises.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

export async function finalizeAgentWorktree(run: RunState, record: AgentRecord, worktree: AgentWorktree): Promise<WorktreeResult> {
	await execWorkspaceGit(worktree.path, ["add", "-A"]);
	const currentTree = (await execWorkspaceGit(worktree.path, ["write-tree"])).stdout.trim();
	const diff = (await execWorkspaceGit(worktree.path, ["diff", "--cached", "--binary", worktree.baselineTree, "--"])).stdout;
	const status = (await execWorkspaceGit(worktree.path, ["diff", "--cached", "--name-status", worktree.baselineTree, "--"])).stdout;
	if (currentTree !== worktree.seededTree && (diff.trim() || status.trim())) {
		const diffDir = path.join(run.runDir, "worktree-diffs");
		await fs.promises.mkdir(diffDir, { recursive: true, mode: 0o700 });
		const diffPath = path.join(diffDir, `${record.id}.diff`);
		await atomicWriteFile(diffPath, diff || status);
		await persistRun(run, { type: "worktree_preserved", agentId: record.id, label: record.label, path: worktree.path, diffPath, diffBytes: Buffer.byteLength(diff || status, "utf8"), status });
		return { path: worktree.path, diffPath, diffBytes: Buffer.byteLength(diff || status, "utf8"), status, preserved: true };
	}
	await fs.promises.rm(worktree.path, { recursive: true, force: true });
	await persistRun(run, { type: "worktree_removed", agentId: record.id, label: record.label, path: worktree.path });
	return { path: worktree.path, diffBytes: 0, status, preserved: false };
}

async function persistAgentArtifacts(run: RunState, record: AgentRecord, output: string, structured: unknown): Promise<{ outputPath: string; outputHash: string; structuredOutputPath?: string; structuredOutputHash?: string }> {
	const resultDir = path.join(run.runDir, "results");
	const outputPath = path.join(resultDir, `${record.id}.txt`);
	await atomicWriteFile(outputPath, output);
	const outputHash = sha256(output);
	let structuredOutputPath: string | undefined;
	let structuredOutputHash: string | undefined;
	if (structured !== undefined) {
		structuredOutputPath = path.join(resultDir, `${record.id}.json`);
		const structuredJson = `${JSON.stringify(structured, null, 2)}\n`;
		structuredOutputHash = sha256(structuredJson);
		await atomicWriteFile(structuredOutputPath, structuredJson);
	}
	record.outputPath = outputPath;
	record.outputHash = outputHash;
	record.structuredOutputPath = structuredOutputPath;
	record.structuredOutputHash = structuredOutputHash;
	return { outputPath, outputHash, structuredOutputPath, structuredOutputHash };
}

async function runSingleAgent(
	run: RunState,
	agentName: string,
	options: AgentOptions,
	signal: AbortSignal,
	parentModel: string,
	record: AgentRecord,
): Promise<AgentResult> {
	throwIfAborted(signal);
	const agentScope = options.agentScope ?? "user";
	const discovery = discoverAgents(options.cwd ?? run.cwd, agentScope);
	const agent = discovery.agents.find((candidate) => candidate.name === agentName);
	const effectiveModel = options.model ?? agent?.model ?? parentModel;
	record.requestedModel = options.model ?? agent?.model;
	record.thinking = options.thinking ?? (agent?.thinking as ThinkingLevel | undefined);
	const cacheKey = agentCacheKey(run, agentName, options, agent, effectiveModel);
	const cachedCandidate = options.useCache ? run.agentCache?.[cacheKey] : undefined;
	let cachedOutput: string | undefined;
	let cachedStructured: unknown;
	if (cachedCandidate?.status === "succeeded" && cachedCandidate.outputPath && cachedCandidate.outputHash && fs.existsSync(cachedCandidate.outputPath)) {
		const output = await fs.promises.readFile(cachedCandidate.outputPath, "utf8");
		if (sha256(output) === cachedCandidate.outputHash) cachedOutput = output;
		if (cachedOutput !== undefined && options.schema) {
			if (!cachedCandidate.structuredOutputPath || !cachedCandidate.structuredOutputHash || !fs.existsSync(cachedCandidate.structuredOutputPath)) cachedOutput = undefined;
			else {
				const structuredJson = await fs.promises.readFile(cachedCandidate.structuredOutputPath, "utf8");
				if (sha256(structuredJson) !== cachedCandidate.structuredOutputHash) cachedOutput = undefined;
				else {
					try { cachedStructured = JSON.parse(structuredJson); } catch { cachedOutput = undefined; }
				}
			}
		}
	}
	if (cachedCandidate && cachedOutput !== undefined) {
		const cached = cachedCandidate;
		const artifacts = await persistAgentArtifacts(run, record, cachedOutput, options.schema ? cachedStructured : cached.json);
		record.status = "succeeded";
		record.endedAt = Date.now();
		record.outputBytes = Buffer.byteLength(cachedOutput || "", "utf8");
		record.usage = zeroUsage();
		record.cached = true;
		await persistRun(run, { type: "agent_cache_hit", agentId: record.id, label: record.label, agent: agentName, cacheKey });
		updateUi(run);
		return { ...cached, id: record.id, text: truncateBytes(cachedOutput, MAX_AGENT_OUTPUT_BYTES), json: options.schema ? cachedStructured : cached.json, usage: zeroUsage(), messages: [], ...artifacts };
	}
	if (cachedCandidate) await persistRun(run, { type: "agent_cache_miss", agentId: record.id, label: record.label, reason: "missing or corrupt artifact" });

	record.status = "running";
	record.startedAt = Date.now();
	await persistRun(run, { type: "agent_start", agentId: record.id, label: record.label, agent: agentName, task: options.task, cacheKey, requestedModel: record.requestedModel, effectiveModel, thinking: record.thinking });
	updateUi(run);
	if (!agent) {
		const available = discovery.agents.map((candidate) => candidate.name).join(", ") || "none";
		record.status = "failed";
		record.endedAt = Date.now();
		record.error = `Unknown agent ${agentName}. Available: ${available}`;
		await persistRun(run, { type: "agent_end", agentId: record.id, label: record.label, status: record.status, error: record.error });
		return { id: record.id, label: record.label, agent: agentName, status: "failed", text: "", messages: [], usage: zeroUsage(), error: record.error };
	}

	let worktree: AgentWorktree | undefined;
	let worktreeResult: WorktreeResult | undefined;
	try {
		worktree = await createAgentWorktree(run, record, options.cwd ?? run.cwd, options.patches);
		const executionCwd = path.join(worktree.path, worktree.relativeCwd);
		throwIfAborted(signal);
		const sessionFile = freshAgentSessionPath(run.runDir, record.id);
		record.sessionFile = sessionFile;
		await persistRun(run, { type: "agent_session", agentId: record.id, label: record.label, sessionFile });
		const child = await runWorkflowChild({
			cwd: executionCwd,
			workspaceRoot: worktree.path,
			agent,
			task: options.task,
			runId: run.id,
			label: record.id,
			sessionFile,
			model: options.model,
			parentModel,
			thinking: options.thinking,
			tools: options.tools,
			timeoutMs: options.timeoutMs,
			network: options.network,
			githubAuth: options.githubAuth,
			schema: options.schema,
			artifactDir: path.join(run.runDir, "results", record.id),
			signal,
		});
		worktreeResult = await finalizeAgentWorktree(run, record, worktree);

		const output = child.text;
		if (signal.aborted) record.status = abortError(signal) instanceof WorkflowTimedOutError ? "timed_out" : "cancelled";
		else if (child.timedOut) record.status = "timed_out";
		else if (child.cancelled) record.status = "cancelled";
		else if (child.exitCode !== 0 || child.error) record.status = "failed";
		else record.status = "succeeded";
		record.endedAt = Date.now();
		record.outputBytes = Buffer.byteLength(output, "utf8");
		record.usage = child.usage;
		record.actualModel = child.model;
		record.modelAttempts = child.modelAttempts;
		record.error = record.status === "succeeded" ? undefined : child.error || `${record.status} (exit ${child.exitCode})`;
		const artifacts = await persistAgentArtifacts(run, record, output || record.error || "", child.structuredOutput);
		const worktreeNote = worktreeResult.preserved ? `\n\n[Worktree changes preserved at ${worktreeResult.path}; diff: ${worktreeResult.diffPath}]` : "";
		const result: AgentResult = {
			id: record.id,
			label: record.label,
			agent: agentName,
			status: record.status === "succeeded" ? "succeeded" : record.status === "cancelled" || record.status === "timed_out" ? record.status : "failed",
			text: truncateBytes(`${output || record.error || ""}${worktreeNote}`, MAX_AGENT_OUTPUT_BYTES),
			json: child.structuredOutput,
			messages: child.messages,
			usage: child.usage,
			error: record.error,
			worktree: worktreeResult,
			sessionFile: child.sessionFile,
			requestedModel: record.requestedModel,
			actualModel: record.actualModel,
			modelAttempts: record.modelAttempts,
			...artifacts,
		};
		if (result.status === "succeeded" && options.useCache) {
			run.agentCache ??= {};
			run.agentCache[cacheKey] = { ...result, text: truncateBytes(output, MAX_AGENT_OUTPUT_BYTES), messages: [], sessionFile: undefined, worktree: undefined };
		}
		await persistRun(run, { type: "agent_end", agentId: record.id, label: record.label, status: record.status, usage: child.usage, error: record.error, cacheKey: options.useCache ? cacheKey : undefined, outputPath: artifacts.outputPath, structuredOutputPath: artifacts.structuredOutputPath, requestedModel: record.requestedModel, actualModel: record.actualModel, modelAttempts: record.modelAttempts, thinking: record.thinking });
		updateUi(run);
		return result;
	} catch (error) {
		if (record.status === "running") {
			record.status = signal.aborted ? (abortError(signal) instanceof WorkflowTimedOutError ? "timed_out" : "cancelled") : "failed";
			record.endedAt = Date.now();
			record.error = error instanceof Error ? error.message : String(error);
			await persistRun(run, { type: "agent_end", agentId: record.id, label: record.label, status: record.status, error: record.error });
		}
		throw error;
	} finally {
		if (worktree && !worktreeResult) {
			try { await finalizeAgentWorktree(run, record, worktree); } catch { /* preserve on unexpected cleanup failure */ }
		}
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

function agentCacheKey(run: RunState, agentName: string, options: AgentOptions, agentConfig: unknown, effectiveModel: string): string {
	return sha256(stableJson({
		version: 2,
		workflowHash: run.hash,
		args: run.args,
		repositorySnapshotHash: run.repositorySnapshotHash,
		agent: agentName,
		agentConfig,
		task: options.task,
		cwd: options.cwd ?? run.cwd,
		effectiveModel,
		thinking: options.thinking,
		tools: options.tools,
		agentScope: options.agentScope ?? "user",
		schema: options.schema,
		patches: (options.patches ?? []).map((patchPath) => ({ name: path.basename(patchPath), hash: fs.existsSync(patchPath) ? sha256(fs.readFileSync(patchPath)) : "missing" })),
		network: options.network === true,
		githubAuth: options.githubAuth === true,
		isolation: options.isolation,
		runtime: "workflow-sandbox-v3-pi-subagents-0.28.0",
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

// budget.spent() is deliberately OUTPUT-only and scoped to this workflow's children.
// pi-subagents' maxTokens is a broader cumulative resource limit, so forwarding this budget
// there caused healthy long-context children to fail before producing their bounded output.
export function workflowOutputSpent(run: RunState): number {
	return aggregateUsage(run).output;
}

function workflowSpent(run: RunState): number {
	return workflowOutputSpent(run);
}

function workflowRemaining(run: RunState): number {
	if (run.budgetTotal == null) return Number.POSITIVE_INFINITY;
	return Math.max(0, run.budgetTotal - workflowSpent(run) - (run.budgetReserved ?? 0));
}

const persistenceQueues = new Map<string, Promise<void>>();

export async function persistRun(run: RunState, event: Record<string, unknown>): Promise<void> {
	run.eventSeq = (run.eventSeq ?? 0) + 1;
	const eventEntry = { seq: run.eventSeq, ts: nowIso(), ...event };
	// Capture each snapshot at enqueue time. Otherwise a delayed write could serialize future
	// mutations under an earlier journal sequence number.
	const stateJson = `${JSON.stringify(run, null, 2)}\n`;
	const manifestJson = `${JSON.stringify({
		id: run.id, name: run.name, args: run.args, cwd: run.cwd, workflowPath: run.workflowPath, scope: run.scope, hash: run.hash,
		startedAt: run.startedAt, endedAt: run.endedAt, deadlineAt: run.deadlineAt, status: run.status, eventSeq: run.eventSeq,
		deliveryStatus: run.deliveryStatus, ownerSession: run.ownerSession,
	}, null, 2)}\n`;
	const previous = persistenceQueues.get(run.id) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(async () => {
		await fs.promises.mkdir(run.runDir, { recursive: true, mode: 0o700 });
		await appendJsonLine(path.join(run.runDir, "events.jsonl"), eventEntry);
		await atomicWriteFile(path.join(run.runDir, "state.json"), stateJson);
		await atomicWriteFile(path.join(run.runDir, "manifest.json"), manifestJson);
	});
	persistenceQueues.set(run.id, next);
	await next;
}

async function drainPersistence(run: RunState): Promise<void> {
	await persistenceQueues.get(run.id);
}

function updateUi(changedRun: RunState): void {
	try {
		if (!lastCtx?.ui) return;
		const fleet = listInFlightRuns();
		if (fleet.length === 0) {
			lastCtx.ui.setStatus(EXTENSION_KEY, `flow: ${changedRun.status}`);
			lastCtx.ui.setWidget(EXTENSION_KEY, [`Workflow ${changedRun.name}: ${changedRun.status}`]);
			return;
		}
		lastCtx.ui.setStatus(EXTENSION_KEY, `flow: ${fleet.length} active • ${globalAgentScheduler.activeCount} running • ${globalAgentScheduler.queuedCount} queued`);
		const lines = [`Workflow fleet: ${fleet.length} active`];
		for (const run of fleet.slice(0, 8)) {
			const running = run.agents.filter((agent) => agent.status === "running").length;
			const queued = run.agents.filter((agent) => agent.status === "queued").length;
			const done = run.agents.length - running - queued;
			lines.push(`${run.name} (${run.id.slice(0, 8)}): ${run.currentPhase ?? "-"} • ${done}/${run.agents.length} done • ${running} running • ${queued} queued`);
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

// Pure variant for tests: runs that have not yet delivered their report.
export function inFlightRunsOf(runs: Iterable<RunState>, excludeId?: string): RunState[] {
	return Array.from(runs).filter((r) => r.id !== excludeId && (r.status === "running" || r.status === "pending"));
}

// Runs whose execution is active. Completion framing additionally includes terminal runs
// whose durable outbox has not been sent yet.
export function belongsToSession(run: RunState, owner: string | undefined): boolean {
	// Ownerless legacy runs remain visible for backward-compatible recovery. A run with an
	// explicit owner is never claimed when the current session identity is unavailable.
	return run.ownerSession ? Boolean(owner && run.ownerSession === owner) : true;
}

function ownedActiveRuns(): RunState[] {
	const owner = currentSessionFile();
	return Array.from(activeRuns.values()).filter((run) => belongsToSession(run, owner));
}

function listInFlightRuns(excludeId?: string): RunState[] {
	return inFlightRunsOf(ownedActiveRuns(), excludeId);
}

export function reportsPendingOf(runs: Iterable<RunState>, excludeId?: string): RunState[] {
	return Array.from(runs).filter((run) => run.id !== excludeId && (
		run.status === "running" || run.status === "pending" || run.deliveryStatus === "pending" || run.deliveryStatus === "failed"
	));
}

export function describeRunLine(run: RunState): string {
	const done = run.agents.filter((a) => a.status !== "running" && a.status !== "queued").length;
	return `- ${run.name} (${run.id}): ${run.status}, phase ${run.currentPhase ?? "-"}, agents ${done}/${run.agents.length} done, elapsed ${formatDuration(Date.now() - run.startedAt)}`;
}

// Appended to every completion delivery so the woken agent knows whether it may finalise.
// This is the outstanding-work ledger: without it the agent treats the first report it sees
// as "the task is done" and writes the full synthesis while other runs are still executing.
export function buildFleetStateNoteFor(runs: Iterable<RunState>, excludeId?: string): string {
	const pending = reportsPendingOf(runs, excludeId);
	if (pending.length === 0) {
		return "Fleet state: no other workflow executions or undelivered reports remain — every report from the runs you launched is now in. It is safe to synthesise the final answer (or launch the next phase) now.";
	}
	return `Fleet state: ⚠ ${pending.length} other workflow report(s) you launched are NOT YET DELIVERED:\n${pending.map(describeRunLine).join("\n")}\nDo NOT produce a final answer or complete report yet — acknowledge progress at most; you will be woken as reports are delivered (check progress with the workflow_status tool).`;
}

function buildFleetStateNote(excludeId?: string): string {
	return buildFleetStateNoteFor(ownedActiveRuns(), excludeId);
}

interface WorkflowOutbox {
	messageId: string;
	ownerSession?: string;
	content: string;
	status: "pending" | "sent_unacknowledged" | "failed";
	error?: string;
}

function currentSessionFile(): string | undefined {
	try { return lastCtx?.sessionManager?.getSessionFile?.() ?? undefined; } catch { return undefined; }
}

async function deliverOutbox(pi: ExtensionAPI, run: RunState, outbox: WorkflowOutbox): Promise<void> {
	if (outbox.ownerSession && currentSessionFile() !== outbox.ownerSession) {
		run.deliveryStatus = "failed";
		run.deliveryError = "Completion is waiting for the session that launched this workflow.";
		outbox.status = "failed";
		outbox.error = run.deliveryError;
		await atomicWriteJson(path.join(run.runDir, "outbox.json"), outbox);
		await persistRun(run, { type: "delivery_deferred", messageId: outbox.messageId, reason: run.deliveryError });
		return;
	}
	try {
		const framed = `${WORKFLOW_RESULT_BANNER}\n\n${outbox.content}\n\n---\n${buildFleetStateNote(run.id)}`;
		pi.sendMessage({ customType: "workflow-result", display: true, content: framed, details: { messageId: outbox.messageId, runId: run.id } }, { deliverAs: "followUp", triggerTurn: true });
		// The current Pi API has no durable enqueue receipt. Record exactly what is known rather
		// than claiming delivery; a future host receipt can promote this state to acknowledged.
		run.deliveryStatus = "sent_unacknowledged";
		run.deliveryError = undefined;
		outbox.status = "sent_unacknowledged";
		outbox.error = undefined;
		await atomicWriteJson(path.join(run.runDir, "outbox.json"), outbox);
		await persistRun(run, { type: "delivery_sent_unacknowledged", messageId: outbox.messageId });
		if (TERMINAL_RUN_STATUSES.has(run.status)) activeRuns.delete(run.id);
	} catch (error) {
		run.deliveryStatus = "failed";
		run.deliveryError = error instanceof Error ? error.message : String(error);
		outbox.status = "failed";
		outbox.error = run.deliveryError;
		await atomicWriteJson(path.join(run.runDir, "outbox.json"), outbox);
		await persistRun(run, { type: "delivery_failed", messageId: outbox.messageId, error: run.deliveryError });
	}
}

// Persist an owner-scoped outbox before attempting wake delivery. Delivery is replayable after
// an extension restart, but remains explicitly unacknowledged until Pi exposes a durable receipt.
async function safeSendWorkflowMessage(run: RunState, content: string): Promise<void> {
	const outbox: WorkflowOutbox = {
		messageId: run.deliveryMessageId ?? crypto.randomUUID(),
		ownerSession: run.ownerSession,
		content,
		status: "pending",
	};
	try {
		run.deliveryMessageId = outbox.messageId;
		run.deliveryStatus = "pending";
		await atomicWriteJson(path.join(run.runDir, "outbox.json"), outbox);
		await persistRun(run, { type: "delivery_queued", messageId: outbox.messageId, ownerSession: outbox.ownerSession });
		if (lastPi) await deliverOutbox(lastPi, run, outbox);
	} catch (error) {
		// Delivery/persistence failure must never rewrite a truthful execution terminal state.
		run.deliveryStatus = "failed";
		run.deliveryError = error instanceof Error ? error.message : String(error);
		await persistRun(run, { type: "delivery_failed", messageId: outbox.messageId, error: run.deliveryError }).catch(() => undefined);
	}
}

async function replayPendingDeliveries(pi: ExtensionAPI, cwd: string): Promise<void> {
	const owner = currentSessionFile();
	const pending = listPersistedRuns(cwd).filter((run) =>
		(run.deliveryStatus === "pending" || run.deliveryStatus === "failed") &&
		belongsToSession(run, owner),
	).filter((run) => fs.existsSync(path.join(run.runDir, "outbox.json")));
	// Register the whole replay batch before sending the first item so its fleet note cannot
	// claim later outboxes have already arrived.
	for (const run of pending) activeRuns.set(run.id, run);
	for (const run of pending) {
		const outbox = readJsonFile<WorkflowOutbox | null>(path.join(run.runDir, "outbox.json"), null);
		if (!outbox) continue;
		await deliverOutbox(pi, run, outbox);
		await drainPersistence(run).catch(() => undefined);
		persistenceQueues.delete(run.id);
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

async function closeOpenPhase(run: RunState, status: RunStatus = "succeeded"): Promise<void> {
	const current = run.phases[run.phases.length - 1];
	if (current && current.status === "running") {
		current.status = status;
		current.endedAt = Date.now();
		await persistRun(run, { type: "phase_end", name: current.name, status });
	}
}

interface WorkflowEngine {
	counters: { agentCount: number; invocationSeq: number };
	depth: number;
}

function budgetSnapshot(run: RunState): SandboxBudgetSnapshot {
	const remaining = workflowRemaining(run);
	return { total: run.budgetTotal ?? null, spent: workflowSpent(run), remaining: Number.isFinite(remaining) ? remaining : null };
}

function sanitizeGitRemote(remote: string): string {
	try {
		const parsed = new URL(remote);
		if (parsed.username || parsed.password) {
			parsed.username = "";
			parsed.password = "";
		}
		return parsed.toString();
	} catch {
		// SCP-style SSH remotes (git@host:org/repo.git) and local paths do not encode a URL
		// password. Clone creation replaces local-path origins before a child starts.
		return remote;
	}
}

async function readRepositoryIdentity(cwd: string): Promise<{ root: string; relativeCwd: string; head: string; diff: string; untrackedNames: string[]; remote?: string; hash: string } | undefined> {
	if (!(await isGitRepo(cwd))) return undefined;
	const root = (await execFile("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
	const relativeCwd = path.relative(root, cwd) || ".";
	const head = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
	const diff = (await execFile("git", ["diff", "--binary", "HEAD"], { cwd: root, maxBuffer: 50 * 1024 * 1024 })).stdout;
	const untrackedNames = (await execFile("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root })).stdout
		.split("\n").map((line) => line.trim()).filter(Boolean).sort();
	// Detect common concurrent-mutation races while the multi-command snapshot is captured.
	// Patch application has its own repository-scoped lock; unrelated Git clients cannot be
	// forced to honour it, so a repeated identity read is the fail-closed consistency check.
	const headAfter = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
	const diffAfter = (await execFile("git", ["diff", "--binary", "HEAD"], { cwd: root, maxBuffer: 50 * 1024 * 1024 })).stdout;
	const untrackedAfter = (await execFile("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root })).stdout
		.split("\n").map((line) => line.trim()).filter(Boolean).sort();
	if (headAfter !== head || sha256(diffAfter) !== sha256(diff) || stableJson(untrackedAfter) !== stableJson(untrackedNames)) {
		throw new Error("Repository changed while its workflow snapshot was being captured; retry from a stable checkout.");
	}
	let remote: string | undefined;
	try {
		const configuredRemote = (await execFile("git", ["remote", "get-url", "origin"], { cwd: root })).stdout.trim();
		remote = configuredRemote ? sanitizeGitRemote(configuredRemote) : undefined;
	} catch { /* optional */ }
	const hash = sha256(stableJson({ version: 2, root, relativeCwd, head, trackedDiffHash: sha256(diff), untrackedNames }));
	return { root, relativeCwd, head, diff, untrackedNames, remote, hash };
}

async function captureRepositorySnapshot(cwd: string, runDir: string): Promise<RepositorySnapshot | undefined> {
	const identity = await readRepositoryIdentity(cwd);
	if (!identity) return undefined;
	let trackedPatchPath: string | undefined;
	if (identity.diff.trim()) {
		trackedPatchPath = path.join(runDir, "repository-launch.diff");
		await atomicWriteFile(trackedPatchPath, identity.diff);
	}
	return {
		root: identity.root,
		relativeCwd: identity.relativeCwd,
		head: identity.head,
		trackedPatchPath,
		trackedPatchHash: sha256(identity.diff),
		untrackedNames: identity.untrackedNames,
		remote: identity.remote,
		hash: identity.hash,
	};
}

async function computeRepositorySnapshotHash(cwd: string): Promise<string> {
	const identity = await readRepositoryIdentity(cwd);
	return identity?.hash ?? sha256(stableJson({ version: 2, cwd, git: false }));
}

async function executePreparedWorkflow(
	prepared: PreparedWorkflow,
	run: RunState,
	controller: AbortController,
	parentModel: string,
	knownAgents: Set<string>,
	args: unknown,
	engine: WorkflowEngine,
): Promise<unknown> {
	const host: SandboxHost = {
		async agent(payload) {
			throwIfAborted(controller.signal);
			const prompt = payload.prompt;
			const opts = payload.opts && typeof payload.opts === "object" && !Array.isArray(payload.opts) ? payload.opts as AgentRunOptions : {};
			if (typeof prompt !== "string" || !prompt.trim()) throw new Error("agent(prompt) requires a non-empty prompt string.");
			engine.counters.agentCount++;
			if (engine.counters.agentCount > MAX_AGENTS_PER_RUN) throw new Error(`Workflow exceeded the per-run agent limit (${MAX_AGENTS_PER_RUN}).`);
			const remaining = workflowRemaining(run);
			if (run.budgetTotal != null && remaining <= 0) throw new WorkflowBudgetError(`Workflow exhausted its token budget (${run.budgetTotal} output tokens; spent ${workflowSpent(run)}).`);
			if (opts.schema !== undefined && (!opts.schema || typeof opts.schema !== "object" || Array.isArray(opts.schema))) throw new Error("agent schema must be a JSON Schema object.");
			if (opts.patches !== undefined && (!Array.isArray(opts.patches) || opts.patches.some((value) => typeof value !== "string"))) throw new Error("agent patches must be an array of preserved diff paths returned by earlier agents in this run.");
			if (opts.network !== undefined && typeof opts.network !== "boolean") throw new Error("agent network must be a boolean.");
			if (opts.githubAuth !== undefined && typeof opts.githubAuth !== "boolean") throw new Error("agent githubAuth must be a boolean.");
			if (opts.returnMetadata !== undefined && typeof opts.returnMetadata !== "boolean") throw new Error("agent returnMetadata must be a boolean.");
			if (opts.returnMetadata && opts.cache) throw new Error("agent returnMetadata cannot be combined with cache reuse because cached calls do not own a live workspace artifact.");
			const sequence = ++engine.counters.invocationSeq;
			const invocationId = `agent-${sequence.toString().padStart(4, "0")}`;
			const label = typeof opts.label === "string" && opts.label.trim() ? opts.label.trim() : invocationId;
			const allowFailure = opts.allowFailure === true || (opts.allowFailure === undefined && prepared.meta.version !== 2);
			const reservation = run.budgetTotal == null ? 0 : Math.max(1, Math.min(DEFAULT_AGENT_OUTPUT_RESERVATION, remaining));
			run.budgetReserved = (run.budgetReserved ?? 0) + reservation;
			const record: AgentRecord = {
				id: invocationId,
				label,
				agent: mapAgentType(opts.agentType, knownAgents),
				status: "queued",
				startedAt: Date.now(),
				task: prompt,
				phase: typeof opts.phase === "string" && opts.phase.trim() ? opts.phase.trim() : run.currentPhase,
				allowedFailure: allowFailure,
			};
			run.agents.push(record);
			await persistRun(run, { type: "agent_queued", agentId: record.id, label: record.label, agent: record.agent, reservation });
			updateUi(run);
			let release: (() => void) | undefined;
			try {
				release = await globalAgentScheduler.acquire(controller.signal);
				throwIfAborted(controller.signal);
				const options: AgentOptions = {
					label,
					task: prompt,
					model: mapModel(opts.model),
					thinking: mapEffort(opts.effort),
					schema: opts.schema as Record<string, unknown> | undefined,
					isolation: "worktree",
					useCache: opts.cache === true,
					allowFailure,
					invocationId,
					patches: opts.patches,
					network: opts.network === true || opts.githubAuth === true,
					githubAuth: opts.githubAuth === true,
					phase: record.phase,
				};
				const result = await runSingleAgent(run, record.agent, options, controller.signal, parentModel, record);
				if (result.status === "timed_out") {
					const timeoutError = new WorkflowTimedOutError(`Agent ${label} timed out: ${result.error ?? "deadline exceeded"}`);
					controller.abort(timeoutError);
					throw timeoutError;
				}
				if (result.status === "cancelled") {
					const cancelledError = new WorkflowCancelledError(`Agent ${label} was cancelled: ${result.error ?? "cancelled"}`);
					controller.abort(cancelledError);
					throw cancelledError;
				}
				if (result.status !== "succeeded") {
					if (allowFailure) return { value: null, budget: budgetSnapshot(run) };
					throw new Error(`Agent ${label} failed: ${result.error ?? "no result"}`);
				}
				const value = opts.schema !== undefined ? result.json : result.text;
				return {
					value: opts.returnMetadata
						? { value, agentId: result.id, workspacePath: result.worktree?.preserved ? result.worktree.path : null, diffPath: result.worktree?.diffPath ?? null }
						: value,
					budget: budgetSnapshot(run),
				};
			} catch (error) {
				if (record.status === "queued") {
					record.status = controller.signal.aborted ? (abortError(controller.signal) instanceof WorkflowTimedOutError ? "timed_out" : "cancelled") : "failed";
					record.endedAt = Date.now();
					record.error = error instanceof Error ? error.message : String(error);
					await persistRun(run, { type: "agent_end", agentId: record.id, label: record.label, status: record.status, error: record.error });
				}
				throw error;
			} finally {
				release?.();
				run.budgetReserved = Math.max(0, (run.budgetReserved ?? 0) - reservation);
			}
		},
		async phase(payload) {
			const title = String(payload.title ?? "").trim();
			if (!title) throw new Error("phase(title) requires a non-empty title.");
			await closeOpenPhase(run);
			const record: PhaseRecord = { name: title, status: "running", startedAt: Date.now() };
			run.currentPhase = title;
			run.phases.push(record);
			await persistRun(run, { type: "phase_start", name: title });
			updateUi(run);
			return {};
		},
		async log(payload) {
			await persistRun(run, { type: "log", message: String(payload.message ?? "") });
			updateUi(run);
			return {};
		},
		async workflow(payload) {
			if (engine.depth >= 1) throw new Error("workflow() nesting is one level only.");
			if (typeof payload.nameOrRef !== "string") throw new Error("Nested workflows must be declared by saved name; dynamic scriptPath execution is disabled.");
			const name = safeName(payload.nameOrRef);
			const dependency = prepared.dependencies.get(name);
			if (!dependency) throw new Error(`Nested workflow ${name} was not declared in meta.dependencies and included in approval.`);
			await persistRun(run, { type: "nested_workflow_start", name, parent: prepared.name });
			const value = await executePreparedWorkflow(dependency, run, controller, parentModel, knownAgents, payload.args, { counters: engine.counters, depth: engine.depth + 1 });
			await persistRun(run, { type: "nested_workflow_end", name });
			return { value, budget: budgetSnapshot(run) };
		},
	};
	return runWorkflowSandbox({
		source: prepared.source,
		fileName: prepared.path,
		args,
		budget: budgetSnapshot(run),
		host,
		signal: controller.signal,
		onFailure: (error) => { if (!controller.signal.aborted) controller.abort(error); },
		timeoutMs: MAX_RUN_DURATION_MS,
	});
}

async function startRun(pi: ExtensionAPI, prepared: PreparedWorkflow, args: string, ctx: any, options?: { reuseFrom?: RunState; budget?: number | null }): Promise<RunState> {
	lastCtx = ctx;
	lastPi = pi;
	const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
	const runDir = path.join(runBaseDir(ctx.cwd), id);
	await fs.promises.mkdir(runDir, { recursive: true, mode: 0o700 });
	const repositorySnapshot = await captureRepositorySnapshot(ctx.cwd, runDir);
	if (!repositorySnapshot) {
		await fs.promises.rm(runDir, { recursive: true, force: true });
		throw new Error("Workflow agents require a Git repository so the launch snapshot and every child workspace can be isolated.");
	}
	const repositorySnapshotHash = repositorySnapshot.hash;
	const inheritedCache = options?.reuseFrom?.hash === prepared.approvalHash && options.reuseFrom.args === args && options.reuseFrom.repositorySnapshotHash === repositorySnapshotHash
		? options.reuseFrom.agentCache
		: undefined;
	const budgetTotal = options?.budget != null && Number.isFinite(options.budget) && options.budget > 0 ? options.budget : parseBudgetEnv();
	const run: RunState = {
		id,
		name: prepared.name,
		workflowPath: prepared.path,
		scope: prepared.scope,
		hash: prepared.approvalHash,
		cwd: ctx.cwd,
		args,
		status: "pending",
		startedAt: Date.now(),
		deadlineAt: Date.now() + MAX_RUN_DURATION_MS,
		phases: [],
		agents: [],
		agentCache: inheritedCache ? { ...inheritedCache } : {},
		runDir,
		meta: prepared.meta,
		eventSeq: 0,
		ownerSession: ctx.sessionManager?.getSessionFile?.() ?? undefined,
		deliveryStatus: "pending",
		budgetTotal,
		budgetReserved: 0,
		repositorySnapshotHash,
		repositorySnapshot,
	};
	const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
	const knownAgents = new Set<string>(safeDiscoverAgentNames(ctx.cwd));
	await atomicWriteFile(path.join(runDir, "script.js"), prepared.source);
	for (const [name, dependency] of prepared.dependencies) {
		await atomicWriteFile(path.join(runDir, "dependencies", `${safeName(name)}.js`), dependency.source);
	}
	await persistRun(run, { type: "run_created", sourceHash: prepared.hash, approvalHash: prepared.approvalHash, repositorySnapshotHash });
	activeRuns.set(id, run);
	const controller = new AbortController();
	abortControllers.set(id, controller);

	void (async () => {
		const runTimeout = setTimeout(() => {
			controller.abort(new WorkflowTimedOutError(`Workflow exceeded its ${formatDuration(MAX_RUN_DURATION_MS)} deadline.`));
			void persistRun(run, { type: "run_timeout", maxRunDurationMs: MAX_RUN_DURATION_MS });
		}, MAX_RUN_DURATION_MS);
		transitionRunStatus(run, "running");
		await persistRun(run, { type: "run_start" });
		updateUi(run);
		try {
			const result = await executePreparedWorkflow(prepared, run, controller, parentModel, knownAgents, parseWorkflowArgs(args), { counters: { agentCount: 0, invocationSeq: 0 }, depth: 0 });
			throwIfAborted(controller.signal);
			run.report = formatWorkflowResult(result);
			run.endedAt = Date.now();
			await atomicWriteFile(path.join(run.runDir, "report.md"), run.report);
			await closeOpenPhase(run);
			throwIfAborted(controller.signal);
			transitionRunStatus(run, "succeeded");
			await persistRun(run, { type: "run_end", status: run.status, reportBytes: Buffer.byteLength(run.report, "utf8") });
			await drainPersistence(run);
			const usage = aggregateUsage(run);
			const budgetNote = run.budgetTotal != null ? ` (budget ${workflowSpent(run)}/${run.budgetTotal} output tokens)` : "";
			await safeSendWorkflowMessage(run, `# Workflow complete: ${run.name}\n\n${run.report}\n\n---\nRun: ${run.id}\nAgents: ${run.agents.length}\nUsage: ${usage.turns} turns, ${usage.output} output tokens${budgetNote}, $${usage.cost.toFixed(4)}\nDetails: ${run.runDir}`);
		} catch (error) {
			// A sandbox/protocol failure must also stop any host capability already in flight.
			if (!controller.signal.aborted) controller.abort(error);
			const reason = abortError(controller.signal);
			const terminalStatus: RunStatus = reason instanceof WorkflowTimedOutError ? "timed_out" : reason instanceof WorkflowCancelledError ? "cancelled" : "failed";
			await closeOpenPhase(run, terminalStatus);
			transitionRunStatus(run, terminalStatus);
			run.error = reason instanceof Error ? reason.message : String(reason);
			run.endedAt = Date.now();
			await persistRun(run, { type: "run_end", status: run.status, error: run.error });
			await drainPersistence(run);
			await safeSendWorkflowMessage(run, `# Workflow ${run.status}: ${run.name}\n\n${run.error}\n\n${workflowRetryGuidance(run.error)}\n\nRun: ${run.id}\nDetails: ${run.runDir}`);
		} finally {
			clearTimeout(runTimeout);
			abortControllers.delete(id);
			await drainPersistence(run).catch(() => undefined);
			persistenceQueues.delete(id);
			updateUi(run);
			await clearUiIfNoActive();
		}
	})();
	return run;
}

function approvalKey(workflow: PreparedWorkflow, cwd: string): string {
	return `${cwd}|${workflow.path}|${workflow.approvalHash}`;
}

export function workflowSourceRequiresApproval(scope: WorkflowScope): boolean {
	// Agent-authored and user-saved workflows are already constrained by lexical validation,
	// the killable orchestration sandbox, and isolated child repositories. A second human gate
	// adds friction without granting them additional authority. Repository-provided project
	// sources retain their one-time immutable-snapshot trust boundary.
	return scope === "project";
}

async function ensureApproved(workflow: PreparedWorkflow, ctx: any): Promise<boolean> {
	if (workflow.scope !== "project") return true;
	const approvals = readJsonFile<Record<string, boolean>>(USER_APPROVAL_FILE, {});
	const key = approvalKey(workflow, ctx.cwd);
	if (approvals[key]) return true;
	if (!ctx.hasUI) return false;
	const dependencyLines = [...workflow.dependencies.entries()].map(([name, dependency]) => `- ${name}: ${dependency.hash.slice(0, 12)}`).join("\n") || "(none)";
	const ok = await ctx.ui.confirm("Run project workflow?", `Workflow: ${workflow.name}\nPath: ${workflow.path}\nApproved snapshot: ${workflow.approvalHash.slice(0, 12)}\nDependencies:\n${dependencyLines}\n\nThe JavaScript runs in a networkless, filesystem-isolated sandbox. Its only host capabilities are declared subagent calls. Child Bash is also isolated and networkless by default; inspect the approved source for explicit network:true or githubAuth:true calls.`);
	if (!ok) return false;
	approvals[key] = true;
	await writeJsonFile(USER_APPROVAL_FILE, approvals);
	return true;
}

async function ensureWorkflowApproved(workflow: PreparedWorkflow, ctx: any): Promise<boolean> {
	// A project workflow's immutable approval hash already covers its full dependency graph, so
	// stop there rather than prompting once per nested project source. User-authored roots need
	// no prompt, but still recurse in case they explicitly depend on repository-provided source.
	if (workflowSourceRequiresApproval(workflow.scope)) return ensureApproved(workflow, ctx);
	for (const dependency of workflow.dependencies.values()) {
		if (!(await ensureWorkflowApproved(dependency, ctx))) return false;
	}
	return true;
}

async function runNamedWorkflow(pi: ExtensionAPI, name: string, args: string, ctx: any): Promise<void> {
	lastCtx = ctx;
	const workflow = discoverWorkflows(ctx.cwd).find((candidate) => candidate.name === safeName(name));
	if (!workflow) {
		ctx.ui.notify(`Workflow not found: ${name}`, "error");
		return;
	}
	const prepared = await prepareWorkflow(workflow, ctx.cwd);
	if (!(await ensureWorkflowApproved(prepared, ctx))) {
		ctx.ui.notify("Workflow cancelled: not approved.", "warning");
		return;
	}
	const run = await startRun(pi, prepared, args, ctx);
	ctx.ui.notify(`Started workflow ${run.name} (${run.id}). Details: ${run.runDir}`, "info");
}

function listPersistedRuns(cwd: string): RunState[] {
	const base = runBaseDir(cwd);
	if (!fs.existsSync(base)) return [];
	const runs: RunState[] = [];
	for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const state = readJsonFile<RunState | null>(path.join(base, entry.name, "state.json"), null);
		if (state) {
			state.eventSeq ??= 0;
			state.budgetReserved ??= 0;
			state.agents = (state.agents ?? []).map((agent, index) => ({ ...agent, id: agent.id || `legacy-${index + 1}` }));
			runs.push(state);
		}
	}
	return runs.sort((a, b) => b.startedAt - a.startedAt);
}

function runScriptSnapshotPath(run: RunState): string {
	const current = path.join(run.runDir, "script.js");
	return fs.existsSync(current) ? current : path.join(run.runDir, "script.ts");
}

export async function preparePersistedRunWorkflow(run: RunState): Promise<PreparedWorkflow> {
	const scriptPath = runScriptSnapshotPath(run);
	const source = await readWorkflowSource(scriptPath);
	const errors = validateScript(source);
	if (errors.length) throw new Error(errors.join("\n"));
	const meta = extractMeta(source);
	const dependencies = new Map<string, PreparedWorkflow>();
	for (const dependencyName of meta.dependencies ?? []) {
		const name = safeName(dependencyName);
		const dependencyPath = path.join(run.runDir, "dependencies", `${name}.js`);
		if (!fs.existsSync(dependencyPath)) throw new Error(`Persisted dependency snapshot is missing: ${name}`);
		const dependencySource = await readWorkflowSource(dependencyPath);
		const dependencyErrors = validateScript(dependencySource);
		if (dependencyErrors.length) throw new Error(`Persisted dependency ${name} is invalid:\n${dependencyErrors.join("\n")}`);
		const dependencyMeta = extractMeta(dependencySource);
		if ((dependencyMeta.dependencies?.length ?? 0) > 0) throw new Error(`Persisted dependency ${name} exceeds the one-level nesting limit.`);
		const dependencyHash = sha256(dependencySource);
		const dependencyApprovalHash = sha256(stableJson({ version: 2, sourceHash: dependencyHash, dependencies: [], sandbox: "bwrap-node-v3-minimal-child-guard" }));
		dependencies.set(name, {
			name: safeName(dependencyMeta.name), path: dependencyPath, scope: "user", hash: dependencyHash,
			source: dependencySource, meta: dependencyMeta, approvalHash: dependencyApprovalHash, dependencies: new Map(),
		});
	}
	const hash = sha256(source);
	const dependencyIdentity = [...dependencies.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, dependency]) => ({ name, hash: dependency.approvalHash }));
	const approvalHash = sha256(stableJson({ version: 2, sourceHash: hash, dependencies: dependencyIdentity, sandbox: "bwrap-node-v3-minimal-child-guard" }));
	if (path.basename(scriptPath) === "script.js" && run.hash !== approvalHash) throw new Error("Persisted workflow snapshot does not match the run's immutable approval hash.");
	return {
		name: safeName(meta.name), description: meta.description, path: scriptPath, scope: "user", hash,
		source, meta, approvalHash, dependencies,
	};
}

function summarizeRuns(cwd: string): string {
	const discovered = discoverWorkflows(cwd);
	const runs = listPersistedRuns(cwd).slice(0, 20);
	const workflowLines = discovered.length ? discovered.map((w) => `- ${w.name} (${w.scope}) — ${w.path}`).join("\n") : "(none)";
	const runLines = runs.length ? runs.map((r) => {
		const done = r.agents.filter((a) => a.status !== "running" && a.status !== "queued").length;
		const usage = aggregateUsage(r);
		return `- ${r.name} ${r.status} ${done}/${r.agents.length} agents ${formatDuration((r.endedAt ?? Date.now()) - r.startedAt)} $${usage.cost.toFixed(4)} — ${r.id}`;
	}).join("\n") : "(none)";
	return `Workflows:\n${workflowLines}\n\nRecent runs:\n${runLines}`;
}

// Fleet summary for the agent-callable workflow_status tool: the finalise/don't-finalise
// verdict first, then in-flight runs (in-memory), then recent persisted runs.
function workflowFleetStatus(cwd: string): string {
	const persisted = listPersistedRuns(cwd);
	const owner = currentSessionFile();
	const ownerScoped = new Map<string, RunState>();
	for (const run of [...persisted, ...ownedActiveRuns()]) {
		if (belongsToSession(run, owner)) ownerScoped.set(run.id, run);
	}
	const pendingReports = reportsPendingOf(ownerScoped.values());
	const pendingIds = new Set(pendingReports.map((run) => run.id));
	const finished = persisted.filter((run) => !pendingIds.has(run.id)).slice(0, 10);
	const finishedLines = finished.length
		? finished.map((run) => {
			const usage = aggregateUsage(run);
			return `- ${run.name} (${run.id}): ${run.status}, delivery ${run.deliveryStatus ?? "unknown"}, ${run.agents.length} agents, ${formatDuration((run.endedAt ?? Date.now()) - run.startedAt)}, $${usage.cost.toFixed(4)}`;
		}).join("\n")
		: "(none)";
	const verdict = pendingReports.length === 0
		? "No workflow executions or undelivered reports remain. It is safe to finalise from the reports received."
		: `⚠ ${pendingReports.length} workflow report(s) are still executing or undelivered — do NOT finalise your answer yet.`;
	return [
		verdict,
		"",
		"Outstanding reports:",
		pendingReports.length ? pendingReports.map(describeRunLine).join("\n") : "(none)",
		"",
		"Recent finished runs:",
		finishedLines,
		"",
		"Inspect a run with workflow_status { runId } (add agentLabel for one agent's output, and tailLines to tail a running agent's transcript).",
	].join("\n");
}

function resolveAgentRecord(run: RunState, reference: string): AgentRecord | undefined {
	const byId = run.agents.find((agent) => agent.id === reference);
	if (byId) return byId;
	const byLabel = run.agents.filter((agent) => agent.label === reference);
	return byLabel.length === 1 ? byLabel[0] : undefined;
}

function findAgentDiffPath(run: RunState, agentReference: string): string | undefined {
	const record = resolveAgentRecord(run, agentReference);
	return record ? path.join(run.runDir, "worktree-diffs", `${record.id}.diff`) : undefined;
}

const patchApplicationQueues = new Map<string, Promise<void>>();

async function applyWorkflowPatch(run: RunState, agentReference: string, cwd: string, dryRun: boolean): Promise<string> {
	const record = resolveAgentRecord(run, agentReference);
	if (!record) throw new Error(`Agent reference is missing or ambiguous in run ${run.id}: ${agentReference}. Use the agent id.`);
	const diffPath = findAgentDiffPath(run, record.id);
	if (!diffPath || !fs.existsSync(diffPath)) throw new Error(`No diff found for agent ${record.id} in run ${run.id}.`);
	if (!(await isGitRepo(cwd))) throw new Error(`Patch target is not inside a git repository: ${cwd}`);
	const root = (await execFile("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
	const previous = patchApplicationQueues.get(root) ?? Promise.resolve();
	let releaseQueue: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => { releaseQueue = resolve; });
	patchApplicationQueues.set(root, previous.catch(() => undefined).then(() => gate));
	await previous.catch(() => undefined);
	let lock: fs.promises.FileHandle | undefined;
	let lockPath: string | undefined;
	try {
		const gitDirRaw = (await execFile("git", ["rev-parse", "--git-dir"], { cwd: root })).stdout.trim();
		const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.resolve(root, gitDirRaw);
		lockPath = path.join(gitDir, "pi-workflow-apply.lock");
		try { lock = await fs.promises.open(lockPath, "wx", 0o600); }
		catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			let ownerAlive = true;
			try {
				const ownerPid = Number((await fs.promises.readFile(lockPath, "utf8")).trim());
				if (!Number.isInteger(ownerPid) || ownerPid <= 0) ownerAlive = false;
				else process.kill(ownerPid, 0);
			} catch (ownerError: any) {
				if (ownerError?.code === "ESRCH" || ownerError?.code === "ENOENT") ownerAlive = false;
			}
			if (ownerAlive) throw new Error(`Another workflow patch application is already in progress for ${root}.`);
			await fs.promises.rm(lockPath, { force: true });
			lock = await fs.promises.open(lockPath, "wx", 0o600);
		}
		await lock.writeFile(String(process.pid));
		const currentSnapshot = await computeRepositorySnapshotHash(cwd);
		if (run.repositorySnapshotHash && currentSnapshot !== run.repositorySnapshotHash) {
			throw new Error("Patch target has drifted since workflow launch; refusing to apply without a fresh check/run.");
		}
		if (dryRun) {
			await execFile("git", ["apply", "--check", diffPath], { cwd });
			return `Patch applies cleanly: ${diffPath}`;
		}
		let clean = true;
		try { await execFile("git", ["diff", "--quiet", "HEAD", "--"], { cwd }); } catch { clean = false; }
		// --index takes Git's index lock and verifies index/worktree agreement when the launch
		// target is clean. Dirty launch snapshots need plain apply to preserve their staged/
		// unstaged shape, but still run under the extension's repository-scoped lock.
		await execFile("git", clean ? ["apply", "--index", diffPath] : ["apply", diffPath], { cwd });
		return `Applied workflow patch for ${run.id}/${record.id} to ${cwd}\nDiff: ${diffPath}`;
	} finally {
		await lock?.close().catch(() => undefined);
		if (lock && lockPath) await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
		releaseQueue();
	}
}

function readAgentOutput(record: AgentRecord): string | undefined {
	if (!record.outputPath || !fs.existsSync(record.outputPath)) return undefined;
	try { return truncateBytes(fs.readFileSync(record.outputPath, "utf8"), MAX_AGENT_OUTPUT_BYTES); } catch { return undefined; }
}

function workflowRunDetails(run: RunState, agentReference?: string, tailLines?: number): string {
	const usage = aggregateUsage(run);
	if (agentReference) {
		const agent = resolveAgentRecord(run, agentReference);
		if (!agent) return `Agent reference not found or ambiguous in run ${run.id}: ${agentReference}. Use an agent id.`;
		const diffPath = findAgentDiffPath(run, agent.id);
		const transcriptPath = agent.sessionFile ?? path.join(run.runDir, "agents", `${agent.id}.session.jsonl`);
		const showTail = tailLines !== undefined || agent.status === "running";
		return [
			`Workflow: ${run.name}`,
			`Run: ${run.id}`,
			`Agent: ${agent.label} [${agent.id}] (${agent.agent})`,
			`Status: ${agent.status}${agent.cached ? " (cached)" : ""}${agent.allowedFailure ? " (failure allowed)" : ""}`,
			`Duration: ${formatDuration((agent.endedAt ?? Date.now()) - agent.startedAt)}`,
			`Model: requested ${agent.requestedModel ?? "inherit"}; actual ${agent.actualModel ?? "unknown"}; thinking ${agent.thinking ?? "inherit"}`,
			...(agent.modelAttempts?.length ? [`Model attempts: ${agent.modelAttempts.map((attempt) => `${attempt.model}:${attempt.success ? "ok" : "failed"}`).join(", ")}`] : []),
			`Usage: ${agent.usage?.turns ?? 0} turns, $${(agent.usage?.cost ?? 0).toFixed(4)}`,
			`Transcript: ${transcriptPath}`,
			...(agent.outputPath ? [`Output artifact: ${agent.outputPath}`] : []),
			...(agent.structuredOutputPath ? [`Structured artifact: ${agent.structuredOutputPath}`] : []),
			...(diffPath && fs.existsSync(diffPath) ? [`Diff: ${diffPath}`] : []),
			"",
			"Task:",
			agent.task ?? "(task was not recorded by this runtime version)",
			"",
			"Output:",
			readAgentOutput(agent) ?? agent.error ?? (agent.status === "running" || agent.status === "queued" ? "(not finished — output so far below)" : "(no output artifact)"),
			...(showTail ? ["", `Output so far (transcript tail, last ${tailLines ?? 40} lines):`, renderSessionTail(transcriptPath, tailLines ?? 40)] : []),
		].join("\n");
	}
	const phaseLines = run.phases.length ? run.phases.map((p) => `- ${p.name}: ${p.status} (${formatDuration((p.endedAt ?? Date.now()) - p.startedAt)})`).join("\n") : "(none)";
	const agentLines = run.agents.length ? run.agents.map((a) => `- ${a.id} ${a.label} (${a.agent})${a.phase ? ` [${a.phase}]` : ""}: ${a.status}${a.cached ? " cached" : ""}${a.allowedFailure ? " allowed-failure" : ""} model=${a.actualModel ?? a.requestedModel ?? "inherit/unknown"} ${a.usage ? `$${a.usage.cost.toFixed(4)}` : ""}`).join("\n") : "(none)";
	return [
		`Workflow: ${run.name}`,
		`Run: ${run.id}`,
		`Status: ${run.status}`,
		`Deadline: ${run.deadlineAt ? new Date(run.deadlineAt).toISOString() : "unknown"}`,
		`Delivery: ${run.deliveryStatus ?? "unknown"}${run.deliveryError ? ` (${run.deliveryError})` : ""}`,
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
- Begin with: export const meta = { version: 2, name, description, phases, dependencies? } — a PURE object literal (no variables, function calls, spreads, or template interpolation). dependencies is an optional array of saved workflow names that may be called through workflow().
- After meta, write the orchestration body directly using the injected globals. Top-level await and a top-level return are allowed; the value you return becomes the report (return a markdown string, or an object that is rendered as JSON).

Injected globals (do NOT import anything — these are already in scope):
- agent(prompt, opts?) -> Promise<string | object | null>. Spawns ONE globally bounded subagent in a unique isolated Git clone. opts: { label, phase, schema, model, effort, agentType, allowFailure, cache, patches, network, githubAuth, returnMetadata }. With a JSON-Schema 'schema', pi-subagents validates native structured_output before returning it. patches accepts preserved .diff paths from earlier agents in the same run. Set returnMetadata:true to receive { value, agentId, workspacePath, diffPath } instead of the bare value. Child Bash networking is disabled unless network:true is visible in the validated workflow source; githubAuth:true additionally mounts an ephemeral GitHub token and implies network. Failures throw by default; only allowFailure:true converts an ordinary child failure to null. Cache reuse is opt-in with cache:true and cannot be combined with returnMetadata.
- parallel(thunks) -> Promise<any[]>. Runs an array of () => Promise thunks concurrently and awaits them ALL (a barrier). Failures propagate. Use ONLY when you genuinely need every result together.
- pipeline(items, stage1, stage2, ...) -> Promise<any[]>. Runs each item through all stages independently with NO barrier between stages; each stage receives (prevResult, originalItem, index). Wall-clock is the slowest single item, not the sum of stages. THIS IS THE DEFAULT for multi-stage work.
- phase(title) -> mark the start of a named phase (use titles from meta.phases).
- log(message) -> emit a progress line.
- args -> the parsed workflow arguments (a JSON value, or undefined).
- budget -> { total, spent(), remaining() }. total is the caller's subagent-output-token target (null when none was set). spent() counts only completed child output; parent-loop and child input/cache traffic are excluded. remaining() also subtracts conservative reservations for queued/running children. Once exhausted, further agent() calls THROW. Treat the budget as a ceiling, never as a target to consume.
- workflow(name, args?) -> run a saved workflow declared in meta.dependencies inline as a sub-step and return its result. Dynamic script paths are forbidden; nesting is one level only.

agentType selects the subagent (these are real Pi subagents): default "delegate". Specialists include scout, researcher, planner, reviewer, worker, oracle, and context-builder; Claude-style aliases map to them. Every child receives a unique detached clone containing the pinned launch checkout's tracked state. Non-ignored untracked files are deliberately omitted and listed in run events to avoid copying secrets.

Eligibility and proportionality:
- Do not author a workflow merely because a task is substantive. Use one direct subagent outside workflow_run when only one specialist or focused second opinion is needed.
- A workflow should begin with at most two independently useful agents. A normal run should use no more than four agents total. Expand only after the first results expose distinct unresolved gaps; more than six agents requires an explicit user request.
- Launch one workflow, not a sequence of replacement workflows. A deterministic provider/model, repository, input, validation, budget, or resource failure must stop and fall back rather than trigger a whole-workflow retry.
- Prefer parent synthesis. Add a synthesis child only when independent arbitration is necessary or the reports exceed the parent's usable context. Pass concise references or artifacts instead of concatenating large reports into another prompt.

Orchestration patterns — pick the smallest one that qualifies:
- Pipeline by default when each item genuinely needs multiple independent stages. Each item flows without a global barrier.
- Barrier only when the next stage must see the complete set to deduplicate, compare, or early-exit.
- Adversarial verification only for security, migrations, infrastructure, destructive changes, public API compatibility, or similarly costly decisions. Routine analysis and implementation do not need a challenger panel.
- Adaptive fanout starts with two finders and expands only while novel yield justifies wall time and budget. The budget is a safety ceiling, not permission to keep looping.

Scale to the goal and evidence, not adjectives. Stop as soon as the smallest panel has answered the question reliably.

Hard constraints (the script is validated and REJECTED if violated):
- import nothing; only 'export const meta' may be exported.
- do not use require, process, fetch, eval, Function, constructor/prototype escapes, dynamic import(), Date.now(), Math.random(), or argless new Date(). The body runs in a killable networkless/filesystem-isolated subprocess, and lexical validation is defense in depth rather than the security boundary.
- a single parallel()/pipeline() call accepts at most 4096 items; concurrency is capped automatically.`;

// Keep the always-present tool contract compact. The model explicitly requests mode:'guide'
// before authoring, while generate mode receives the full guide in its dedicated model call.
const WORKFLOW_RUN_DESCRIPTION = `Launch a persisted background multi-agent workflow only after inline deliberation shows at least two independent workstreams, high-risk verification needs, or work too large for one context. Prefer direct execution or one direct subagent otherwise. Start with at most two agents; normal runs should stay within four, and never relaunch a whole failed workflow automatically. Modes: saved, script, generate, and guide. Use mode:'guide' before writing a script. Runs execute autonomously after validation in a killable, networkless, filesystem-isolated subprocess. Every child runs in a path-confined isolated Git clone. Project-provided saved workflows retain one-time immutable-snapshot approval. The tool returns immediately; workflow_status shows queued/running agents and transcript tails, and completion is queued back to the owner session.`;

const FLOW_GENERATOR_SYSTEM_PROMPT = `You generate workflow scripts for a deterministic multi-agent orchestrator that fans work out across many bounded-concurrency subagents. Return exactly ONE JavaScript module, no prose, no code fence.

${WORKFLOW_AUTHORING_GUIDE}`;

function extractGeneratedScript(text: string): string {
	const fence = text.match(/```(?:ts|typescript|js|javascript)?\s*([\s\S]*?)```/i);
	return (fence?.[1] ?? text).trim();
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
				const done = run.agents.filter((a) => a.status !== "running" && a.status !== "queued").length;
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
			const diffPath = findAgentDiffPath(run, agent.id);
			lines.push(line(`  ${agent.status === "succeeded" ? "✓" : agent.status === "running" ? "⏳" : agent.status === "queued" ? "○" : "✗"} ${agent.id} ${agent.label} (${agent.agent})${agent.cached ? " cached" : ""}${diffPath && fs.existsSync(diffPath) ? " diff" : ""}`));
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

const WorkflowStatusParams = Type.Object({
	runId: Type.Optional(Type.String({ description: "Run id (or id prefix) for detailed status of one run; omit for a fleet summary of in-flight and recent runs." })),
	agentLabel: Type.Optional(Type.String({ description: "With runId: show one agent by invocation id (preferred) or unique label." })),
	tailLines: Type.Optional(Type.Number({ description: "With runId + agentLabel: include the last N lines of the agent's live transcript (output-so-far; works while it is still running). Running agents include a 40-line tail by default." })),
});

const WorkflowRunParams = Type.Object({
	mode: StringEnum(["saved", "generate", "script", "guide"] as const, { description: "Run a saved workflow, generate one, run a provided script, or retrieve the authoring guide." }),
	name: Type.Optional(Type.String({ description: "Workflow name for saved mode" })),
	goal: Type.Optional(Type.String({ description: "Natural-language goal for generate mode" })),
	script: Type.Optional(Type.String({ description: "Workflow JavaScript source for script mode (plain JS, not TypeScript; see the tool description's authoring contract)" })),
	args: Type.Optional(Type.String({ description: "Raw workflow arguments" })),
	save: Type.Optional(Type.Boolean({ description: "Save generated/script workflow to the user workflow directory before running", default: false })),
	budget: Type.Optional(Type.Number({ description: "Optional output-token target for the whole run. Queued agents reserve capacity and launches fail when it is exhausted." })),
});

export default function (pi: ExtensionAPI) {
	lastPi = pi;

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		// Respect the host/user's active-tool policy. In particular, do not override an explicit
		// --tools allowlist by force-enabling workflow tools.
		const owner = currentSessionFile();
		const interrupted = listPersistedRuns(ctx.cwd).filter((run) =>
			(run.status === "running" || run.status === "pending") &&
			belongsToSession(run, owner),
		);
		for (const run of interrupted) activeRuns.set(run.id, run);
		for (const run of interrupted) {
			for (const agent of run.agents.filter((candidate) => candidate.status === "running" || candidate.status === "queued")) {
				agent.status = "cancelled";
				agent.endedAt = Date.now();
				agent.error = "The Pi host restarted; this child is no longer attached.";
				await persistRun(run, { type: "agent_end", agentId: agent.id, label: agent.label, status: agent.status, error: agent.error, reason: "session_start" });
			}
			await closeOpenPhase(run, "interrupted");
			transitionRunStatus(run, "interrupted");
			run.endedAt = Date.now();
			run.error = "The Pi host restarted before this workflow reached a terminal result; live children are not reattached.";
			await persistRun(run, { type: "run_interrupted", reason: "session_start", error: run.error });
			await safeSendWorkflowMessage(run, `# Workflow interrupted: ${run.name}\n\n${run.error}\n\nRun: ${run.id}\nDetails: ${run.runDir}`);
		}
		await replayPendingDeliveries(pi, ctx.cwd);
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
				await ctx.ui.custom((_tui, _theme, _keybindings, done) => new WorkflowsBrowser(runs, workflows, () => done(undefined)), { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%" } });
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
				const name = choice.slice("Run workflow: ".length).split(" ")[0] ?? "";
				await runNamedWorkflow(pi, name, "", ctx);
				return;
			}
			if (choice.startsWith("Inspect run: ")) {
				const id = choice.trim().split(/\s+/).pop() ?? "";
				const run = runs.find((r) => r.id === id);
				if (!run) return;
				const agentsWithDiffs = run.agents.filter((a) => {
					const diffPath = findAgentDiffPath(run, a.id);
					return Boolean(diffPath && fs.existsSync(diffPath));
				});
				const detailChoices = [
					"Show run details",
					...run.agents.map((a) => `Show agent: ${a.id}`),
					...agentsWithDiffs.map((a) => `Check patch: ${a.id}`),
					...agentsWithDiffs.map((a) => `Apply patch: ${a.id}`),
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
				else if (detail === "Stop run") abortControllers.get(run.id)?.abort(new WorkflowCancelledError());
				else if (detail === "Rerun fresh" || detail === "Rerun with cache reuse") {
					const prepared = await preparePersistedRunWorkflow(run);
					await startRun(pi, prepared, run.args, ctx, { reuseFrom: detail === "Rerun with cache reuse" ? run : undefined, budget: run.budgetTotal ?? undefined });
				}
				else if (detail === "Save script to user workflows") {
					await fs.promises.mkdir(USER_WORKFLOW_DIR, { recursive: true });
					for (const dependencyName of run.meta?.dependencies ?? []) {
						const safeDependency = safeName(dependencyName);
						const source = path.join(run.runDir, "dependencies", `${safeDependency}.js`);
						if (!fs.existsSync(source)) throw new Error(`Run is missing dependency snapshot: ${safeDependency}`);
						await fs.promises.copyFile(source, path.join(USER_WORKFLOW_DIR, `${safeDependency}.ts`));
					}
					const target = path.join(USER_WORKFLOW_DIR, `${safeName(run.name)}.ts`);
					await fs.promises.copyFile(runScriptSnapshotPath(run), target);
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
			if (!ctx.hasUI) { ctx.ui.notify("/flow requires interactive UI.", "warning"); return; }
			try {
				ctx.ui.notify("Generating workflow script...", "info");
				const script = await generateWorkflowScript(trimmedGoal, ctx);
				const errors = validateScript(script);
				if (errors.length > 0) {
					ctx.ui.notify(`Generated workflow failed validation:\n${errors.join("\n")}`, "error");
					return;
				}
				let finalScript = script;
				let meta = extractMeta(finalScript);
				let name = safeName(meta.name);
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
					meta = extractMeta(finalScript);
					name = safeName(meta.name);
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
				const prepared = await prepareWorkflow({ name, path: filePath, scope, hash: sha256(finalScript), description: meta.description }, ctx.cwd, 0, new Set(), finalScript);
				const run = await startRun(pi, prepared, "", ctx);
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
			const matches = [...abortControllers.keys()].filter((candidate) => candidate === id || candidate.startsWith(id));
			if (matches.length !== 1) { ctx.ui.notify(matches.length ? `Ambiguous workflow run prefix: ${id}` : `No active workflow run: ${id}`, "warning"); return; }
			const matchedId = matches[0]!;
			abortControllers.get(matchedId)?.abort(new WorkflowCancelledError());
			ctx.ui.notify(`Stopping workflow ${matchedId}`, "info");
		},
	});

	pi.registerCommand("workflow-save", {
		description: "Save a previous run's script: /workflow-save <run-id> [user|project]",
		handler: async (input, ctx) => {
			const [id, dest = "user"] = (input || "").trim().split(/\s+/);
			if (!id) { ctx.ui.notify("Usage: /workflow-save <run-id> [user|project]", "warning"); return; }
			const run = listPersistedRuns(ctx.cwd).find((r) => r.id === id || r.id.startsWith(id));
			if (!run) { ctx.ui.notify(`Run not found: ${id}`, "error"); return; }
			const source = runScriptSnapshotPath(run);
			if (!fs.existsSync(source)) { ctx.ui.notify(`Run has no script snapshot: ${run.id}`, "error"); return; }
			const dir = dest === "project" ? (projectWorkflowDir(ctx.cwd) ?? path.join(ctx.cwd, ".pi", "workflows")) : USER_WORKFLOW_DIR;
			await fs.promises.mkdir(dir, { recursive: true });
			for (const dependencyName of run.meta?.dependencies ?? []) {
				const safeDependency = safeName(dependencyName);
				const dependencySource = path.join(run.runDir, "dependencies", `${safeDependency}.js`);
				if (!fs.existsSync(dependencySource)) { ctx.ui.notify(`Run is missing dependency snapshot: ${safeDependency}`, "error"); return; }
				await fs.promises.copyFile(dependencySource, path.join(dir, `${safeDependency}.ts`));
			}
			const target = path.join(dir, `${safeName(run.name)}.ts`);
			await fs.promises.copyFile(source, target);
			ctx.ui.notify(`Saved immutable workflow${run.meta?.dependencies?.length ? " and dependency snapshots" : ""} to ${target}. Run /reload to refresh dynamic slash commands.`, "info");
		},
	});

	pi.registerCommand("workflow-rerun", {
		description: "Rerun the exact script and args from a previous run: /workflow-rerun <run-id> [fresh|reuse]",
		handler: async (input, ctx) => {
			const [runId, mode = "fresh"] = (input || "").trim().split(/\s+/);
			if (!runId) { ctx.ui.notify("Usage: /workflow-rerun <run-id> [fresh|reuse]", "warning"); return; }
			const prior = listPersistedRuns(ctx.cwd).find((r) => r.id === runId || r.id.startsWith(runId));
			if (!prior) { ctx.ui.notify(`Run not found: ${runId}`, "error"); return; }
			const scriptPath = runScriptSnapshotPath(prior);
			if (!fs.existsSync(scriptPath)) { ctx.ui.notify(`Run has no script snapshot: ${prior.id}`, "error"); return; }
			const prepared = await preparePersistedRunWorkflow(prior);
			const reuseFrom = mode === "reuse" ? prior : undefined;
			const next = await startRun(pi, prepared, prior.args, ctx, { reuseFrom, budget: prior.budgetTotal ?? undefined });
			ctx.ui.notify(`Rerunning workflow ${next.name} (${next.id})${reuseFrom ? " with cache reuse" : ""}.`, "info");
		},
	});

	pi.registerCommand("workflow-apply", {
		description: "Apply an isolated agent diff: /workflow-apply <run-id> <agent-id> [cwd] [--check]",
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
			"Launch a safe background multi-agent workflow, inspect status, or retrieve the authoring guide with mode:'guide'.",
		promptGuidelines: [
			"Use workflow_run only for breadth, confidence, or scale that changes the outcome; otherwise work inline.",
			"Before mode:'script', call workflow_run with mode:'guide'. First decide whether at least two independent workstreams or high-risk verification justify a workflow; otherwise work directly or use one direct subagent. Start with at most two agents and do not relaunch a whole failed workflow automatically.",
			"Workflow child failures propagate unless allowFailure:true is explicit; native schemas are validated, cache is opt-in, and every child uses a path-confined isolated Git clone.",
			"After launch, do not finalise while workflow_status reports active runs; completion is queued back to the owner session.",
		],
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<any> {
			if (params.mode === "guide") return { content: [{ type: "text", text: WORKFLOW_AUTHORING_GUIDE }], details: { mode: "guide" } };
			const launchMode = params.mode;
			let prepared: PreparedWorkflow;
			if (launchMode === "saved") {
				if (!params.name) throw new Error("Saved workflow mode requires name.");
				const requestedName = params.name;
				const workflow = discoverWorkflows(ctx.cwd).find((candidate) => candidate.name === safeName(requestedName));
				if (!workflow) throw new Error(`Workflow not found: ${params.name}`);
				prepared = await prepareWorkflow(workflow, ctx.cwd);
			} else {
				let source: string;
				if (launchMode === "generate") {
					if (!params.goal) throw new Error("Generate workflow mode requires goal.");
					source = await generateWorkflowScript(params.goal, ctx);
				} else {
					if (!params.script) throw new Error("Script workflow mode requires script.");
					source = params.script;
				}
				const errors = validateScript(source);
				if (errors.length) throw new Error(errors.join("\n"));
				const meta = extractMeta(source);
				const name = safeName(meta.name);
				const filePath = params.save ? path.join(USER_WORKFLOW_DIR, `${name}.ts`) : path.join("/virtual/pi-workflows", `${name}.js`);
				prepared = await prepareWorkflow({ name, path: filePath, scope: "user", hash: sha256(source), description: meta.description }, ctx.cwd, 0, new Set(), source);
				if (params.save) {
					await fs.promises.mkdir(USER_WORKFLOW_DIR, { recursive: true, mode: 0o700 });
					await atomicWriteFile(filePath, source);
				}
			}
			if (!(await ensureWorkflowApproved(prepared, ctx))) throw new Error("Workflow not approved.");
			const run = await startRun(pi, prepared, params.args ?? "", ctx, { budget: params.budget });
			const inFlightCount = listInFlightRuns().length;
			return {
				content: [{
					type: "text",
					text: `Started workflow ${run.name} (${run.id}) in the background. Details: ${run.runDir}\n\nYou will be WOKEN with the full report when it finishes; until then its results do NOT exist — do not guess at them. ${inFlightCount} workflow run(s) are now in flight. If you end your turn now, end with a brief acknowledgment that work is in progress; do NOT produce a final answer or complete report until every launched run has delivered its report (check with workflow_status).`,
				}],
				details: run,
			};
		},
	});

	pi.registerTool({
		name: "workflow_status",
		label: "Workflow Status",
		description:
			"Check the status of background workflow runs launched with workflow_run. With no arguments, returns a fleet summary: which runs are still in flight (their reports have NOT been delivered yet — do not finalise your answer while any are) and which have finished. Pass runId (or an id prefix) for one run's phases/agents/report; add agentLabel for a single agent's task and output, and tailLines to tail its live session transcript — this shows a RUNNING agent's output-so-far (assistant text + tool calls), like peeking at a background shell. Use it to confirm nothing is pending before presenting a final answer; do not poll it in a tight loop — each run wakes you automatically when it completes.",
		parameters: WorkflowStatusParams,
		promptSnippet:
			"Check background workflow runs: which are still in flight (never finalise an answer while any are) and which have finished, or inspect one run/agent in detail.",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<any> {
			const id = params.runId?.trim();
			if (id) {
				const run =
					Array.from(activeRuns.values()).find((r) => r.id === id || r.id.startsWith(id)) ??
					listPersistedRuns(ctx.cwd).find((r) => r.id === id || r.id.startsWith(id));
				if (!run) throw new Error(`Run not found: ${id}`);
				return { content: [{ type: "text", text: workflowRunDetails(run, params.agentLabel?.trim() || undefined, params.tailLines) }], details: { runId: run.id, status: run.status } };
			}
			return { content: [{ type: "text", text: workflowFleetStatus(ctx.cwd) }], details: { executing: listInFlightRuns().map((run) => run.id) } };
		},
	});
}
