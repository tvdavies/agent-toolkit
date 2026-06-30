import type { BrainModule } from "@ai-assistant/brain-core";
import { deterministicExtraction } from "./modules/deterministic-extraction.js";
import { hybridRetrieval } from "./modules/hybrid-retrieval.js";
import {
  fallbackQueryRewrite,
  l0WorkingMemory,
  llmExtraction,
  observationWriter,
  patterns,
  proceduralMemory,
  reflect,
  retrievalLog,
  retryLadder,
  synthesize,
} from "./modules/placeholders.js";
import { authorityBoost, backlinkBoost, usageBoost } from "./modules/rank-boosts.js";
import { verbatimWriter } from "./modules/verbatim-writer.js";

export const builtins = {
  /** Standard built-in module set. Current behaviour can be migrated behind these stable IDs incrementally. */
  standard(): BrainModule[] {
    return [
      verbatimWriter,
      proceduralMemory,
      deterministicExtraction,
      llmExtraction,
      observationWriter,
      hybridRetrieval,
      retryLadder,
      fallbackQueryRewrite,
      authorityBoost,
      backlinkBoost,
      usageBoost,
      reflect,
      synthesize,
      patterns,
      l0WorkingMemory,
      retrievalLog,
    ];
  },
};

export {
  deterministicExtraction,
  hybridRetrieval,
  authorityBoost,
  backlinkBoost,
  usageBoost,
  verbatimWriter,
};
