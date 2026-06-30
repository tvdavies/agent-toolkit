import type { RetrievalInput } from "@ai-assistant/contracts";
import type { IntentClassification } from "./intent.js";
import { planRetrieval, prepareRetrievalQuery } from "./stages.js";

export interface PrepareRecallOptions {
  input: RetrievalInput;
  defaultTopK: number;
  pathBoostTopK?: number;
  hasEmbedders: boolean;
  recallModuleEnabled(id: string): boolean;
}

export interface PreparedRecall {
  effectiveQuery: string;
  enrichedInput: RetrievalInput;
  intent: IntentClassification;
  topK: number;
}

/** Run query preparation and intent/top-K planning for recall. */
export function prepareRecall(opts: PrepareRecallOptions): PreparedRecall {
  const prepared = opts.recallModuleEnabled("brain/temporal-expansion")
    ? prepareRetrievalQuery(opts.input)
    : { effectiveQuery: opts.input.query, input: opts.input };
  const planned = opts.recallModuleEnabled("brain/intent-planner")
    ? planRetrieval(prepared.effectiveQuery, opts.input, opts.defaultTopK, opts.pathBoostTopK)
    : {
        intent: {
          intent: "general" as const,
          weights: { bm25: 1, vector: opts.hasEmbedders ? 1 : 0 },
        },
        topK: opts.input.budget?.maxItems ?? opts.defaultTopK,
      };

  return {
    effectiveQuery: prepared.effectiveQuery,
    enrichedInput: prepared.input,
    intent: planned.intent,
    topK: planned.topK,
  };
}
