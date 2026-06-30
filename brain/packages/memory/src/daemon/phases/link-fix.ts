/**
 * Link-fix phase. Walks every live chunk, re-runs the link
 * inferrer + frontmatter-edge extractor against its current body,
 * and replaces the outbound edge set in one transaction. Catches:
 *
 *   - Body edits made on disk that the index didn't see.
 *   - Regex-bank changes since the original write.
 *   - New chunks landed since last cycle that change the resolver
 *     output for older bodies (a stale `[[wedding-…]]` link now
 *     resolves to a real chunk).
 *
 * Idempotent: same body + same regex bank = same edge set. Safe to
 * run on every cycle; cheap (~1ms per chunk for the regex pass).
 */

import {
  createSlugResolver,
  extractFrontmatterEdges,
  extractPageEdges,
} from "../../graph/index.js";
import type { MemoryType } from "../../storage/markdown-store.js";
import type { Edge } from "../../storage/sqlite.js";
import type { Phase, PhaseResult } from "../types.js";

export const linkFixPhase: Phase = {
  name: "link-fix",
  cooldownMs: 0,
  async run(ctx) {
    const t0 = ctx.now();
    const chunks = ctx.storage.listLiveChunks();
    if (chunks.length === 0) {
      return phaseOk("link-fix", "no_chunks", { reconciled: 0 }, ctx.now() - t0);
    }

    // Seed the resolver from disk file paths so wikilinks resolve to
    // real chunk ids when targets exist.
    const resolver = createSlugResolver();
    for (const c of chunks) {
      const slug = c.path.split("/").pop()?.replace(/\.md$/, "");
      if (slug) resolver.register(slug, c.id);
    }

    let reconciled = 0;
    let totalEdges = 0;
    for (const c of chunks) {
      const edges: Edge[] = [];
      // Re-extract from on-disk markdown if available so daemon-time
      // edits to the file are picked up. Falls back to the indexed
      // body for in-memory tests.
      let body = c.content;
      let frontmatterEntities: string[] = [];
      let frontmatterTopics: string[] = [];
      try {
        const file = await ctx.markdownStore.read(c.path);
        body = file.body;
        const ents = file.frontmatter.entities;
        if (Array.isArray(ents)) {
          frontmatterEntities = ents.filter((e): e is string => typeof e === "string");
        }
        const tops = file.frontmatter.topics;
        if (Array.isArray(tops)) {
          frontmatterTopics = tops.filter((t): t is string => typeof t === "string");
        }
      } catch {
        // Fall back to in-memory metadata if disk read fails.
        const meta = c.metadata ?? {};
        if (Array.isArray(meta.entities)) {
          frontmatterEntities = meta.entities.filter((e): e is string => typeof e === "string");
        }
        if (Array.isArray(meta.topics)) {
          frontmatterTopics = meta.topics.filter((t): t is string => typeof t === "string");
        }
      }

      edges.push(
        ...extractPageEdges({
          fromChunkId: c.id,
          body,
          type: c.type as MemoryType,
          entities: frontmatterEntities,
          resolveSlug: (slug, scope) => resolver.resolve(slug, scope),
        }),
      );
      const fmForEdges = {
        ...(frontmatterEntities.length > 0 ? { entities: frontmatterEntities } : {}),
        ...(frontmatterTopics.length > 0 ? { topics: frontmatterTopics } : {}),
      };
      if (Object.keys(fmForEdges).length > 0) {
        edges.push(
          ...extractFrontmatterEdges({
            fromChunkId: c.id,
            frontmatter: fmForEdges,
            resolveSlug: (slug, scope) => resolver.resolve(slug, scope),
          }),
        );
      }
      if (!ctx.dryRun) {
        ctx.storage.replaceOutboundEdges(c.id, edges);
      }
      totalEdges += edges.length;
      reconciled++;
    }

    return phaseOk(
      "link-fix",
      `reconciled ${reconciled} chunks → ${totalEdges} edges`,
      { reconciled, totalEdges },
      ctx.now() - t0,
    );
  },
};

function phaseOk(
  phase: string,
  message: string,
  stats: Record<string, unknown>,
  durationMs: number,
): PhaseResult {
  return { phase, status: "ok", message, stats, durationMs };
}
