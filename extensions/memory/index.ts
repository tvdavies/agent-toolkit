/**
 * Memory extension — hook-based recall over the @jeffs-brain/memory engine.
 *
 * On `before_agent_start` it recalls relevant memories for the incoming prompt and
 * injects them into the system prompt as a marked block — automatic, tool-free
 * recall (the reliability win: it never depends on the agent calling a tool).
 *
 * Flag-gated for a safe cutover: inert unless AGENT_TOOLKIT_MEMORY_ENGINE=jeffs, so
 * the existing OKF brain remains the default until this engine is proven. When you
 * switch the flag on, set AGENT_TOOLKIT_BRAIN_RECALL=off so only one recall injects.
 *
 * Env:
 *   AGENT_TOOLKIT_MEMORY_ENGINE=jeffs   activate this engine (else inert)
 *   AGENT_TOOLKIT_MEMORY_MODEL          extraction model (default nuextract-v1.5)
 *   AGENT_TOOLKIT_MEMORY_BASE_URL       LM Studio endpoint (default http://localhost:1234)
 *   AGENT_TOOLKIT_MEMORY_RECALL_LIMIT   max memories injected (default 6)
 *   AGENT_TOOLKIT_MEMORY_RECALL_MS      recall time budget per turn (default 800)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { BrainEngine } from "./engine.ts"; // type-only — runtime load is deferred

const MARKER = "<!-- memory-addendum -->";
const ADDENDUM = `

${MARKER}
## Persistent memory
- Relevant memories are injected automatically as a <memory> block before each turn — treat them as potentially stale and verify load-bearing details.
- Call memory_query to look something up when the injected block is insufficient.`;

function recallLimit(): number {
	const n = Number(process.env.AGENT_TOOLKIT_MEMORY_RECALL_LIMIT ?? 6);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 6;
}
function recallBudgetMs(): number {
	const n = Number(process.env.AGENT_TOOLKIT_MEMORY_RECALL_MS ?? 800);
	return Number.isFinite(n) && n > 0 ? n : 800;
}

/** Race a promise against a timeout; resolve to `fallback` if it overruns. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

export default function memoryExtension(pi: ExtensionAPI): void {
	// Inert unless explicitly enabled — the OKF brain stays the default during cutover.
	if (process.env.AGENT_TOOLKIT_MEMORY_ENGINE !== "jeffs") return;

	let enginePromise: Promise<BrainEngine | undefined> | undefined;
	const getEngine = (): Promise<BrainEngine | undefined> => {
		if (!enginePromise) {
			// Deferred runtime import: @jeffs-brain/memory only loads when the engine is
			// actually used, so the inert (flag-off) path has zero footprint.
			enginePromise = import("./engine.ts")
				.then((m) => m.createBrainEngine())
				.catch((e) => {
					console.error(`[memory] engine init failed: ${(e as Error).message}`);
					return undefined;
				});
		}
		return enginePromise;
	};

	pi.on("before_agent_start", async (event) => {
		const systemPrompt = event.systemPrompt.includes(MARKER) ? event.systemPrompt : `${event.systemPrompt}${ADDENDUM}`;
		try {
			const engine = await getEngine();
			if (!engine || !event.prompt?.trim()) return { systemPrompt };
			// Bounded + best-effort: a slow/empty recall must never delay the turn.
			const { block } = await withTimeout(engine.recall(event.prompt, recallLimit()), recallBudgetMs(), { block: "", count: 0 });
			return { systemPrompt: block ? `${systemPrompt}\n\n${block}` : systemPrompt };
		} catch {
			return { systemPrompt };
		}
	});

	const querySchema = Type.Object({
		query: Type.String({ description: "What to look up in persistent memory." }),
		limit: Type.Optional(Type.Number({ description: "Max memories to return (default 6)." })),
	});
	type QueryInput = Static<typeof querySchema>;

	pi.registerTool({
		name: "memory_query",
		label: "memory query",
		description: "Search the agent's persistent memory (codebase facts, decisions, your preferences, project context) for relevant notes. Recall already runs automatically each turn; use this for a targeted lookup.",
		parameters: querySchema,
		async execute(_id, params: QueryInput) {
			const engine = await getEngine();
			if (!engine) {
				return { content: [{ type: "text" as const, text: "Memory engine is unavailable." }], details: { ok: false, count: 0 } };
			}
			const { block, count } = await engine.recall(params.query, params.limit && params.limit > 0 ? Math.floor(params.limit) : 6);
			return {
				content: [{ type: "text" as const, text: count ? block : "No relevant memories found." }],
				details: { ok: true, count },
			};
		},
	});
}
