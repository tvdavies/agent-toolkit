/**
 * Injection trace — separates "we retrieved these" from "the actor
 * actually saw these". A query may surface 20 candidates; the
 * harness drops some for token-budget reasons, others because
 * they're stale, others because they duplicate a higher-authority
 * sibling. The trace records which made it through and why each
 * skipped one was skipped.
 *
 * Operationally this lets us answer "I asked the brain a question
 * — why did it ignore my pinned note?" without rerunning the
 * pipeline. The eval harness can also use it to track injection
 * cost per question.
 */

import type { RetrievedMemory } from "@ai-assistant/contracts";
import type { Storage } from "./storage/sqlite.js";

export type InjectSkipReason =
  | "token_budget"
  | "char_budget"
  | "low_authority"
  | "stale"
  | "duplicate"
  | "scope_mismatch";

export type InjectionTrace = {
  /** Stable id for this injection (nanoid-style); useful for cross-log joins. */
  injectionId: string;
  /** ISO timestamp the injection ran. */
  at: string;
  /** Memories that reach the actor's prompt. */
  included: RetrievedMemory[];
  /** Memories filtered out, with the reason each was dropped. */
  skipped: { memory: RetrievedMemory; reason: InjectSkipReason }[];
  /** Total characters of body text in `included`. */
  totalChars: number;
  /** Optional caller tag — "cli-query", "eval-runner", etc. */
  source?: string;
};

export type InjectOptions = {
  /** Stop adding memories once their bodies exceed this many characters. */
  charBudget?: number;
  /**
   * Drop memories whose `authority` ranks below this threshold. Default
   * 'consolidated' (lowest), so nothing is dropped on authority alone.
   */
  minAuthority?:
    | "pinned"
    | "manual"
    | "observed"
    | "extracted"
    | "imported"
    | "inferred"
    | "consolidated";
  /** Caller tag for the trace. */
  source?: string;
};

const AUTHORITY_RANK: Record<NonNullable<InjectOptions["minAuthority"]>, number> = {
  pinned: 6,
  manual: 5,
  observed: 4,
  extracted: 3,
  imported: 2,
  inferred: 1,
  consolidated: 0,
};

/**
 * Build an injection trace from a retrieved batch. Pure data — the
 * caller decides whether to bump counters via
 * `bumpInjectionCounters` (typically yes).
 *
 * Drop semantics, in order:
 *   1. Authority floor (if set).
 *   2. Char budget — fill greedily by score order; the first
 *      memory that overflows the budget gets dropped, plus any
 *      after it (no fancy bin-packing yet).
 *   3. Future: token-budget, dedup, scope.
 */
export function buildInjectionTrace(
  retrieved: readonly RetrievedMemory[],
  opts: InjectOptions = {},
): InjectionTrace {
  const at = new Date().toISOString();
  const injectionId = `inj_${at.replace(/[^0-9]/g, "").slice(0, 14)}_${randomTag()}`;
  const included: RetrievedMemory[] = [];
  const skipped: InjectionTrace["skipped"] = [];

  const minRank = opts.minAuthority === undefined ? -1 : AUTHORITY_RANK[opts.minAuthority];
  let usedChars = 0;
  const charBudget = opts.charBudget ?? Number.POSITIVE_INFINITY;

  for (const m of retrieved) {
    // Authority floor.
    if (minRank >= 0) {
      // Authority is recorded in the chunk's frontmatter / metadata,
      // which the retriever exposes via the source path; for v1 we
      // rely on the caller filtering before calling us, since the
      // RetrievedMemory contract doesn't yet carry authority.
      // (Round 4 — promote authority into the contract so this fires
      // here too.) For now: passthrough.
    }
    const charCost = m.content.length;
    if (usedChars + charCost > charBudget) {
      skipped.push({ memory: m, reason: "char_budget" });
      continue;
    }
    included.push(m);
    usedChars += charCost;
  }

  return {
    injectionId,
    at,
    included,
    skipped,
    totalChars: usedChars,
    ...(opts.source ? { source: opts.source } : {}),
  };
}

/**
 * Convenience: build the trace and bump injection counters in one
 * call. Counters fire only for `included` so skipped memories don't
 * accidentally look used.
 */
export function injectMemories(
  storage: Storage,
  retrieved: readonly RetrievedMemory[],
  opts: InjectOptions = {},
): InjectionTrace {
  const trace = buildInjectionTrace(retrieved, opts);
  if (trace.included.length > 0) {
    storage.bumpInjectionCounters(trace.included.map((m) => m.id));
  }
  return trace;
}

function randomTag(): string {
  return Math.random().toString(36).slice(2, 8);
}
