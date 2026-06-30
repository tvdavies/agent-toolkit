import type { Writer, WrittenChunk } from "./types.js";

export const proceduralWriter: Writer = {
  async process(events, baseOrdinal): Promise<WrittenChunk[]> {
    const chunks: WrittenChunk[] = [];
    let offset = 0;
    for (const e of events) {
      if (e.kind !== "tool-call") continue;
      const ok = classifyOutcome(e.result);
      chunks.push({
        type: "procedural",
        ordinal: baseOrdinal + offset++,
        content: `Tool workflow: used ${e.tool} with outcome ${ok}.\nArgs: ${safeJson(e.args)}\nResult: ${safeJson(e.result).slice(0, 800)}`,
        metadata: {
          kind: "tool-workflow",
          tool: e.tool,
          outcome: ok,
          sourceKind: "procedural-extraction",
          authority: "observed",
          ...(e.recordedAt !== undefined ? { recordedAt: e.recordedAt } : {}),
        },
      });
    }
    return chunks;
  },
};

function classifyOutcome(result: unknown): "ok" | "error" | "partial" {
  const text = typeof result === "string" ? result : safeJson(result);
  if (/\b(error|failed|exception|traceback)\b/i.test(text)) return "error";
  if (/\b(partial|skipped|warning)\b/i.test(text)) return "partial";
  return "ok";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
