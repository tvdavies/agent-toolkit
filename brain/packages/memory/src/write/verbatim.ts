import { formatTurnEvent, type WriteEvent, type Writer, type WrittenChunk } from "./types.js";

/**
 * One-chunk-per-event writer. No LLM call. Same shape as our M2.a–M2.c
 * baseline; lifted into the Writer interface so other strategies
 * (extraction) compose cleanly.
 */
export const verbatimWriter: Writer = {
  async process(events, baseOrdinal): Promise<WrittenChunk[]> {
    return events.map((e: WriteEvent, i) => {
      const ordinal = baseOrdinal + i;
      const isConversationTurn = e.kind === "user-turn" || e.kind === "assistant-turn";
      const isRecallable = e.kind === "ingested-item";
      const metadata: Record<string, unknown> = {
        sourceKind: isConversationTurn
          ? "conversation-transcript"
          : e.kind === "tool-call"
            ? "tool-transcript"
            : (e.source?.kind ?? "cli-add"),
        authority: "observed",
        // Raw conversation/tool turns are archival episode material, not durable
        // semantic memory. Keep them on disk for import/debug/re-extraction, but
        // exclude them from normal recall so questions like "What is my
        // favourite food?" do not retrieve the prior question verbatim.
        recallable: isRecallable,
      };
      if (e.recordedAt !== undefined) metadata.recordedAt = e.recordedAt;
      if (e.kind === "ingested-item" && e.source !== undefined) {
        metadata.derivedFrom = [e.source.id];
        metadata.sourceUri = e.source.url;
        metadata.sourceTitle = e.source.title;
        metadata.sourceInstanceId = e.source.instanceId;
        metadata.sourceExternalId = e.source.externalId;
      }
      return {
        type: isRecallable ? "observations" : "episodic",
        ordinal,
        content: formatTurnEvent(e),
        metadata,
      };
    });
  },
};

export const VERBATIM_WRITER_ID = "verbatim";
