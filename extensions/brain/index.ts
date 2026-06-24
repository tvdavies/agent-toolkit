/**
 * Brain extension — durable memory as an OKF knowledge bundle.
 *
 * Resurrects the contract of the disabled `brain.ts` (recall-on-turn + a
 * remember tool) but with an in-process backend: markdown + ripgrep + git over
 * an Open Knowledge Format bundle (see ./store, ./okf, ./recall). No external
 * `brain` CLI, no subprocess-latency or SQLite-lock issues.
 *
 * - Recall: on `before_agent_start`, ripgrep the bundle for the prompt and inject
 *   a compact, clearly-fenced context block (bounded, best-effort, never throws).
 * - Capture: explicit `brain_remember`/`brain_forget` tools write OKF docs; a
 *   single git commit is flushed asynchronously on `agent_end` so it never blocks
 *   the turn. (Automatic fact extraction is deferred to a later /brain-consolidate
 *   job rather than a hidden per-turn LLM call.)
 *
 * Config (environment):
 *   AGENT_TOOLKIT_BRAIN_ROOT   bundle path (default ~/.local/share/agent-toolkit/brain)
 *   AGENT_TOOLKIT_BRAIN_RECALL "on" | "off" (default "on")
 *   AGENT_TOOLKIT_BRAIN_LIMIT  max recalled memories (default 6)
 *   TADU_ACTOR / USER          git authorship identity
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { brainRoot } from "../lib/paths";
import { formatRecall } from "./recall";
import { BrainStore } from "./store";

const MEMORY_ADDENDUM_MARKER = "# Persistent Memory (Brain)";
const MEMORY_ADDENDUM = `

${MEMORY_ADDENDUM_MARKER}

You have a durable brain (an OKF markdown knowledge bundle):
- Relevant memories are injected automatically as a <brain-recall> block; treat them as potentially stale and verify load-bearing details.
- Call brain_remember when the user states a durable preference, decision, fact, or correction worth keeping — or when you learn something you'd want in a future session. Do not remember secrets or transient chatter.
- Call brain_query to look something up when the recall block is insufficient.
Memory is yours to curate: prefer one focused concept per memory, with a clear title.`;

function recallLimit(): number {
	const parsed = Number(process.env.AGENT_TOOLKIT_BRAIN_LIMIT ?? 6);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 6;
}

function actorId(): string {
	return process.env.TADU_ACTOR ?? process.env.USER ?? "agent-toolkit";
}

const rememberSchema = Type.Object({
	text: Type.String({
		description: "The durable information to remember (the concept body).",
	}),
	title: Type.Optional(
		Type.String({
			description:
				"Short concept title. When provided, a dedicated OKF concept doc is created; otherwise the note is appended to the chronological log.",
		}),
	),
	type: Type.Optional(
		Type.String({
			description:
				'OKF concept type, e.g. "Person", "Project", "Decision", "Playbook", "Reference", "Note". Defaults to "Note".',
		}),
	),
	tags: Type.Optional(
		Type.Array(Type.String(), { description: "Cross-cutting tags." }),
	),
});
type RememberInput = Static<typeof rememberSchema>;

const querySchema = Type.Object({
	query: Type.String({ description: "What to search the brain for." }),
	limit: Type.Optional(
		Type.Number({ description: "Max memories to return (default 6)." }),
	),
});
type QueryInput = Static<typeof querySchema>;

const forgetSchema = Type.Object({
	id: Type.String({
		description: 'Concept id to remove, e.g. "people/tom-davies".',
	}),
});
type ForgetInput = Static<typeof forgetSchema>;

export default function brainExtension(pi: ExtensionAPI): void {
	const store = new BrainStore(brainRoot(), { actor: actorId() });
	let recallEnabled = process.env.AGENT_TOOLKIT_BRAIN_RECALL !== "off";
	let dirty = false;

	function ensureInitialised(): void {
		if (!store.isInitialised()) store.init();
	}

	function flushCommit(reason: string): void {
		if (!dirty) return;
		dirty = false;
		void store.commit(`brain: ${reason}`).catch(() => {
			// Commit is best-effort durability; never surface as a turn failure.
		});
	}

	pi.on("before_agent_start", async (event) => {
		const systemPrompt = event.systemPrompt.includes(MEMORY_ADDENDUM_MARKER)
			? event.systemPrompt
			: `${event.systemPrompt}${MEMORY_ADDENDUM}`;
		if (!recallEnabled || !store.isInitialised()) return { systemPrompt };
		try {
			const hits = store.search(event.prompt, recallLimit());
			const block = formatRecall(hits);
			return { systemPrompt: block ? `${systemPrompt}\n\n${block}` : systemPrompt };
		} catch {
			return { systemPrompt };
		}
	});

	pi.on("agent_end", async () => flushCommit("capture"));
	pi.on("session_shutdown", async () => flushCommit("capture on shutdown"));

	pi.registerTool({
		name: "brain_remember",
		label: "remember",
		description:
			"Persist durable knowledge to the brain. Use for preferences, decisions, facts, or corrections worth keeping across sessions.",
		promptSnippet: "Save a durable memory to the brain",
		promptGuidelines: [
			"Use brain_remember for durable, reusable knowledge — not transient chatter or secrets.",
			"Give a concept a title when it deserves its own document; omit the title for a quick logged note.",
		],
		parameters: rememberSchema,
		async execute(_id, params: RememberInput, _signal, _onUpdate, ctx) {
			ensureInitialised();
			const text = params.text.trim();
			if (text === "") {
				return errorResult("Nothing to remember: text is empty.");
			}
			let summary: string;
			if (params.title?.trim()) {
				const { id } = store.writeConcept({
					type: params.type?.trim() || "Note",
					title: params.title.trim(),
					tags: params.tags,
					body: text,
				});
				summary = `Remembered concept ${id}.`;
			} else {
				store.appendLog(text);
				summary = "Logged a note to the brain.";
			}
			dirty = true;
			notify(ctx, summary);
			return textResult(summary, { ok: true });
		},
		renderCall(args, theme) {
			const label = (args.title as string) || "note";
			return new Text(theme.fg("accent", `Remembering: ${label}`), 0, 0);
		},
		renderResult: (res, _options, theme, renderCtx) => {
			const text = res.content.find((item) => item.type === "text")?.text ?? "";
			return new Text(
				renderCtx.isError
					? theme.fg("error", text)
					: `${theme.fg("success", "✓ ")}${theme.fg("muted", text)}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "brain_query",
		label: "recall",
		description:
			"Search the brain for relevant prior context: preferences, decisions, people, projects, history.",
		promptSnippet: "Search the brain for relevant memories",
		parameters: querySchema,
		async execute(_id, params: QueryInput, _signal, _onUpdate, _ctx) {
			const query = params.query.trim();
			if (query === "") return errorResult("Provide a query.");
			if (!store.isInitialised()) return textResult("The brain is empty.", { count: 0 });
			const hits = store.search(query, clampLimit(params.limit));
			const block = formatRecall(hits);
			return textResult(block || "No relevant memories found.", { count: hits.length });
		},
		renderResult: (res, _options, theme, renderCtx) => {
			const text = res.content.find((item) => item.type === "text")?.text ?? "";
			return new Text(
				renderCtx.isError
					? theme.fg("error", text)
					: `${theme.fg("success", "✓ ")}${theme.fg("muted", text)}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "brain_forget",
		label: "forget",
		description:
			"Remove a concept from the brain by id. Use only when a memory is wrong or obsolete; the removal is recorded in the log.",
		parameters: forgetSchema,
		async execute(_id, params: ForgetInput, _signal, _onUpdate, ctx) {
			if (!store.isInitialised()) return errorResult("The brain is empty.");
			const removed = store.forget(params.id.trim());
			if (!removed) return errorResult(`No concept with id "${params.id.trim()}".`);
			dirty = true;
			const summary = `Forgot ${params.id.trim()}.`;
			notify(ctx, summary);
			return textResult(summary, { ok: true });
		},
		renderResult: (res, _options, theme, renderCtx) => {
			const text = res.content.find((item) => item.type === "text")?.text ?? "";
			return new Text(
				renderCtx.isError
					? theme.fg("error", text)
					: `${theme.fg("success", "✓ ")}${theme.fg("muted", text)}`,
				0,
				0,
			);
		},
	});

	pi.registerCommand("brain", {
		description:
			"Brain memory: /brain status | init | on | off | query <q> | remember <text>",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "status", label: "status — show brain state" },
				{ value: "init", label: "init — scaffold the OKF bundle" },
				{ value: "on", label: "on — enable automatic recall" },
				{ value: "off", label: "off — disable automatic recall" },
				{ value: "query ", label: "query — search the brain" },
				{ value: "remember ", label: "remember — log a note" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const remainder = rest.join(" ");
			switch (command) {
				case "status": {
					const initialised = store.isInitialised();
					const count = initialised ? store.listConceptFiles().length : 0;
					ctx.ui.notify(
						[
							`Brain: ${initialised ? "ready" : "not initialised"} (${count} concepts)`,
							`Root: ${store.root}`,
							`Recall: ${recallEnabled ? "on" : "off"}`,
						].join("\n"),
						"info",
					);
					return;
				}
				case "init":
					store.init();
					ctx.ui.notify(`Brain initialised at ${store.root}`, "info");
					return;
				case "on":
					recallEnabled = true;
					ctx.ui.notify("Brain recall enabled.", "info");
					return;
				case "off":
					recallEnabled = false;
					ctx.ui.notify("Brain recall disabled.", "warning");
					return;
				case "query": {
					if (!remainder) return void ctx.ui.notify("Usage: /brain query <q>", "warning");
					if (!store.isInitialised()) return void ctx.ui.notify("The brain is empty.", "info");
					const hits = store.search(remainder, recallLimit());
					ctx.ui.notify(formatRecall(hits) || "No relevant memories found.", "info");
					return;
				}
				case "remember": {
					if (!remainder) return void ctx.ui.notify("Usage: /brain remember <text>", "warning");
					ensureInitialised();
					store.appendLog(remainder);
					dirty = true;
					flushCommit("manual note");
					ctx.ui.notify("Logged a note to the brain.", "info");
					return;
				}
				default:
					ctx.ui.notify(
						"Usage: /brain status | init | on | off | query <q> | remember <text>",
						"warning",
					);
			}
		},
	});
}

function clampLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return recallLimit();
	return Math.max(1, Math.min(20, Math.floor(limit)));
}

function notify(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "info");
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function errorResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: { ok: false } };
}
