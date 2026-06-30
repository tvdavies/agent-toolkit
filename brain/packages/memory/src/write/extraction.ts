import { generateObject, generateText, type LanguageModel } from "ai";
import { z } from "zod";
import type { MemoryType } from "../storage/markdown-store.js";
import { deriveModelId, type UsageMeter } from "../usage.js";
import type { Fact, FactCache } from "./cache.js";
import type { Contextualiser } from "./contextualise.js";
import { detectDegenerateRepetition } from "./degenerate.js";
import { enrichFactWithTemporal } from "./temporal-postprocess.js";
import {
  type ExistingMemoryPreview,
  formatTurnEvent,
  type WriteContext,
  type WriteEvent,
  type Writer,
  type WrittenChunk,
} from "./types.js";

export type ExtractionWriterOptions = {
  /**
   * Model for extraction. Pass:
   *   - a string like `"google/gemini-3-flash"` (gateway routing), or
   *   - a `LanguageModel` instance (e.g. from `createLocalProvider()`).
   */
  readonly model: LanguageModel;
  /** Events per extraction call. Default 10 (~1.5 sessions of LongMemEval). */
  readonly groupSize?: number;
  /** Parallel extraction calls in flight. Default 4. */
  readonly concurrency?: number;
  /**
   * Optional content-addressed cache. When set, the LLM call is skipped
   * for groups already extracted in a previous run. See
   * `createFactCache` in `./cache.js`.
   */
  readonly cache?: FactCache;
  /**
   * Use `generateText` + manual JSON parse instead of `generateObject`.
   * Required for local reasoning models (e.g. Qwen 3.6) where LM Studio's
   * strict-JSON-schema decoder constrains output to start with `{`
   * immediately, but the model wants to emit chain-of-thought first —
   * reasoning fills `reasoning_content`, `content` stays empty, and AI
   * SDK throws "no object generated". Text mode lets the model reason
   * freely and we extract the JSON ourselves. Default false.
   */
  readonly useTextMode?: boolean;
  /**
   * Optional contextual prefix builder (M5.h). When set, every
   * extracted fact's chunk content is prefixed with a 50-100 token
   * situating sentence built by a cheap LLM call (cached on disk).
   * Mirrors Anthropic's contextual-retrieval recipe. Adds ~1 LLM call
   * per fact on cold cache; free on warm cache. Off by default — only
   * the `ours-hybrid-consol-obs-ctx` baseline opts in.
   */
  readonly contextualiser?: Contextualiser;
  /** Optional usage meter; records (inputTokens, outputTokens) per LLM call. */
  readonly usage?: UsageMeter;
  /**
   * Provider-prefixed model id used for usage attribution. Defaults
   * to the string form of `model` (or the `LanguageModel`'s
   * provider/modelId pair when introspectable).
   */
  readonly modelId?: string;
};

const DEFAULT_GROUP_SIZE = 10;
const DEFAULT_CONCURRENCY = 4;

const FactSchema = z.object({
  type: z.enum(["fact", "preference", "event", "decision", "context"]),
  content: z.string().describe("Self-contained statement of the fact."),
  entities: z
    .array(z.string())
    .optional()
    .describe("People, places, projects, products mentioned."),
  supersedes: z
    .string()
    .optional()
    .describe("ID or path of an existing memory this fact replaces or updates."),
});

const ExtractionOutput = z.object({
  facts: z.array(FactSchema),
});

const SYSTEM_PROMPT = `You are a memory-extraction agent. Read a sequence of conversation turns and emit a small set of structured memory notes that will help a future assistant answer questions about this conversation.

CRITICAL RULES:
  - NEVER repeat a turn verbatim. Always paraphrase into a short, self-contained third-person statement.
  - One fact per distinct piece of information. Combine paraphrases.
  - Each \`content\` MUST be under 200 characters. If yours is longer, you're quoting — rewrite it shorter.
  - Use third person ("the user is...", not "user: I am..."). NEVER start a content field with "user:" or "assistant:".
  - Aim for 3-8 entries per session. Most sessions don't have more than 8 distinct facts. If you produce more than 10, you're over-extracting.

Skip filler, greetings, meta-talk, and the assistant's own answers / advice. Only extract what the *user* says about themselves, their preferences, events in their life, or decisions they make.

You may be given existing memories for deduplication. If a new fact updates or replaces an existing memory, emit the new fact and set supersedes to that existing memory's id or path. If the existing memory already says the same thing and there is no new information, do not emit a duplicate.

Each entry has:
- type: one of fact | preference | event | decision | context
  - "fact": a stable user attribute, world fact, or definition (user's degree, employer, name, location).
  - "preference": something the user likes / dislikes / habitually does ("loves chocolate", "always orders decaf").
  - "event": a specific dated or datable thing that happened ("attended a wedding on Feb 1", "bought a new TV last week").
  - "decision": something the user decided or committed to ("decided to switch jobs", "agreed to negotiate the contract").
  - "context": background information or environment that doesn't fit other types.
- content: a self-contained statement, third-person, under 200 chars.
- entities: optional list of named entities involved.

Examples of GOOD extraction:
  { "type": "preference", "content": "User enjoys 80s and 90s family films and is planning a movie marathon." }
  { "type": "event", "content": "User has watched 4 MCU films in the last 3 months." }
  { "type": "fact", "content": "User is pursuing a Master's degree in Data Science." }

Examples of BAD extraction (do NOT do this):
  { "type": "fact", "content": "user: I'm planning a movie marathon with my family..." }  ← verbatim quote, has "user:" prefix
  { "type": "fact", "content": "assistant: What a great idea! Re-watching classic films..." }  ← assistant reply, not user info
  { "type": "context", "content": "<200+ chars of paraphrased turn>" }  ← too long, you're still quoting`;

/**
 * LLM-backed extraction writer. Groups buffered events, calls the model
 * once per group with structured-output to emit `facts[]`. Each fact
 * becomes one chunk with a path-conventional filename:
 *   - "user-fact-{ordinal}.md"        (type: fact)
 *   - "user-preference-{ordinal}.md"  (type: preference)
 *   - "milestone-{ordinal}.md"        (type: event)
 *   - "decision-{ordinal}.md"         (type: decision)
 *   - "context-{ordinal}.md"          (type: context)
 *
 * The path prefix matters: retrieval applies intent-based multipliers
 * to fused scores keyed on the prefix (preference queries boost
 * `user-preference-*`; temporal queries boost `milestone-*`). See
 * `retrieval/intent.ts` for the multiplier table.
 */
export function createExtractor(opts: ExtractionWriterOptions): Writer {
  const groupSize = opts.groupSize ?? DEFAULT_GROUP_SIZE;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const modelId = opts.modelId ?? deriveModelId(opts.model);

  return {
    async process(events, baseOrdinal, context?: WriteContext): Promise<WrittenChunk[]> {
      if (events.length === 0) return [];

      const groups: WriteEvent[][] = [];
      for (let i = 0; i < events.length; i += groupSize) {
        groups.push(events.slice(i, i + groupSize));
      }

      const results: WrittenChunk[][] = new Array(groups.length);
      let next = 0;
      async function worker(): Promise<void> {
        for (;;) {
          const i = next++;
          if (i >= groups.length) return;
          const group = groups[i];
          if (group === undefined) continue;
          results[i] = await extractGroup(
            opts.model,
            group,
            baseOrdinal,
            i,
            groupSize,
            opts.cache,
            opts.useTextMode === true,
            opts.contextualiser,
            opts.usage,
            modelId,
            context?.existingMemories ?? [],
          );
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, worker));
      return results.flat();
    },
  };
}

/**
 * Map an extracted fact's type label to its on-disk memory category.
 * Drives the directory each fact lands in and the intent-time
 * multiplier table the retriever consults.
 */
export function memoryTypeForFactType(type: string): MemoryType {
  switch (type) {
    case "fact":
      return "facts";
    case "preference":
      return "preferences";
    case "event":
      return "events";
    case "decision":
      return "decisions";
    default:
      return "context";
  }
}

async function extractGroup(
  model: LanguageModel,
  group: readonly WriteEvent[],
  baseOrdinal: number,
  groupIdx: number,
  groupSize: number,
  cache: FactCache | undefined,
  useTextMode: boolean,
  contextualiser: Contextualiser | undefined,
  usage: UsageMeter | undefined,
  modelId: string,
  existingMemories: readonly ExistingMemoryPreview[],
): Promise<WrittenChunk[]> {
  let facts: Fact[] | undefined = cache?.get(group);
  const fallbackToVerbatim = (): WrittenChunk[] =>
    group.map((e, i) => {
      const ordinal = baseOrdinal + groupIdx * groupSize + i;
      const isConversationTurn = e.kind === "user-turn" || e.kind === "assistant-turn";
      return {
        type: e.kind === "ingested-item" ? "observations" : "episodic",
        ordinal,
        content: formatTurnEvent(e),
        metadata: {
          sourceKind: isConversationTurn
            ? "conversation-transcript"
            : e.kind === "tool-call"
              ? "tool-transcript"
              : (e.source?.kind ?? "extraction-fallback"),
          authority: "observed",
          recallable: e.kind === "ingested-item",
          ...(e.kind === "ingested-item" && e.source !== undefined
            ? {
                derivedFrom: [e.source.id],
                sourceUri: e.source.url,
                sourceTitle: e.source.title,
                sourceInstanceId: e.source.instanceId,
                sourceExternalId: e.source.externalId,
              }
            : {}),
        },
      };
    });
  if (facts === undefined) {
    const turns = group.map(formatTurnEvent).join("\n");
    const prompt = buildTurnsPrompt(turns, existingMemories);
    try {
      facts = useTextMode
        ? await extractViaText(model, prompt, usage, modelId)
        : await extractViaObject(model, prompt, usage, modelId);
      // Degeneracy guard (M3.e). LLMs at temp=0 occasionally lock
      // into a repetition loop and emit kilobytes of duplicated
      // content. Caching the bad output would pollute retrieval
      // forever, so we skip cache and fall back to verbatim chunks
      // for this group.
      const joined = facts.map((f: Fact) => f.content).join("\n");
      const report = detectDegenerateRepetition(joined);
      if (report.degenerate) {
        return fallbackToVerbatim();
      }
      cache?.set(group, facts);
    } catch (err) {
      // On extraction failure, fall back to verbatim chunks for this
      // group so we don't lose data. Don't cache the failure.
      if (process.env.EXTRACTOR_DEBUG === "1") {
        process.stderr.write(`[extractor] fallbackToVerbatim: ${(err as Error).message}\n`);
      }
      return fallbackToVerbatim();
    }
  }

  // Date stamp: every event in the group is from the same session
  // (the writer splits groups at session boundaries), so any event's
  // recordedAt is the session's recordedAt. Used for temporal-anchoring
  // scoring at retrieve time and for the date prefix prepended to
  // chunk content.
  const recordedAt = group.find((e) => e.recordedAt !== undefined)?.recordedAt;
  const sourceRefs = group.flatMap((e) =>
    e.kind === "ingested-item" && e.source !== undefined ? [e.source] : [],
  );

  // Build per-fact session summary once for the optional contextualiser.
  // We only use the recordedAt date as the header when no richer summary
  // is available — keeps the LLM call cheap and deterministic for
  // caching.
  const sessionSummary = recordedAt ? `Session date: ${recordedAt.slice(0, 10)}` : "";

  const built = await Promise.all(
    facts.map(async (f, fIdx) => {
      const ordinal = baseOrdinal + groupIdx * groupSize + fIdx;
      const memoryType = memoryTypeForFactType(f.type);
      // M5.b1: enrich every fact with temporal frontmatter so BM25 can
      // match temporal queries ("on Wednesday", "in March") against the
      // body even when the fact's prose doesn't repeat the date.
      const enriched = enrichFactWithTemporal(f, recordedAt);
      // M5.h: optional contextualiser prefix. Cached on disk by
      // sha256(model, sessionId, factContent) so re-runs are free.
      let content = enriched.content;
      if (contextualiser !== undefined) {
        const ctxPrefix = await contextualiser.build({
          factContent: enriched.content,
          sessionSummary,
          ...(recordedAt !== undefined ? { sessionId: recordedAt } : {}),
        });
        content = contextualiser.apply(content, ctxPrefix);
      }
      return {
        type: memoryType,
        ordinal,
        content,
        metadata: {
          factType: enriched.type,
          ...(enriched.entities !== undefined ? { entities: enriched.entities } : {}),
          ...(recordedAt !== undefined ? { recordedAt } : {}),
          ...(f.supersedes !== undefined
            ? { supersedes: f.supersedes, status: "superseding" }
            : {}),
          extractedBy: "extractor",
          extractorModel: modelId,
          extractorPromptVersion: "v1",
          sourceKind: sourceRefs[0]?.kind ?? "extraction",
          ...(sourceRefs.length > 0
            ? {
                derivedFrom: [...new Set(sourceRefs.map((s) => s.id))],
                sourceUri: sourceRefs[0]?.url,
                sourceTitle: sourceRefs[0]?.title,
                sourceInstanceId: sourceRefs[0]?.instanceId,
                sourceExternalId: sourceRefs[0]?.externalId,
              }
            : {}),
          authority: "extracted",
        },
      } satisfies WrittenChunk;
    }),
  );
  return built;
}

function buildTurnsPrompt(
  turns: string,
  existingMemories: readonly ExistingMemoryPreview[],
): string {
  if (existingMemories.length === 0) return `Conversation turns:\n${turns}`;
  const previews = existingMemories
    .slice(0, 12)
    .map(
      (m) =>
        `- id: ${m.id}\n  path: ${m.path}\n  type: ${m.type}\n  content: ${m.content.slice(0, 400)}`,
    )
    .join("\n");
  return `Existing memories for deduplication/update:\n${previews}\n\nConversation turns:\n${turns}`;
}

async function extractViaObject(
  model: LanguageModel,
  turns: string,
  usage: UsageMeter | undefined,
  modelId: string,
): Promise<Fact[]> {
  const result = await generateObject({
    model,
    system: SYSTEM_PROMPT,
    prompt: `${turns}\n\nReturn JSON: { "facts": [...] }`,
    schema: ExtractionOutput,
    temperature: 0,
    maxOutputTokens: 8192,
  });
  usage?.record(
    "extractor",
    modelId,
    result.usage?.inputTokens ?? 0,
    result.usage?.outputTokens ?? 0,
  );
  return result.object.facts;
}

/**
 * Text-mode extraction: ask for JSON in the prompt, parse the response
 * manually. Used for local reasoning models where strict-schema mode
 * traps `content` empty (reasoning fills `reasoning_content`, decoder
 * never gets to schema-conformant output).
 */
async function extractViaText(
  model: LanguageModel,
  turns: string,
  usage: UsageMeter | undefined,
  modelId: string,
): Promise<Fact[]> {
  const result = await generateText({
    model,
    system: `${SYSTEM_PROMPT}\n\nReturn ONLY a JSON object of the form { "facts": [ { "type": "fact|preference|event|decision|context", "content": "...", "entities": ["..."], "supersedes": "optional existing id/path" } ] }. No prose, no commentary, no markdown fences.`,
    prompt: turns,
    temperature: 0,
    maxOutputTokens: 8192,
  });
  usage?.record(
    "extractor",
    modelId,
    result.usage?.inputTokens ?? 0,
    result.usage?.outputTokens ?? 0,
  );
  const json = extractJsonObject(result.text);
  if (json === undefined) {
    throw new Error("text-mode extraction: no JSON object in model output");
  }
  const parsed = ExtractionOutput.safeParse(json);
  if (!parsed.success) {
    throw new Error(`text-mode extraction: schema mismatch — ${parsed.error.message}`);
  }
  return parsed.data.facts;
}

/** Find the first `{...}` JSON object in a string. Tolerant of leading prose / fences. */
function extractJsonObject(text: string): unknown {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const start = stripped.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let isEscaped = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") isEscaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = stripped.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export const EXTRACTION_WRITER_ID = "extraction";
