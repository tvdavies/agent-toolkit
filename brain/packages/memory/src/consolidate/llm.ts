import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { deriveModelId, type UsageMeter } from "../usage.js";
import type { WrittenChunk } from "../write/types.js";
import type { ConsolidationCache } from "./cache.js";
import type { Consolidator } from "./types.js";

export type LlmConsolidatorOptions = {
  /** Model for the per-group aggregation call. */
  readonly model: LanguageModel;
  /** Minimum facts per entity group to bother consolidating. Default 2. */
  readonly minGroupSize?: number;
  /** Maximum facts to include in one consolidation call. Default 12. */
  readonly maxGroupSize?: number;
  /** Parallel aggregation calls in flight. Default 4. */
  readonly concurrency?: number;
  /** Optional content-addressed cache. Skips LLM on hit. */
  readonly cache?: ConsolidationCache;
  /**
   * If true, group facts by their `topics` metadata in addition to
   * primary entity, emitting `aggregate-topic-{slug}-N.md` chunks.
   * Tested in M2.z; regressed (-6 questions on dev) because topic
   * aggregates competed with entity aggregates for top-K. Off by
   * default; left in code for future re-introduction with smarter
   * topic gating (e.g. only when ≥4 facts share a topic).
   */
  readonly groupByTopic?: boolean;
  /** Optional usage meter for cost attribution. */
  readonly usage?: UsageMeter;
  /** Provider-prefixed model id for usage attribution. Defaults to `model`. */
  readonly modelId?: string;
};

const DEFAULT_MIN_GROUP_SIZE = 2;
const DEFAULT_MAX_GROUP_SIZE = 12;
const DEFAULT_CONCURRENCY = 4;

const AggregateSchema = z.object({
  summary: z
    .string()
    .describe(
      "Concise aggregate over the facts. Include counts, totals, and a short list of constituents when relevant. Keep dates/numbers verbatim.",
    ),
});

const SYSTEM_PROMPT = `You are a memory-consolidation agent. You receive a group of related facts about the same entity from a single conversation history. Your job is to produce ONE aggregate fact that summarises the group so a future assistant can answer counting, totalling, or ordering questions in a single retrieval.

Rules:
- If the facts describe N events of the same kind, your aggregate must state the count.
- If the facts contain monetary amounts or quantities, your aggregate must include the total or sum.
- If the facts contain dates, your aggregate may list them chronologically.
- Keep all numbers, dates, and named entities verbatim — never approximate.
- Keep it concise (1–3 sentences). The aggregate sits alongside the original facts; it doesn't replace them.

Anti-merge rule:
- If the facts share a name BUT have different qualifiers (e.g. "Alex from Germany" vs "partner Alex", "cousin Sarah" vs "Sarah from work"), they refer to DIFFERENT entities. Do NOT merge their facts into a single aggregate. Instead, return a count of zero by emitting an empty/skipped summary — the underlying facts will still be retrievable.
- If you can't tell whether the facts refer to the same entity, prefer NOT to merge — output a summary that explicitly notes the ambiguity rather than asserting a count.
- If the facts describe distinct events that are clearly the same kind (multiple weddings, multiple charity events), DO aggregate even when the participants differ — that's the whole point.

Example input facts (entity = "wedding"):
- "User attended Sarah and Mike's wedding on March 15, 2024."
- "User attended Lisa and James's wedding on June 8, 2024."
- "User attended Emma and Tom's wedding on August 22, 2024."

Example aggregate:
"User attended 3 weddings in 2024: Sarah/Mike (March 15), Lisa/James (June 8), Emma/Tom (August 22)."`;

/**
 * LLM-driven consolidator. Groups extraction-stack chunks by their
 * primary entity (from chunk metadata.entities[0]), then for each
 * group with ≥ minGroupSize facts emits one aggregate chunk via a
 * structured LLM call. Skips chunks without entity metadata (verbatim
 * chunks at `episodic/*`).
 */
export function createLlmConsolidator(opts: LlmConsolidatorOptions): Consolidator {
  const minGroupSize = opts.minGroupSize ?? DEFAULT_MIN_GROUP_SIZE;
  const maxGroupSize = opts.maxGroupSize ?? DEFAULT_MAX_GROUP_SIZE;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const groupByTopic = opts.groupByTopic ?? false;
  const modelId = opts.modelId ?? deriveModelId(opts.model);

  return {
    async consolidate(chunks, baseOrdinal): Promise<WrittenChunk[]> {
      // Group by primary entity AND by each topic. Entity grouping
      // captures specifics ("Bike-a-Thon" → 1 fact); topic grouping
      // captures abstract categories ("charity event" → multiple facts).
      // The same fact can land in both an entity group and one or more
      // topic groups; the consolidator emits aggregates for any group
      // with ≥ minGroupSize members.
      type FactRef = { content: string; entity: string; ordinal: number };
      const byKey = new Map<string, { kind: "entity" | "topic"; key: string; facts: FactRef[] }>();
      const addToGroup = (kind: "entity" | "topic", key: string, fact: FactRef): void => {
        const compoundKey = `${kind}:${key}`;
        const existing = byKey.get(compoundKey);
        if (existing !== undefined) {
          existing.facts.push(fact);
        } else {
          byKey.set(compoundKey, { kind, key, facts: [fact] });
        }
      };
      for (const c of chunks) {
        const entities = c.metadata?.entities;
        const topics = c.metadata?.topics;
        const ref: FactRef = {
          content: c.content,
          entity: "", // overwritten per-group below
          ordinal: c.ordinal,
        };
        if (Array.isArray(entities) && entities.length > 0) {
          const primary = String(entities[0]).trim().toLowerCase();
          if (primary !== "") {
            addToGroup("entity", primary, { ...ref, entity: primary });
          }
        }
        if (groupByTopic && Array.isArray(topics)) {
          for (const t of topics) {
            const topic = String(t).trim().toLowerCase();
            if (topic !== "") addToGroup("topic", topic, { ...ref, entity: topic });
          }
        }
      }

      const groups = [...byKey.values()]
        .filter((g) => g.facts.length >= minGroupSize)
        .map((g) => ({
          kind: g.kind,
          entity: g.key,
          facts: g.facts.slice(0, maxGroupSize),
        }));

      if (groups.length === 0) return [];

      const results: (WrittenChunk | undefined)[] = new Array(groups.length);
      let next = 0;
      async function worker(): Promise<void> {
        for (;;) {
          const i = next++;
          if (i >= groups.length) return;
          const g = groups[i];
          if (g === undefined) continue;
          results[i] = await consolidateGroup(
            opts.model,
            g,
            baseOrdinal + i,
            opts.cache,
            opts.usage,
            modelId,
          );
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, worker));
      return results.filter(
        (r): r is WrittenChunk => r !== undefined && r.content.trim().length > 0,
      );
    },
  };
}

async function consolidateGroup(
  model: LanguageModel,
  group: {
    kind: "entity" | "topic";
    entity: string;
    facts: { content: string; entity: string; ordinal: number }[];
  },
  ordinal: number,
  cache: ConsolidationCache | undefined,
  usage: UsageMeter | undefined,
  modelId: string,
): Promise<WrittenChunk | undefined> {
  // Cache key includes group kind so entity-grouping and topic-grouping
  // for the same entity name don't collide.
  const cacheInput = group.facts.map((f) => ({
    content: f.content,
    entity: `${group.kind}:${f.entity}`,
  }));
  const cached = cache?.get(cacheInput);
  let summary: string;
  if (cached !== undefined) {
    summary = cached.content;
  } else {
    const factList = group.facts.map((f, i) => `${i + 1}. ${f.content}`).join("\n");
    const label = group.kind === "topic" ? "Topic" : "Entity";
    try {
      const result = await generateObject({
        model,
        system: SYSTEM_PROMPT,
        prompt: `${label}: "${group.entity}"\n\nFacts:\n${factList}\n\nProduce one aggregate fact.`,
        schema: AggregateSchema,
        temperature: 0,
      });
      usage?.record(
        "consolidator",
        modelId,
        result.usage?.inputTokens ?? 0,
        result.usage?.outputTokens ?? 0,
      );
      summary = result.object.summary;
      cache?.set(cacheInput, {
        entity: group.entity,
        content: summary,
        coversOrdinals: group.facts.map((f) => f.ordinal),
      });
    } catch {
      // On failure, skip this aggregate — the underlying facts are
      // still in storage from the writer.
      return undefined;
    }
  }

  return {
    type: "aggregates",
    ordinal,
    content: summary,
    metadata: {
      kind: group.kind,
      ...(group.kind === "entity" ? { entities: [group.entity] } : { topics: [group.entity] }),
      coversOrdinals: group.facts.map((f) => f.ordinal),
      extractedBy: "consolidator",
      extractorModel: modelId,
      extractorPromptVersion: "v4",
      sourceKind: "consolidation",
      authority: "consolidated",
      derivedFrom: group.facts.map((f) => f.ordinal.toString()),
    },
  };
}

export const LLM_CONSOLIDATOR_ID = "llm-consolidator";
