/**
 * Loader for the patterns phase. Pulls recent `reflections/*` chunks
 * (synthesise output) within a lookback window.
 *
 * Reflections themselves are daemon-emitted (by `synthesise`) — we
 * intentionally CONSUME them here. What we skip is `patterns/*`
 * pages from a previous patterns run, which would also carry the
 * `daemon-*` origin tag if they leaked into reflections via wrong
 * filtering. The type filter (`reflections` only) already protects
 * against that, but we belt-and-braces the origin check below in
 * case a future writer crosses the lines.
 */

import type { PhaseContext, ReflectionInput } from "@ai-assistant/memory";

export async function loadRecentReflections(
  ctx: PhaseContext,
  opts: { lookbackDays?: number; limit?: number } = {},
): Promise<ReflectionInput[]> {
  const limit = opts.limit ?? 50;
  const cutoff = ctx.now() - (opts.lookbackDays ?? 30) * 24 * 60 * 60 * 1000;
  return ctx.storage
    .listLiveChunks()
    .filter((c) => c.type === "reflections")
    .filter((c) => {
      // Allow daemon-reflect output (that's what we read), but refuse
      // anything tagged daemon-patterns so a misfiled patterns page
      // can't silently re-enter the loop. Older brains may still have
      // daemon-synthesize reflection pages from before synthesize was
      // split from reflect.
      const origin = c.metadata?.origin;
      return (
        typeof origin !== "string" || origin === "daemon-reflect" || origin === "daemon-synthesize"
      );
    })
    .filter((c) => {
      const recordedAt =
        typeof c.metadata?.recordedAt === "string" ? Date.parse(c.metadata.recordedAt) : NaN;
      return Number.isNaN(recordedAt) ? true : recordedAt >= cutoff;
    })
    .slice(-limit)
    .map((c) => ({
      id: c.id,
      body: c.content,
      ...(typeof c.metadata?.recordedAt === "string" ? { recordedAt: c.metadata.recordedAt } : {}),
    }));
}
