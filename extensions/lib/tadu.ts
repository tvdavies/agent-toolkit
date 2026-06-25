/**
 * TADU adapter — the toolkit's view of the durable work store.
 *
 * TADU stores tasks as plain files (`.tadu/tasks/<id>/task.md` with YAML
 * frontmatter, `comments/`, `events.jsonl`, `config.yaml` declaring the status
 * lanes). We read that on-disk format directly (no subprocess) so the board and
 * task detail are pure + testable; `ensureWorkspace` shells `tadu init` once.
 *
 * The workspace is central (one board for the agent's work), at
 * AGENT_TOOLKIT_TADU_ROOT or ~/.local/state/agent-toolkit/work.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type TaduTask = {
	id: string;
	title: string;
	status: string;
	labels: string[];
	project?: string;
	assignee?: string;
	createdAt?: string;
	updatedAt?: string;
	description?: string;
};

export type TaduConfig = { statuses: string[]; terminal: string[] };
export type TaduComment = { file: string; ts?: string; text: string; actor?: string };
export type TaduEvent = { seq: number; time: string; type: string; task?: string; actor?: string; data?: unknown };

export function taduRoot(): string {
	return (
		process.env.AGENT_TOOLKIT_TADU_ROOT ??
		join(homedir(), ".local", "state", "agent-toolkit", "work")
	);
}
function taduDir(): string {
	return join(taduRoot(), ".tadu");
}

export function workspaceExists(): boolean {
	return existsSync(taduDir());
}

/** Create the workspace if absent (best-effort `tadu init`). */
export function ensureWorkspace(): boolean {
	if (workspaceExists()) return true;
	try {
		mkdirSync(taduRoot(), { recursive: true });
		const result = spawnSync("tadu", ["init"], { cwd: taduRoot(), encoding: "utf8", timeout: 5000 });
		return result.status === 0 && workspaceExists();
	} catch {
		return false;
	}
}

const DEFAULT_CONFIG: TaduConfig = {
	statuses: ["backlog", "ready", "in-progress", "blocked", "in-review", "done"],
	terminal: ["done"],
};

export function readConfig(): TaduConfig {
	const path = join(taduDir(), "config.yaml");
	if (!existsSync(path)) return DEFAULT_CONFIG;
	try {
		const data = parseYaml(readFileSync(path, "utf8")) as Partial<TaduConfig> | null;
		return {
			statuses: Array.isArray(data?.statuses) && data.statuses.length ? data.statuses : DEFAULT_CONFIG.statuses,
			terminal: Array.isArray(data?.terminal) ? data.terminal : DEFAULT_CONFIG.terminal,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

/** Split YAML frontmatter from the markdown body. */
function parseFrontmatter(text: string): { fm: Record<string, unknown>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!match) return { fm: {}, body: text };
	let fm: Record<string, unknown> = {};
	try {
		const parsed = parseYaml(match[1] ?? "");
		if (parsed && typeof parsed === "object") fm = parsed as Record<string, unknown>;
	} catch {
		// tolerate malformed frontmatter
	}
	return { fm, body: text.slice(match[0].length) };
}

function taskFromFile(path: string): TaduTask | undefined {
	if (!existsSync(path)) return undefined;
	const { fm, body } = parseFrontmatter(readFileSync(path, "utf8"));
	if (!fm.id) return undefined;
	return {
		id: String(fm.id),
		title: String(fm.title ?? ""),
		status: String(fm.status ?? "backlog"),
		labels: Array.isArray(fm.labels) ? fm.labels.map(String) : [],
		project: fm.project ? String(fm.project) : undefined,
		assignee: fm.assignee ? String(fm.assignee) : undefined,
		createdAt: fm.created_at ? String(fm.created_at) : undefined,
		updatedAt: fm.updated_at ? String(fm.updated_at) : undefined,
		description: body.trim() || undefined,
	};
}

/** All tasks, most-recently-updated first. */
export function listTasks(): TaduTask[] {
	const tasksDir = join(taduDir(), "tasks");
	if (!existsSync(tasksDir)) return [];
	const out: TaduTask[] = [];
	for (const entry of safeReaddir(tasksDir)) {
		const task = taskFromFile(join(tasksDir, entry, "task.md"));
		if (task) out.push(task);
	}
	return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export function getTask(id: string): (TaduTask & { comments: TaduComment[] }) | undefined {
	const dir = findTaskDir(id);
	if (!dir) return undefined;
	const task = taskFromFile(join(dir, "task.md"));
	if (!task) return undefined;
	return { ...task, comments: readComments(dir) };
}

function findTaskDir(id: string): string | undefined {
	const tasksDir = join(taduDir(), "tasks");
	if (!existsSync(tasksDir)) return undefined;
	for (const entry of safeReaddir(tasksDir)) {
		if (entry === id || entry.startsWith(`${id}-`)) return join(tasksDir, entry);
	}
	return undefined;
}

function readComments(taskDir: string): TaduComment[] {
	const dir = join(taskDir, "comments");
	if (!existsSync(dir)) return [];
	return safeReaddir(dir)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.map((file) => {
			const { fm, body } = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
			return {
				file,
				ts: fm.created_at ? String(fm.created_at) : undefined,
				// `author` carries TADU_ACTOR (agent:toolkit vs the git user) — the control
				// loop uses it to tell the human's comment from the agent's own.
				actor: fm.author ? String(fm.author) : undefined,
				text: body.trim() || readFileSync(join(dir, file), "utf8").trim(),
			};
		});
}

/** Recent events (newest last), bounded. */
export function readEvents(limit = 50): TaduEvent[] {
	const path = join(taduDir(), "events.jsonl");
	if (!existsSync(path)) return [];
	const out: TaduEvent[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		try {
			out.push(JSON.parse(line) as TaduEvent);
		} catch {
			// skip
		}
	}
	return out.slice(-limit);
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir).filter((e) => e !== ".lock" && !e.startsWith("."));
	} catch {
		return [];
	}
}

/** Whether a path is a directory (helper for callers). */
export function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
