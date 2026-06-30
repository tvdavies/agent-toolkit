import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { deriveModelId, type UsageMeter } from "../usage.js";
import { detectDegenerateRepetition } from "./degenerate.js";
import { formatTurnEvent, type WriteEvent, type Writer, type WrittenChunk } from "./types.js";

/**
 * Mastra-style observation-log writer (M3.c).
 *
 * Borrowed conceptually from
 * `mastra/packages/memory/src/processors/observational-memory/observer-agent.ts`.
 * Their Observer reads conversation turns and emits priority-tagged
 * observations into an append-only log; their LongMemEval result on
 * full 500q is **84.23%** vs Jeff's 75.4% in our hands at the same
 * actor model — strongest evidence we have for an architectural
 * lift.
 *
 * Differences from our existing extractor:
 *  - **Per-session granularity** (one LLM call per session) instead
 *    of per-N-turn groups. The whole session in one shot makes the
 *    observer better at preserving "I usually X" / "My favourite is
 *    Y" type biographical statements that span multiple turns.
 *  - **Compact priority-tagged format**. Each observation is a
 *    short statement prefixed with one of:
 *      🔴 high — explicit user fact (name, age, family, employer)
 *      🟡 medium — activity, interest, or recent event
 *      🟢 low — soft/uncertain signal (paraphrased opinions)
 *      ✅ resolved — completed task / closed thread
 *  - **Each observation is one chunk** at
 *    `observation-{session-slug}-{idx}.md`. Retrieval treats them
 *    like any other chunks; the priority emoji is cosmetic in
 *    retrieval but visible in the actor prompt.
 *
 * Composes with the verbatim writer + extractor via
 * `createHybridWriter([verbatimWriter, extractor, observer])` —
 * three parallel chunk pools, all retrievable, RRF-fused.
 */
export type ObservationWriterOptions = {
  /** Model that runs per-session. Cheap models work well. */
  readonly model: LanguageModel;
  /** Parallel observer calls in flight. Default 4. */
  readonly concurrency?: number;
  /** Optional content-addressed cache. Skips LLM on hit. */
  readonly cache?: ObservationCache;
  /** Max observations per session. Default 8. */
  readonly maxPerSession?: number;
  /** Optional usage meter; records per-call tokens for cost attribution. */
  readonly usage?: UsageMeter;
  /** Provider-prefixed model id for usage attribution. Defaults to `model`. */
  readonly modelId?: string;
};

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_PER_SESSION = 8;

const ObservationSchema = z.object({
  priority: z.enum(["high", "medium", "low", "resolved"]),
  content: z.string().describe("Self-contained statement about the user or session."),
  entities: z
    .array(z.string())
    .describe("Named entities mentioned (people, places, products). Empty array if none."),
});

const ObservationOutput = z.object({
  observations: z.array(ObservationSchema),
});

export type Observation = z.infer<typeof ObservationSchema>;

/** Optional cache for observation outputs, mirrors FactCache. */
export interface ObservationCache {
  get(group: readonly WriteEvent[]): Observation[] | undefined;
  set(group: readonly WriteEvent[], obs: Observation[]): void;
  readonly hits: number;
  readonly misses: number;
}

const SYSTEM_PROMPT = `You are an observer scribe. You read a single conversation session between a user and an assistant and emit a small set of observations that capture the user-relevant facts, preferences, events, and decisions in a compact priority-tagged form.

For each observation, choose a priority:
  - "high": stable user attributes (name, age, family, employer, location, education) and explicit life events (got married, moved house, had a child).
  - "medium": activities, interests, recent purchases, opinions about specific things, ongoing projects.
  - "low": soft / uncertain signals — vaguely-expressed opinions, hypotheticals.
  - "resolved": tasks the user mentioned and the assistant completed in the same session.

Rules:
  - **Preserve verbatim** all specific names, dates, monetary amounts, durations, and quantities. Quote the user's exact wording for unusual phrases.
  - **Split compound observations** — if the user said two distinct things, emit two observations.
  - **Deduplicate paraphrases** — combine repeated mentions of the same fact into one observation.
  - **One self-contained statement per observation** — must make sense without surrounding context.
  - **Capture assistant-discovered facts when they answer the user's question or complete a requested investigation**, especially names, issue IDs, file paths, commands run, root causes, and decisions. Mark these as medium unless they are stable user attributes.
  - **Skip filler** — greetings, meta-talk, generic acknowledgements.

Format your observations as concise statements without markdown formatting. Aim for 3-8 observations per session. Each observation has a priority, content, and entities. Use an empty entities array when none are mentioned.

Example output for a session about a wedding:
{
  "observations": [
    {
      "priority": "high",
      "content": "User attended Sarah and Mike's wedding on March 15, 2024 at a winery in Sonoma.",
      "entities": ["Sarah", "Mike", "Sonoma"]
    },
    {
      "priority": "medium",
      "content": "User mentioned considering a beach destination for their own wedding next year.",
      "entities": []
    }
  ]
}`;

/**
 * Cache for observations. Same content-addressing as FactCache.
 */
export type ObservationCacheOptions = {
  cacheDir: string;
  cacheKey: string;
};

export function createObservationCache(opts: ObservationCacheOptions): ObservationCache {
  // Re-uses the same hash-keyed JSON pattern as FactCache.
  mkdirSync(opts.cacheDir, { recursive: true });
  let hits = 0;
  let misses = 0;
  const pathFor = (group: readonly WriteEvent[]): string => {
    const visible = group.map((e) =>
      e.kind === "ingested-item"
        ? { kind: e.kind, content: e.content }
        : e.kind === "tool-call"
          ? { kind: e.kind, tool: e.tool, args: e.args, result: e.result }
          : { kind: e.kind, text: e.text },
    );
    const payload = JSON.stringify({ k: opts.cacheKey, g: visible });
    const hash = createHash("sha256").update(payload).digest("hex");
    return join(opts.cacheDir, `${hash}.json`);
  };
  return {
    get(group) {
      try {
        const raw = readFileSync(pathFor(group), "utf8");
        const parsed = JSON.parse(raw) as { observations: Observation[] };
        hits++;
        return parsed.observations;
      } catch {
        misses++;
        return undefined;
      }
    },
    set(group, observations) {
      writeFileSync(pathFor(group), JSON.stringify({ observations }));
    },
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },
  };
}

/**
 * LLM-backed per-session observer. Groups events by `recordedAt`
 * (= session boundary), runs one LLM call per session.
 */
export function createObservationWriter(opts: ObservationWriterOptions): Writer {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const maxPerSession = opts.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
  const modelId = opts.modelId ?? deriveModelId(opts.model);

  return {
    async process(events, baseOrdinal): Promise<WrittenChunk[]> {
      if (events.length === 0) return [];

      // Split events by session boundary (recordedAt change).
      const sessions: WriteEvent[][] = [];
      let current: WriteEvent[] = [];
      let currentDate: string | undefined;
      for (const e of events) {
        if (current.length === 0) {
          current.push(e);
          currentDate = e.recordedAt;
        } else if (e.recordedAt === undefined || e.recordedAt === currentDate) {
          current.push(e);
        } else {
          sessions.push(current);
          current = [e];
          currentDate = e.recordedAt;
        }
      }
      if (current.length > 0) sessions.push(current);

      const results: WrittenChunk[][] = new Array(sessions.length);
      let next = 0;
      async function worker(): Promise<void> {
        for (;;) {
          const i = next++;
          if (i >= sessions.length) return;
          const session = sessions[i];
          if (session === undefined) continue;
          results[i] = await observeSession(
            opts.model,
            session,
            baseOrdinal,
            i,
            maxPerSession,
            opts.cache,
            opts.usage,
            modelId,
          );
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, sessions.length) }, worker));
      return results.flat();
    },
  };
}

const PRIORITY_EMOJI: Record<Observation["priority"], string> = {
  high: "🔴",
  medium: "🟡",
  low: "🟢",
  resolved: "✅",
};

async function observeSession(
  model: LanguageModel,
  session: readonly WriteEvent[],
  baseOrdinal: number,
  sessionIdx: number,
  maxPerSession: number,
  cache: ObservationCache | undefined,
  usage: UsageMeter | undefined,
  modelId: string,
): Promise<WrittenChunk[]> {
  let observations: Observation[] | undefined = cache?.get(session);
  if (observations === undefined) {
    const turns = session.map(formatTurnEvent).join("\n");
    try {
      const result = await generateObject({
        model,
        system: SYSTEM_PROMPT,
        prompt: `Session turns:\n${turns}\n\nReturn JSON: { "observations": [...] }`,
        schema: ObservationOutput,
        temperature: 0,
      });
      usage?.record(
        "observer",
        modelId,
        result.usage?.inputTokens ?? 0,
        result.usage?.outputTokens ?? 0,
      );
      observations = result.object.observations;
      // Degeneracy guard. Same as extractor — skip cache on rep loops.
      const joined = observations.map((o) => o.content).join("\n");
      if (detectDegenerateRepetition(joined).degenerate) {
        return [];
      }
      cache?.set(session, observations);
    } catch {
      // On observer failure, return empty — verbatim/extractor cover
      // the session's content via the hybrid writer.
      return [];
    }
  }
  // Apply per-call maxPerSession cap (runtime knob; cache stores
  // the full LLM output so a future config can re-slice differently).
  observations = observations.slice(0, maxPerSession);

  const recordedAt = session.find((e) => e.recordedAt !== undefined)?.recordedAt;
  return observations.map((o, oIdx) => {
    const ordinal = baseOrdinal + sessionIdx * maxPerSession + oIdx;
    const emoji = PRIORITY_EMOJI[o.priority];
    return {
      type: "observations" as const,
      ordinal,
      content: `${emoji} ${o.content}`,
      metadata: {
        priority: o.priority,
        entities: o.entities,
        ...(recordedAt !== undefined ? { recordedAt } : {}),
        extractedBy: "observer",
        extractorModel: modelId,
        extractorPromptVersion: "v1",
        sourceKind: "observation",
        authority: "observed",
      },
    };
  });
}

export const OBSERVATION_WRITER_ID = "observation";
