/**
 * BrainStore — filesystem + ripgrep + git operations over an OKF bundle.
 *
 * The bundle is a git-tracked directory of OKF concept documents (see ./okf).
 * Reads/writes are plain files; recall is ripgrep over the markdown; durability
 * is git commits. There is no database and no running service: the files are the
 * source of truth, hand-editable and crash-recoverable by construction.
 *
 * No Pi imports — bound only to a root directory — so it is exercised against a
 * real tmpdir in store.test.ts.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	conceptIdFromPath,
	isConceptFile,
	type OkfDoc,
	type OkfFrontmatter,
	parseOkf,
	pathFromConceptId,
	slugify,
	stringifyOkf,
} from "./okf";
import { type RecallHit, rankHits } from "./recall";

/** Input for minting or updating a concept document. */
export type ConceptInput = {
	type: string;
	title?: string;
	description?: string;
	body?: string;
	tags?: string[];
	resource?: string;
	/** Topic subdirectory; inferred from `type` when omitted. */
	topic?: string;
	/** Explicit concept id; when given, overwrites that concept (an update). */
	id?: string;
	/** Producer-defined extension frontmatter. */
	extra?: Record<string, unknown>;
};

export type BrainStoreOptions = {
	/** Authorship identity recorded in git commits. */
	actor?: string;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
};

/** Default topic directories scaffolded by {@link BrainStore.init}. */
export const TOPIC_DIRS = [
	"people",
	"projects",
	"decisions",
	"ops",
	"references",
	"notes",
] as const;

const TYPE_TO_TOPIC: Record<string, string> = {
	Person: "people",
	Project: "projects",
	Decision: "decisions",
	Playbook: "ops",
	Runbook: "ops",
	Ops: "ops",
	Reference: "references",
};

/** Recall scoring favours durable, high-signal concept types. */
const DEFAULT_TYPE_WEIGHTS: Record<string, number> = {
	Decision: 2,
	Person: 1,
	Project: 1,
	Playbook: 1,
};

const STOPWORDS = new Set([
	"the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are",
	"was", "were", "be", "do", "did", "what", "which", "who", "how", "my", "me",
	"i", "it", "that", "this", "with", "about",
]);

export class BrainStore {
	readonly root: string;
	private readonly actor: string;
	private readonly now: () => Date;

	constructor(root: string, options: BrainStoreOptions = {}) {
		this.root = root;
		this.actor = options.actor ?? "agent-toolkit";
		this.now = options.now ?? (() => new Date());
	}

	/** True once the bundle has been scaffolded. */
	isInitialised(): boolean {
		return existsSync(join(this.root, "schema-version.yaml"));
	}

	/** Scaffold the OKF bundle: topic dirs, indexes, schema marker, git repo. */
	init(): void {
		mkdirSync(this.root, { recursive: true });
		this.writeIfAbsent("schema-version.yaml", "okf: 0.1\n");
		this.writeIfAbsent("README.md", README);
		this.writeIfAbsent(
			"index.md",
			`# Brain\n\nOKF knowledge bundle for the agent toolkit.\n\n${TOPIC_DIRS.map(
				(d) => `- [[${d}]] — ${d}`,
			).join("\n")}\n`,
		);
		this.writeIfAbsent("log.md", "# Log\n\nChronological history of brain updates.\n");
		for (const dir of TOPIC_DIRS) {
			mkdirSync(join(this.root, dir), { recursive: true });
			this.writeIfAbsent(join(dir, "index.md"), `# ${dir}\n`);
		}
		if (!existsSync(join(this.root, ".git")) && this.gitAvailable()) {
			this.git(["init", "--quiet"]);
			this.git(["add", "-A"]);
			this.commitSync("brain: initialise OKF bundle");
		}
	}

	/** Concept-file relative paths (excludes reserved index.md/log.md). */
	listConceptFiles(): string[] {
		const out: string[] = [];
		const walk = (dir: string, prefix: string): void => {
			const entries = readdirSafe(dir);
			for (const entry of entries) {
				if (entry === ".git" || entry === ".index") continue;
				const abs = join(dir, entry);
				const rel = prefix ? `${prefix}/${entry}` : entry;
				if (statSync(abs).isDirectory()) walk(abs, rel);
				else if (isConceptFile(rel)) out.push(rel);
			}
		};
		walk(this.root, "");
		return out.sort();
	}

	readConcept(id: string): OkfDoc | undefined {
		const abs = join(this.root, pathFromConceptId(id));
		if (!existsSync(abs)) return undefined;
		return parseOkf(readFileSync(abs, "utf8"));
	}

	/** Mint or update a concept document. Returns its id and whether it was new. */
	writeConcept(input: ConceptInput): { id: string; path: string; created: boolean } {
		const relPath = input.id
			? pathFromConceptId(input.id)
			: this.allocatePath(input);
		const abs = join(this.root, relPath);
		const created = !existsSync(abs);
		const frontmatter: OkfFrontmatter = {
			type: input.type,
			title: input.title,
			description: input.description,
			resource: input.resource,
			tags: input.tags,
			timestamp: this.now().toISOString(),
			...input.extra,
		};
		const doc: OkfDoc = { frontmatter, body: input.body ?? "" };
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, stringifyOkf(doc), "utf8");
		return { id: conceptIdFromPath(relPath), path: relPath, created };
	}

	/** Append a one-line dated entry to log.md (the chronological history). */
	appendLog(summary: string): void {
		const abs = join(this.root, "log.md");
		const line = `- ${this.now().toISOString()} — ${summary.replace(/\s+/g, " ").trim()}\n`;
		const existing = existsSync(abs) ? readFileSync(abs, "utf8") : "# Log\n\n";
		writeFileSync(abs, existing.endsWith("\n") ? existing + line : `${existing}\n${line}`, "utf8");
	}

	/** Remove a concept, recording the removal in the log. Returns whether it existed. */
	forget(id: string): boolean {
		const abs = join(this.root, pathFromConceptId(id));
		if (!existsSync(abs)) return false;
		rmSync(abs);
		this.appendLog(`forgot ${id}`);
		return true;
	}

	/** Ripgrep recall: tokenised OR-search over the bundle, ranked. */
	search(query: string, limit = 6): RecallHit[] {
		const terms = tokenise(query);
		if (terms.length === 0) return [];
		const raw = this.ripgrep(terms);
		return rankHits(raw, {
			limit,
			typeWeights: DEFAULT_TYPE_WEIGHTS,
			now: this.now().getTime(),
		});
	}

	/** Stage all changes and commit if anything changed. Best-effort push after. */
	async commit(message: string): Promise<{ committed: boolean }> {
		if (!this.gitAvailable() || !existsSync(join(this.root, ".git"))) {
			return { committed: false };
		}
		await this.gitAsync(["add", "-A"]);
		const status = await this.gitAsync(["status", "--porcelain"]);
		if (status.stdout.trim() === "") return { committed: false };
		await this.gitAsync(this.commitArgs(message));
		void this.maybePush();
		return { committed: true };
	}

	// --- internals -------------------------------------------------------------

	private allocatePath(input: ConceptInput): string {
		const topic =
			input.topic ?? TYPE_TO_TOPIC[input.type] ?? "notes";
		const stem = slugify(
			input.title ?? firstLine(input.body) ?? input.description ?? input.type,
		);
		let candidate = `${topic}/${stem}.md`;
		let n = 2;
		while (existsSync(join(this.root, candidate))) {
			candidate = `${topic}/${stem}-${n}.md`;
			n += 1;
		}
		return candidate;
	}

	private ripgrep(terms: string[]): RecallHit[] {
		const args = ["--json", "-i", "-g", "*.md", "-g", "!.git"];
		for (const term of terms) args.push("-e", term);
		args.push(this.root);
		const result = spawnSync("rg", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
		// rg exits 1 when there are no matches; only >1 is a real error.
		if (result.status !== 0 && result.status !== 1) return [];
		const byPath = new Map<string, { count: number; snippet?: string }>();
		for (const line of (result.stdout ?? "").split("\n")) {
			if (line === "") continue;
			let event: RgEvent;
			try {
				event = JSON.parse(line) as RgEvent;
			} catch {
				continue;
			}
			if (event.type !== "match") continue;
			const absPath = event.data.path.text;
			const rel = relativise(this.root, absPath);
			if (!isConceptFile(rel)) continue;
			const entry = byPath.get(rel) ?? { count: 0 };
			entry.count += event.data.submatches?.length || 1;
			if (!entry.snippet) entry.snippet = event.data.lines.text.trim();
			byPath.set(rel, entry);
		}
		const hits: RecallHit[] = [];
		for (const [rel, info] of byPath) {
			const doc = parseOkf(readFileSync(join(this.root, rel), "utf8"));
			const fm = doc.frontmatter;
			hits.push({
				conceptId: conceptIdFromPath(rel),
				type: fm.type,
				title: fm.title,
				description: fm.description,
				tags: fm.tags,
				timestamp: fm.timestamp ?? mtimeIso(join(this.root, rel)),
				matchCount: info.count,
				snippet: info.snippet,
			});
		}
		return hits;
	}

	private gitAvailable(): boolean {
		return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
	}

	private git(args: string[]): void {
		spawnSync("git", args, { cwd: this.root, encoding: "utf8" });
	}

	private commitArgs(message: string): string[] {
		return [
			"-c",
			`user.name=${this.actor}`,
			"-c",
			`user.email=${this.actor}@agent-toolkit.local`,
			"commit",
			"--no-gpg-sign",
			"-q",
			"-m",
			message,
		];
	}

	private commitSync(message: string): void {
		spawnSync("git", this.commitArgs(message), { cwd: this.root, encoding: "utf8" });
	}

	private gitAsync(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		return new Promise((resolve) => {
			const child = spawn("git", args, { cwd: this.root });
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (c) => (stdout += c));
			child.stderr?.on("data", (c) => (stderr += c));
			child.on("error", () => resolve({ code: 1, stdout, stderr }));
			child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
		});
	}

	private async maybePush(): Promise<void> {
		const remotes = await this.gitAsync(["remote"]);
		if (!remotes.stdout.split(/\s+/).includes("origin")) return;
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const push = await this.gitAsync(["push", "origin", "HEAD"]);
			if (push.code === 0) return;
			await sleep(500 * attempt);
		}
	}

	private writeIfAbsent(relPath: string, content: string): void {
		const abs = join(this.root, relPath);
		if (existsSync(abs)) return;
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content, "utf8");
	}
}

type RgEvent = {
	type: string;
	data: {
		path: { text: string };
		lines: { text: string };
		submatches?: unknown[];
	};
};

function readdirSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function relativise(root: string, abs: string): string {
	const normalisedRoot = root.endsWith("/") ? root : `${root}/`;
	return abs.startsWith(normalisedRoot) ? abs.slice(normalisedRoot.length) : abs;
}

function mtimeIso(abs: string): string | undefined {
	try {
		return statSync(abs).mtime.toISOString();
	} catch {
		return undefined;
	}
}

function firstLine(body: string | undefined): string | undefined {
	if (!body) return undefined;
	const line = body.split("\n").find((l) => l.trim() !== "");
	return line?.replace(/^#+\s*/, "").trim();
}

export function tokenise(query: string): string[] {
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const raw of query.toLowerCase().split(/[^a-z0-9]+/)) {
		if (raw.length < 2 || STOPWORDS.has(raw) || seen.has(raw)) continue;
		seen.add(raw);
		terms.push(raw);
		if (terms.length >= 8) break;
	}
	return terms;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const README = `# Brain

This directory is an **Open Knowledge Format (OKF)** knowledge bundle: plain
markdown files with YAML frontmatter, organised into topic directories. It is the
agent toolkit's durable memory.

- Every concept is one markdown file; its id is the path without \`.md\`.
- Frontmatter requires \`type\`; \`title\`, \`description\`, \`tags\`, \`timestamp\`
  are recommended. Extra keys are allowed.
- \`index.md\` per directory aids progressive disclosure; \`log.md\` is history.
- Link concepts with normal markdown links to express relationships.

The files are the source of truth. Edit them by hand, grep them, and review
changes in git — the brain is yours to read and correct.
`;
