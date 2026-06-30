import type { Memory, MemoryEvent, RetrievalInput, RetrievalResult } from "@ai-assistant/contracts";

/**
 * M0 placeholder. Accepts writes, retrieves nothing, doesn't extract.
 * Replaced by the real memory package at M2 (docs/systems/phase-1-mvp.md).
 */
export class StubMemory implements Memory {
  private readonly events: MemoryEvent[] = [];

  async retrieve(_input: RetrievalInput): Promise<RetrievalResult> {
    return {
      items: [],
      diagnostics: { bm25Hits: 0, vectorHits: 0, rerankerRan: false },
    };
  }

  async record(event: MemoryEvent): Promise<void> {
    this.events.push(event);
  }

  /** Inspection helper for tests. Not part of the Memory contract. */
  snapshot(): readonly MemoryEvent[] {
    return this.events;
  }
}
