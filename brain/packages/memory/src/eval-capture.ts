/**
 * Eval-capture wrapper (port of GBrain's BrainBench-Real).
 *
 * Wraps a `Memory` so every `retrieve()` call records a PII-scrubbed
 * row to a JSONL file: query text, anchor date, retrieved file paths,
 * top-K scores, latency. The captured stream is the regression-test
 * input — replay each query against a code-changed Memory, compare
 * retrieved paths via Jaccard@k, top-1 stability, and latency Δ to
 * detect silent retrieval drift.
 *
 * Off by default. The eval harness opts in by setting
 * `EVAL_CAPTURE_FILE=…` in env or by constructing the wrapper
 * explicitly. Capture is best-effort — exceptions never break the
 * caller's `retrieve()` path.
 *
 * For the local LongMemEval workflow each Memory is per-question and
 * regenerated from cache, so capture is mostly useful for the
 * production brain (and for the daemon-introduces-regression
 * scenario). The wrapper is provider-agnostic and works on any
 * `Memory` that exposes `retrieve()`.
 */

import { appendFileSync } from "node:fs";
import type { Memory, RetrievalInput, RetrievalResult } from "@ai-assistant/contracts";

export type EvalCaptureRow = {
  /** ISO timestamp of the call. */
  capturedAt: string;
  /** The query string after PII scrubbing. */
  query: string;
  /** Anchor date forwarded to Memory.retrieve, when set. */
  anchorDate?: string;
  /**
   * Retrieved item file paths in retrieval order. Used as the
   * comparison key on replay (Jaccard@k between two snapshots).
   */
  paths: string[];
  /** Per-hit fused score, parallel to `paths`. */
  scores: number[];
  /** Wall-clock retrieve() latency in ms. */
  latencyMs: number;
  /** Number of items retrieved (= paths.length). */
  retrievedItems: number;
};

export type EvalCaptureSink = {
  write(row: EvalCaptureRow): void;
};

export type WrapMemoryForCaptureOpts = {
  sink: EvalCaptureSink;
  /** Override the default scrubber. */
  scrub?: (text: string) => string;
};

/**
 * Decorate a Memory so `retrieve()` calls land in `sink`. The
 * underlying memory is unchanged; capture is best-effort and never
 * masks errors.
 */
export function wrapMemoryForCapture(memory: Memory, opts: WrapMemoryForCaptureOpts): Memory {
  const scrub = opts.scrub ?? scrubPii;
  return {
    ...memory,
    record: memory.record.bind(memory),
    retrieve: async (input: RetrievalInput): Promise<RetrievalResult> => {
      const started = Date.now();
      const result = await memory.retrieve(input);
      const latencyMs = Date.now() - started;
      try {
        opts.sink.write({
          capturedAt: new Date().toISOString(),
          query: scrub(input.query),
          ...(input.anchorDate !== undefined ? { anchorDate: input.anchorDate } : {}),
          paths: result.items.map((i) => i.source.id),
          scores: result.items.map((i) => i.score),
          latencyMs,
          retrievedItems: result.items.length,
        });
      } catch {
        // capture is best-effort — silently swallow.
      }
      return result;
    },
    close: memory.close?.bind(memory),
    consolidate: memory.consolidate?.bind(memory),
    feedback: memory.feedback?.bind(memory),
    usage: memory.usage?.bind(memory),
  };
}

/**
 * JSONL file sink. Appends one row per call.
 */
export function createJsonlSink(filePath: string): EvalCaptureSink {
  return {
    write(row) {
      appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
    },
  };
}

// ── PII scrubber ─────────────────────────────────────────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d{2,4}[\s-]?\d{2,4}[\s-]?\d{2,5}/g;
// Conservative SSN-style + UK NI number patterns.
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// Long digit sequences (likely card numbers, IDs, account numbers).
const LONG_DIGIT_RE = /\b\d{12,}\b/g;

/**
 * Replace likely-identifying tokens with shape-preserving placeholders.
 * Conservative by design — we'd rather over-keep prose than leak names.
 * Names are NOT scrubbed (proper nouns are central to retrieval); the
 * caller can supply a custom scrubber if they need stricter privacy.
 */
export function scrubPii(text: string): string {
  return text
    .replace(EMAIL_RE, "[EMAIL]")
    .replace(SSN_RE, "[SSN]")
    .replace(LONG_DIGIT_RE, "[NUMBER]")
    .replace(PHONE_RE, (match) => {
      // Phone regex is greedy; only redact if the match has 7+ digits
      // (avoids mangling years like "2024" or short ordinals).
      const digits = match.replace(/\D/g, "");
      return digits.length >= 7 ? "[PHONE]" : match;
    });
}

// ── Replay metrics ───────────────────────────────────────────

export type ReplayMetric = {
  /** Jaccard@k between captured and replayed top-k path sets, averaged across queries. */
  meanJaccardAtK: number;
  /** Fraction of queries where the captured top-1 still appears at top-1 after replay. */
  top1Stability: number;
  /** Mean replay latency minus mean capture latency (ms). Positive = slower. */
  latencyDeltaMs: number;
  /** Number of (captured, replayed) pairs evaluated. */
  comparedQueries: number;
};

/**
 * Compute Jaccard@k + top-1 stability + latency Δ between two
 * parallel arrays of retrieval rows. Skips pairs where either side
 * has no retrieved items. Pure data; the caller is responsible for
 * loading the JSONL files in matching order.
 */
export function computeReplayMetrics(
  captured: readonly EvalCaptureRow[],
  replayed: readonly EvalCaptureRow[],
  k = 5,
): ReplayMetric {
  const n = Math.min(captured.length, replayed.length);
  let jaccardSum = 0;
  let top1Hits = 0;
  let capLatencyTotal = 0;
  let replayLatencyTotal = 0;
  let compared = 0;
  for (let i = 0; i < n; i++) {
    const a = captured[i];
    const b = replayed[i];
    if (a === undefined || b === undefined) continue;
    if (a.paths.length === 0 || b.paths.length === 0) continue;
    const aTop = new Set(a.paths.slice(0, k));
    const bTop = new Set(b.paths.slice(0, k));
    let intersection = 0;
    for (const p of aTop) if (bTop.has(p)) intersection++;
    const union = new Set<string>([...aTop, ...bTop]).size;
    jaccardSum += union === 0 ? 1 : intersection / union;
    if (a.paths[0] !== undefined && a.paths[0] === b.paths[0]) top1Hits++;
    capLatencyTotal += a.latencyMs;
    replayLatencyTotal += b.latencyMs;
    compared++;
  }
  return {
    meanJaccardAtK: compared === 0 ? 0 : jaccardSum / compared,
    top1Stability: compared === 0 ? 0 : top1Hits / compared,
    latencyDeltaMs: compared === 0 ? 0 : replayLatencyTotal / compared - capLatencyTotal / compared,
    comparedQueries: compared,
  };
}

/**
 * Parse a JSONL file produced by `createJsonlSink`. Skips malformed
 * lines silently. Caller is responsible for the file existing.
 */
export function parseCaptureJsonl(text: string): EvalCaptureRow[] {
  const out: EvalCaptureRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as EvalCaptureRow;
      if (typeof parsed.query === "string" && Array.isArray(parsed.paths)) {
        out.push(parsed);
      }
    } catch {
      // tolerate malformed lines.
    }
  }
  return out;
}
