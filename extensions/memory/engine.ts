/**
 * Brain engine — adopts @jeffs-brain/memory as the memory store for the autonomous
 * agent (replacing the OKF brain, behind a flag during cutover).
 *
 * Wiring (all spike-validated under node):
 *  - FsStore at the memory root (GitStore wants more than {root}; we version with
 *    our own best-effort git commit, like the OKF brain).
 *  - the hardened LM Studio provider (./provider) for extraction.
 *  - our BM25 search adapter (./search-adapter) for recall — the library's recall
 *    needs an injected SearchIndex and its built-ins don't fit node.
 *  - redaction (./redact) on every slice fed to extract().
 *
 * The engine exposes the two operations the toolkit needs: `recall(query)` →
 * an injectable context block (for the before_agent_start hook), and
 * `extract(messages)` → durable memories (for the live afterTurn + the dreamer).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFsStore, createMemory, createStoreBackedCursorStore, type Scope } from "@jeffs-brain/memory";
import { redactMessages, type RoleMessage } from "./redact.ts";
import { createBm25SearchIndex } from "./search-adapter.ts";
import { lmStudioProvider, withExtractionConform } from "./provider.ts";

const ALL_SCOPES: Scope[] = ["agent", "project", "global"];

export function memoryRoot(): string {
	return process.env.AGENT_TOOLKIT_MEMORY_ROOT ?? join(homedir(), ".local", "share", "agent-toolkit", "memory");
}

export type BrainEngineOptions = {
	root?: string;
	actorId?: string;
	/** Primary scope for writes/recall (default "agent"). */
	scope?: Scope;
	model?: string;
	baseURL?: string;
	/** Override the provider (tests inject a fake). */
	provider?: unknown;
	/** Commit the brain to git after writes (default true; off in tests). */
	git?: boolean;
};

export type BrainEngine = {
	memory: ReturnType<typeof createMemory>;
	root: string;
	scope: Scope;
	/** Recall relevant memories and format them for prompt injection. */
	recall(query: string, topK?: number): Promise<{ block: string; count: number }>;
	/** Distil durable memories from messages (redacted first), then commit. */
	extract(messages: readonly RoleMessage[], opts: { sessionId: string; scope?: Scope }): Promise<unknown[]>;
};

export async function createBrainEngine(opts: BrainEngineOptions = {}): Promise<BrainEngine> {
	const root = opts.root ?? memoryRoot();
	const actorId = opts.actorId ?? process.env.AGENT_TOOLKIT_MEMORY_ACTOR ?? "tom";
	const scope: Scope = opts.scope ?? "agent";
	const useGit = opts.git ?? true;
	mkdirSync(root, { recursive: true });
	if (useGit) ensureGitRepo(root);

	const store = await createFsStore({ root });
	const cursorStore = createStoreBackedCursorStore(store);
	// Guarantee extraction outputs carry filenames (the library skips filename-less
	// memories), so fast models that omit them still persist.
	const provider = withExtractionConform(opts.provider ?? lmStudioProvider({ model: opts.model, baseURL: opts.baseURL })) as never;
	// Our SearchHit uses a plain string path; the library brands Path. Structurally
	// identical, so cast across the boundary.
	const searchIndex = createBm25SearchIndex(store) as never;
	const memory = createMemory({ store, provider, cursorStore, searchIndex, scope, actorId, extractMinMessages: 4 });

	const fallbackScopes = ALL_SCOPES.filter((s) => s !== scope);

	return {
		memory,
		root,
		scope,
		async recall(query, topK = 6) {
			const ctx = await memory.contextualise({ message: query, topK, scope, fallbackScopes });
			return { block: ctx.systemReminder?.trim() ?? "", count: ctx.memories.length };
		},
		async extract(messages, extractOpts) {
			// Redaction is OURS — the library does not scrub secrets, and ingest scope
			// is "all sessions", so transcripts can carry credentials.
			const safe = redactMessages(messages);
			// RoleMessage.role is a plain string; the library narrows to a role union —
			// cast across the boundary (the content is what extraction reads).
			const res = (await memory.extract({ messages: safe as never, sessionId: extractOpts.sessionId, scope: extractOpts.scope ?? scope })) as unknown[];
			if (useGit && res.length > 0) commitBrain(root, `memory: extract ${extractOpts.sessionId} (+${res.length})`);
			return res;
		},
	};
}

// --- git versioning (best-effort; failures never break the engine) ------------
const git = (root: string, args: string[]) =>
	spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

function ensureGitRepo(root: string): void {
	try {
		if (existsSync(join(root, ".git"))) return;
		if (git(root, ["rev-parse", "--is-inside-work-tree"]).status === 0) return;
		git(root, ["init", "-q"]);
		git(root, ["-c", "user.name=agent-toolkit[bot]", "-c", "user.email=agent-toolkit@localhost", "commit", "--allow-empty", "-q", "-m", "memory: init"]);
	} catch {
		// versioning is best-effort
	}
}

function commitBrain(root: string, message: string): void {
	try {
		if (git(root, ["add", "-A"]).status !== 0) return;
		// Nothing staged → skip (avoids a noisy empty commit).
		if (git(root, ["diff", "--cached", "--quiet"]).status === 0) return;
		git(root, ["-c", "user.name=agent-toolkit[bot]", "-c", "user.email=agent-toolkit@localhost", "commit", "-q", "-m", message]);
	} catch {
		// best-effort
	}
}
