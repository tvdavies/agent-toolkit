import type { UsageStats } from "../storage/sqlite.js";

export type UsageBoostInput = {
  score: number;
  metadata?: Record<string, unknown>;
};

/**
 * Retrieval reinforcement. Citations are the strongest signal because the
 * actor actually used the memory in an answer. Injections are weaker; raw
 * retrievals are weakest because many retrieved memories are discarded.
 * Low-confidence extracted memories with no usage get a small penalty.
 */
export function applyUsageBoost(hit: UsageBoostInput, usage: UsageStats | undefined): number {
  const retrievals = usage?.retrievalCount ?? 0;
  const injections = usage?.injectionCount ?? 0;
  const citations = usage?.citationCount ?? 0;

  let multiplier = 1;
  if (citations > 0) multiplier += 0.12 * Math.log1p(citations);
  if (injections > 0) multiplier += 0.04 * Math.log1p(injections);
  if (retrievals > 0) multiplier += 0.015 * Math.log1p(retrievals);

  const confidence = hit.metadata?.confidence;
  if (citations === 0 && injections === 0 && retrievals === 0 && confidence === "low") {
    multiplier *= 0.9;
  }

  hit.score *= multiplier;
  return multiplier;
}
