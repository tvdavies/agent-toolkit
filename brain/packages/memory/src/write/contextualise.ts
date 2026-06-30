/**
 * Contextual prefix builder (M5.h, Alex Phase A complement).
 *
 * Ports `apps/jeff/internal/memory/contextualise.go`. Generates a
 * 50-100 token "situating sentence" for each extracted fact via a
 * cheap LLM call, prepended to the fact body so retrieval-time
 * relevance carries the surrounding session context.
 *
 * Mirrors Anthropic's "contextual retrieval" recipe (Sep 2024).
 *
 * Disk-cached by sha256(model, sessionId, factContent) so re-running
 * an ingest doesn't pay the LLM cost twice. Cache directory mirrors
 * the existing extractor / observation / consolidation caches.
 *
 * Per Alex's plan, expected lift: +1-2pp across categories. Run-time
 * cost: 1 cheap LLM call per extracted fact (~50-100 output tokens),
 * dominated by the cache after the first ingest.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateText, type LanguageModel } from "ai";
import type { UsageMeter } from "../usage.js";

const CONTEXTUAL_PREFIX_MAX_TOKENS = 120;
const CONTEXTUAL_PREFIX_TEMPERATURE = 0;
const CONTEXTUAL_PREFIX_MARKER = "Context: ";

const SYSTEM_PROMPT = `You situate extracted memory facts inside their parent session so downstream retrieval carries the surrounding context.

Output ONE short paragraph, 50 to 100 tokens, British English. No em dashes. No lists, no headings, no preamble. Do not repeat the fact verbatim. Do not speculate. State only what the session header and the fact body already support.

Cover in order:
1. when the session happened (date / weekday) if known,
2. the broader topic or theme of the session,
3. how this specific fact sits within that session.

Start directly with the sentence. Do not prefix with "Context:" or any label.`;

export interface ContextualiserOptions {
  readonly model: LanguageModel;
  /** Model id used in the cache key — switching models invalidates entries. */
  readonly modelId: string;
  /** Optional disk cache directory. Omit to disable caching. */
  readonly cacheDir?: string;
  /** Max in-flight LLM calls. Default 12. */
  readonly concurrency?: number;
  /** Optional usage meter; records tokens for cost attribution. */
  readonly usage?: UsageMeter;
}

export interface ContextualiseInput {
  readonly factContent: string;
  /** Short session header — e.g. "Session 2024-03-15 (Mon): travel planning". */
  readonly sessionSummary: string;
  /** Stable session identifier for cache keying. */
  readonly sessionId?: string;
}

export interface Contextualiser {
  /** Returns a contextual prefix to prepend to the fact (empty when disabled / on error). */
  build(input: ContextualiseInput): Promise<string>;
  /** Apply the prefix to a fact's content with the canonical marker. Returns content unchanged when prefix is empty. */
  apply(factContent: string, prefix: string): string;
}

const DEFAULT_CONCURRENCY = 12;

export function createContextualiser(opts: ContextualiserOptions): Contextualiser {
  const concurrency = Math.min(Math.max(opts.concurrency ?? DEFAULT_CONCURRENCY, 1), 32);
  const cacheDir = opts.cacheDir;
  if (cacheDir !== undefined) mkdirSync(cacheDir, { recursive: true });

  let inFlight = 0;
  const queue: (() => void)[] = [];
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      const tryAcquire = (): void => {
        if (inFlight < concurrency) {
          inFlight++;
          resolve();
        } else {
          queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  const release = (): void => {
    inFlight--;
    const next = queue.shift();
    if (next) next();
  };

  const cachePathFor = (sessionId: string, factContent: string): string | undefined => {
    if (cacheDir === undefined) return undefined;
    const fp = createHash("sha256")
      .update(`${opts.modelId}\n${sessionId}\n${factContent}`)
      .digest("hex");
    return join(cacheDir, `${fp}.json`);
  };

  return {
    async build(input) {
      const sessionId = input.sessionId ?? "";
      const cachePath = cachePathFor(sessionId, input.factContent);
      if (cachePath !== undefined) {
        try {
          const raw = readFileSync(cachePath, "utf8");
          const parsed = JSON.parse(raw) as { prefix?: string };
          if (typeof parsed.prefix === "string") return parsed.prefix;
        } catch {
          /* cache miss; fall through to LLM */
        }
      }

      await acquire();
      try {
        const prompt = buildUserPrompt(input);
        const result = await generateText({
          model: opts.model,
          system: SYSTEM_PROMPT,
          prompt,
          temperature: CONTEXTUAL_PREFIX_TEMPERATURE,
          maxOutputTokens: CONTEXTUAL_PREFIX_MAX_TOKENS,
        });
        opts.usage?.record(
          "contextualiser",
          opts.modelId,
          result.usage?.inputTokens ?? 0,
          result.usage?.outputTokens ?? 0,
        );
        const prefix = result.text.trim();
        if (cachePath !== undefined) {
          try {
            writeFileSync(cachePath, JSON.stringify({ prefix }));
          } catch {
            /* cache write failure shouldn't fail the call */
          }
        }
        return prefix;
      } catch {
        return "";
      } finally {
        release();
      }
    },
    apply(factContent, prefix) {
      const trimmed = prefix.trim();
      if (trimmed === "") return factContent;
      return `${CONTEXTUAL_PREFIX_MARKER}${trimmed}\n\n${factContent}`;
    },
  };
}

function buildUserPrompt(input: ContextualiseInput): string {
  const header = input.sessionSummary.trim();
  const body = input.factContent.trim();
  return [
    "Session header:",
    header === "" ? "(none)" : header,
    "",
    "Extracted fact:",
    body,
    "",
    "Write the situating sentence now.",
  ].join("\n");
}
