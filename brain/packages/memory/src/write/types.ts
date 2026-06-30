/**
 * Write-strategy types.
 *
 * The Memory class buffers `record(event)` calls; on flush, it hands
 * the buffer to a `Writer` which converts events into chunks. Each
 * chunk corresponds to a markdown file the orchestrator persists at
 * `<root>/<scope>/<type>/<slug>.md`. Writers carry the
 * memory-category type and content; the orchestrator (not the
 * writer) handles disk persistence and slug generation.
 *
 *  - **Verbatim** (default): one chunk per event under `episodic/`. No LLM.
 *  - **Extraction**: groups events, extracts structured memory notes via LLM
 *    into `facts/`, `preferences/`, `events/`, `decisions/`, `context/`.
 *  - **Observation**: per-session priority-tagged summaries under `observations/`.
 *  - **Consolidation**: post-extraction aggregates under `aggregates/`.
 */

import type { SourceRef } from "@ai-assistant/contracts";
import type { MemoryType } from "../storage/markdown-store.js";

export type SourceProvenance = SourceRef & {
  title?: string;
  instanceId?: string;
  externalId?: string;
};

export type WriteEvent =
  | { kind: "user-turn"; text: string; recordedAt?: string }
  | { kind: "assistant-turn"; text: string; recordedAt?: string }
  | { kind: "ingested-item"; content: string; recordedAt?: string; source?: SourceProvenance }
  | { kind: "tool-call"; tool: string; args: unknown; result: unknown; recordedAt?: string };

export type WrittenChunk = {
  /** Optional id; the Memory class fills with nanoid if absent. */
  id?: string;
  /** Memory category — drives the on-disk directory and intent multipliers. */
  type: MemoryType;
  /** Stable in-flush ordering (not used for filename — slug is derived from content). */
  ordinal: number;
  /** Markdown body (no frontmatter — orchestrator builds frontmatter from metadata). */
  content: string;
  /** Free-form metadata flattened into frontmatter on disk + JSON in SQLite. */
  metadata?: Record<string, unknown>;
};

export type ExistingMemoryPreview = {
  id: string;
  path: string;
  type: MemoryType;
  content: string;
};

export type WriteContext = {
  /** Relevant existing memories for update/supersede-aware writers. */
  existingMemories?: readonly ExistingMemoryPreview[];
};

export interface Writer {
  /**
   * Process buffered events into chunks. May call an LLM (extraction
   * writers) or run synchronously (verbatim).
   *
   * @param events ordered buffered events from `record()`
   * @param baseOrdinal first ordinal to assign; subsequent flushes pass
   *                    higher base values so chunk ordering is stable
   *                    across flushes.
   * @param context optional retrieval context, including similar existing
   *                memories for update/supersede-aware extraction.
   */
  process(
    events: readonly WriteEvent[],
    baseOrdinal: number,
    context?: WriteContext,
  ): Promise<WrittenChunk[]>;
}

export function formatTurnEvent(e: WriteEvent): string {
  if (e.kind === "user-turn") return `user: ${e.text}`;
  if (e.kind === "assistant-turn") return `assistant: ${e.text}`;
  if (e.kind === "tool-call")
    return `tool: ${e.tool} args=${JSON.stringify(e.args)} result=${JSON.stringify(e.result)}`;
  return e.content;
}
