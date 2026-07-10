/**
 * Observe extension — the in-terminal oversight surface (`/status`).
 *
 * Reads state the rest of the toolkit already persists (scheduler session
 * entries, workflow-run manifests, the brain, TADU, and the decision
 * spine) and renders a single pane answering "what is it doing right now?".
 * Pure rendering lives in ./status; this module only gathers and wires.
 *
 * It writes nothing — it is a read-only reader over the decision spine and
 * existing state, which is exactly how oversight should scale with autonomy.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readRecent, stateDir } from "../lib/decisions";
import { BrainStore } from "../brain/store";
import { brainRoot, workflowRunRoots } from "../lib/paths";
import { formatStatus, type StatusModel } from "./status";

const SCHED_JOB = "scheduler-job";
const SCHED_CANCEL = "scheduler-cancel";

type SessionEntryLike = { type?: string; customType?: string; data?: unknown };

export default function observeExtension(pi: ExtensionAPI): void {
	pi.registerCommand("status", {
		description: "Show a single pane of agent-toolkit status (loops, schedule, brain, decisions).",
		handler: async (_args, ctx) => {
			const model = gather(ctx);
			ctx.ui.notify(formatStatus(model, Date.now()), "info");
		},
	});
}

function gather(ctx: ExtensionContext): StatusModel {
	return {
		daemon: gatherDaemon(),
		scheduler: gatherScheduler(ctx),
		workflows: gatherWorkflows(ctx.cwd),
		brain: gatherBrain(),
		tadu: gatherTadu(ctx.cwd),
		decisions: readRecent(5),
	};
}

function gatherDaemon(): StatusModel["daemon"] {
	const path = join(stateDir(), "daemon-status.json");
	if (!existsSync(path)) return { running: false };
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as {
			startedAt?: string;
			restarts?: number;
			lastTrigger?: string;
		};
		const uptime = data.startedAt ? humanDuration(Date.now() - Date.parse(data.startedAt)) : undefined;
		return { running: true, uptime, restarts: data.restarts, lastTrigger: data.lastTrigger };
	} catch {
		return { running: false };
	}
}

function gatherScheduler(ctx: ExtensionContext): StatusModel["scheduler"] {
	const jobs = new Map<string, { preview: string }>();
	for (const entry of customEntries(ctx)) {
		const data = entry.data as Record<string, unknown> | undefined;
		if (entry.customType === SCHED_JOB && data?.id) {
			const spec = data.spec ? `${data.spec}: ` : "";
			jobs.set(String(data.id), { preview: `${spec}${String(data.prompt ?? "")}` });
		} else if (entry.customType === SCHED_CANCEL && data?.id) {
			jobs.delete(String(data.id));
		}
	}
	return { pending: jobs.size, jobs: [...jobs.values()] };
}

function gatherWorkflows(cwd: string): StatusModel["workflows"] {
	const runs: { id: string; name?: string; status: string; mtime: number }[] = [];
	for (const base of workflowRunRoots(cwd)) {
		for (const runDir of findRunDirs(base, 2)) {
			const state = readJson(join(runDir, "state.json")) ?? readJson(join(runDir, "manifest.json"));
			if (!state) continue;
			runs.push({
				id: String(state.id ?? state.runId ?? runDir.split("/").pop() ?? "?"),
				name: state.name ? String(state.name) : undefined,
				status: String(state.status ?? "unknown"),
				mtime: safeMtime(runDir),
			});
		}
	}
	return runs.sort((a, b) => b.mtime - a.mtime).slice(0, 8).map(({ mtime: _m, ...rest }) => rest);
}

function gatherBrain(): StatusModel["brain"] {
	try {
		const store = new BrainStore(brainRoot());
		const initialised = store.isInitialised();
		return { initialised, concepts: initialised ? store.listConceptFiles().length : 0 };
	} catch {
		return { initialised: false, concepts: 0 };
	}
}

function gatherTadu(cwd: string): StatusModel["tadu"] {
	if (!findUp(cwd, ".tadu")) return undefined;
	const current = taduRun(["current"]);
	const list = taduRun(["list"]);
	return {
		current: current && !/no task|not attached/i.test(current) ? firstToken(current) : undefined,
		open: list ? list.split("\n").filter((l) => l.trim() !== "").length : undefined,
	};
}

// --- helpers -----------------------------------------------------------------

function customEntries(ctx: ExtensionContext): SessionEntryLike[] {
	try {
		return (ctx.sessionManager.getEntries() as SessionEntryLike[]).filter(
			(e) => e.type === "custom",
		);
	} catch {
		return [];
	}
}

function findRunDirs(base: string, depth: number): string[] {
	if (!existsSync(base)) return [];
	const out: string[] = [];
	const visit = (dir: string, left: number): void => {
		if (existsSync(join(dir, "state.json")) || existsSync(join(dir, "manifest.json"))) {
			out.push(dir);
			return;
		}
		if (left <= 0) return;
		for (const entry of safeReaddir(dir)) {
			const abs = join(dir, entry);
			if (safeIsDir(abs)) visit(abs, left - 1);
		}
	};
	visit(base, depth);
	return out;
}

function readJson(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function safeIsDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function safeMtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

function findUp(start: string, marker: string): boolean {
	let dir = start;
	for (let i = 0; i < 30; i += 1) {
		if (existsSync(join(dir, marker))) return true;
		const parent = join(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return false;
}

function taduRun(args: string[]): string | undefined {
	try {
		const result = spawnSync("tadu", args, { encoding: "utf8", timeout: 3000 });
		return result.status === 0 ? result.stdout.trim() : undefined;
	} catch {
		return undefined;
	}
}

function firstToken(text: string): string {
	return text.split(/\s+/)[0] ?? text;
}

function humanDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}
