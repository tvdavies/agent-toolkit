import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { deriveModelId, type UsageMeter } from "../usage.js";

/**
 * Query expander. Rewrites a single user query into N variants for
 * RAG-Fusion-style retrieval. Each variant is retrieved independently;
 * results are fused via RRF.
 *
 * Motivation: M2.i's residual multi-session failures are mostly
 * counting/aggregation questions where the relevant events are spread
 * across sessions with paraphrased phrasing. BM25 + vector on a single
 * query phrasing can miss events that use different surface words.
 * Multi-query expansion (RAG-Fusion, Adrien Brault 2024) covers more
 * surface forms.
 */
export interface QueryExpander {
  expand(query: string): Promise<string[]>;
}

export type GatewayQueryExpanderOptions = {
  /** Gateway-format model id. Default: Gemini 3 Flash (cheap, fast). */
  readonly model?: LanguageModel;
  /** Number of expansions to generate. Default 4. */
  readonly count?: number;
  /** Whether to include the original query in the result. Default true. */
  readonly includeOriginal?: boolean;
  /** Optional usage meter for cost attribution. */
  readonly usage?: UsageMeter;
  /** Provider-prefixed model id for usage attribution. Defaults to `model`. */
  readonly modelId?: string;
};

const DEFAULT_MODEL: LanguageModel = "google/gemini-3-flash";
const DEFAULT_COUNT = 4;

const ExpansionSchema = z.object({
  queries: z.array(z.string().min(1)),
});

const SYSTEM_PROMPT = `You are a query rewriter for a memory-retrieval system. Given a user question about past conversations, write alternative phrasings that would surface the same answer in a search.

Rules:
- Keep each rewrite short and concrete.
- Vary surface words (synonyms, paraphrases, related concepts) — different rewrites should not repeat the same content words.
- Prefer event nouns over question words ("wedding", "purchase", "trip" — not "what", "did").
- Do NOT include the original query.
- Do NOT explain; just output the JSON.`;

export function createQueryExpander(opts: GatewayQueryExpanderOptions = {}): QueryExpander {
  const model = opts.model ?? DEFAULT_MODEL;
  const count = opts.count ?? DEFAULT_COUNT;
  const includeOriginal = opts.includeOriginal ?? true;
  const modelId = opts.modelId ?? deriveModelId(model);

  return {
    async expand(query: string): Promise<string[]> {
      const prompt = `Question: ${query}\n\nReturn JSON: { "queries": [<${count} alternative phrasings>] }`;
      let expansions: string[];
      try {
        const result = await generateObject({
          model,
          system: SYSTEM_PROMPT,
          prompt,
          schema: ExpansionSchema,
          temperature: 0.3,
        });
        opts.usage?.record(
          "expander",
          modelId,
          result.usage?.inputTokens ?? 0,
          result.usage?.outputTokens ?? 0,
        );
        expansions = result.object.queries.slice(0, count);
      } catch {
        // On expansion failure, fall back to just the original query.
        return [query];
      }
      const out = includeOriginal ? [query, ...expansions] : expansions;
      // Dedupe (case-insensitive) while preserving order.
      const seen = new Set<string>();
      return out.filter((q) => {
        const key = q.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
  };
}
