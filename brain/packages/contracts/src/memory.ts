import { z } from "zod";
import { EntityRef, Message, SourceRef } from "./common.js";

export const RetrievalInput = z.object({
  query: z.string(),
  /**
   * Optional ISO-8601 timestamp anchoring the query in time. When set,
   * temporal-intent queries get a recency boost on chunks recorded near
   * this date. Memory implementations that don't track recordedAt on
   * chunks are free to ignore it.
   */
  anchorDate: z.string().optional(),
  context: z
    .object({
      recentTurns: z.array(Message).optional(),
      entities: z.array(EntityRef).optional(),
    })
    .optional(),
  budget: z
    .object({
      maxItems: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .optional(),
  filters: z
    .object({
      after: z.date().optional(),
      before: z.date().optional(),
      sources: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
  /**
   * When true, skip the cross-encoder reranker for this call.
   * Implementations without a reranker ignore this. The CLI exposes
   * it as `brain query --no-rerank` for measuring the bare BM25 +
   * vector retrieval cost without the LLM round-trip.
   */
  skipReranker: z.boolean().optional(),
  /**
   * When true, skip query-time embedding and the vector search leg.
   * Falls back to BM25-only retrieval. Useful for benchmarking
   * (`brain query --no-embed`) and for offline / disconnected use
   * when the embedder backend is unreachable.
   */
  skipEmbed: z.boolean().optional(),
});
export type RetrievalInput = z.infer<typeof RetrievalInput>;

/**
 * Per-hit score breakdown so callers (the actor, `brain why`, the
 * eval harness) can see *why* a memory was retrieved at a given
 * rank — not just that it scored highly. Every multiplicative
 * boost applied during retrieval has its own field; the values are
 * the multipliers actually used (1.0 = no-op).
 *
 * `finalScore` should equal the value reported in `RetrievedMemory.score`
 * for the same item; it's duplicated into the breakdown so consumers
 * working only with the breakdown don't need a second join.
 */
export const ScoreBreakdown = z.object({
  /** Reciprocal-rank-fusion base score after combining BM25 + vector + entity legs. */
  rrfBase: z.number(),
  /** Per-source RRF contributions before fusion (BM25 fused score, vector score, entity score). */
  contributions: z.object({
    bm25: z.number().optional(),
    vector: z.number().optional(),
    entity: z.number().optional(),
  }),
  /** Cosine re-score blend (0.7·rrf + 0.3·vector). Absent when intent disables vector. */
  cosineBlend: z.number().optional(),
  /** Type multiplier from the intent classifier (e.g. ×2.35 for events on temporal). */
  typeMultiplier: z.number().optional(),
  /** Time-decay multiplier when intent.recencyBias and anchorDate are set. */
  decayMultiplier: z.number().optional(),
  /** ×1.5 boost for assistant-reference queries hitting `assistant:`-prefix chunks. */
  assistantBoost: z.number().optional(),
  /** Backlink boost: 1 + 0.05·log(1 + inboundCount + entityPopularity). */
  backlinkBoost: z.number().optional(),
  /** Authority multiplier (pinned / manual / extracted / ...). */
  authorityMultiplier: z.number().optional(),
  /** Usage multiplier from retrieval / injection / citation counters. */
  usageMultiplier: z.number().optional(),
  /** Status multiplier, e.g. superseded-memory downweight. */
  statusMultiplier: z.number().optional(),
  /** True if the cross-encoder reranker reordered this hit's window. */
  rerankerRanked: z.boolean(),
  /** Final score after every multiplier; matches `RetrievedMemory.score`. */
  finalScore: z.number(),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;

export const RetrievedMemory = z.object({
  id: z.string(),
  content: z.string(),
  source: SourceRef,
  score: z.number(),
  entities: z.array(EntityRef).default([]),
  writtenAt: z.date(),
  /** Per-hit score breakdown. Optional for backwards compatibility with callers that don't set it. */
  scoring: ScoreBreakdown.optional(),
});
export type RetrievedMemory = z.infer<typeof RetrievedMemory>;

export const RetrievalDiagnostics = z.object({
  bm25Hits: z.number().int().nonnegative(),
  vectorHits: z.number().int().nonnegative(),
  rerankerRan: z.boolean(),
  /** Number of lexical retry rungs attempted beyond the original BM25 query. */
  bm25RetryAttempts: z.number().int().nonnegative().optional(),
});
export type RetrievalDiagnostics = z.infer<typeof RetrievalDiagnostics>;

export const RetrievalResult = z.object({
  items: z.array(RetrievedMemory),
  diagnostics: RetrievalDiagnostics.optional(),
});
export type RetrievalResult = z.infer<typeof RetrievalResult>;

export const MemoryEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user-turn"),
    text: z.string(),
    /** ISO-8601 timestamp the turn occurred at, when known. */
    recordedAt: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("assistant-turn"),
    text: z.string(),
    /** ISO-8601 timestamp the turn occurred at, when known. */
    recordedAt: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("tool-call"),
    tool: z.string(),
    args: z.unknown(),
    result: z.unknown(),
  }),
  z.object({
    kind: z.literal("ingested-item"),
    source: SourceRef,
    content: z.string(),
    /** ISO-8601 timestamp of the item, when known. */
    recordedAt: z.string().optional(),
  }),
]);
export type MemoryEvent = z.infer<typeof MemoryEvent>;

export const FeedbackInput = z.object({
  answerId: z.string(),
  signal: z.enum(["thumbs-up", "thumbs-down", "correction"]),
  note: z.string().optional(),
  correction: z.string().optional(),
});
export type FeedbackInput = z.infer<typeof FeedbackInput>;

/**
 * Per-component LLM token usage accumulated by a Memory instance, for
 * cost attribution. Implementations that don't run LLM calls (or don't
 * track them) can omit this method. The eval harness reads it after
 * each question to break out spend by extractor / reranker / embedder
 * etc., so a benchmark run with OpenAI as the extractor surfaces
 * extraction cost alongside actor + judge.
 */
export type MemoryUsageEntry = {
  component: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
};

export type MemoryUsageReport = {
  entries: readonly MemoryUsageEntry[];
  totals: { inputTokens: number; outputTokens: number; calls: number };
};

/**
 * Memory implementations — our own, Jeff's Brain (as baseline), MemPalace (as baseline) —
 * conform to this. The harness never talks to a concrete memory directly.
 */
export interface Memory {
  retrieve(input: RetrievalInput): Promise<RetrievalResult>;
  /**
   * Record an event. Implementations are free to be either synchronous
   * (the full writer chain runs before this resolves — historical
   * behaviour, used by eval baselines and `--sync` mode) or
   * eventually-consistent (verbatim chunk lands and the slow writers
   * are queued for a daemon — the production CLI default once the
   * daemon path lands).
   *
   * Callers that need every chunk searchable before they exit should
   * call `flush()` afterwards.
   */
  record(event: MemoryEvent): Promise<void>;
  /**
   * Drain any pending async work owned by this Memory and the daemon
   * queue items it produced. Returns once verbatim + extracted +
   * embedded chunks for everything `record()`ed so far are searchable.
   * Implementations that run synchronously can implement this as a
   * no-op. Optional `timeoutMs` caps the wait; if the budget elapses
   * before drain completes the implementation throws and leaves the
   * queue intact for the next attempt.
   */
  flush?(opts?: { timeoutMs?: number }): Promise<void>;
  consolidate?(): Promise<void>;
  feedback?(input: FeedbackInput): Promise<void>;
  /**
   * Release any external resources (subprocesses, file handles, temp dirs).
   * Called once when the caller is done with the instance. In-memory impls
   * leave this unimplemented.
   */
  close?(): Promise<void>;
  /** Snapshot of LLM token usage attributable to this Memory instance. */
  usage?(): MemoryUsageReport;
}
