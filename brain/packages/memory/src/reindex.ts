/**
 * File → index reconciliation.
 *
 * The markdown store is the source of truth; SQLite is a derived
 * cache. When a file changes on disk (manual edit, daemon write,
 * external tool), the index has to catch up. This module owns the
 * single-file reconciliation primitive used by both `brain reindex`
 * (full sweep) and the file watcher's `brain watch` mode.
 *
 * Sync path (cheap, fires on every change):
 *   1. Read file → parse frontmatter + body.
 *   2. Compute SHA-256 of the body.
 *   3. If hash matches the indexed row, skip.
 *   4. Otherwise upsert a chunk row with new content + metadata + hash.
 *      Updates FTS5 immediately so lexical search reflects the edit.
 *
 * Async path (slower, runs after the sync path returns):
 *   5. Re-embed the body, replace the vector row.
 *   6. Re-extract typed edges, replace the outbound edge set.
 *
 * The split lets manual edits feel instant on BM25 retrieval while
 * the semantic indexes catch up shortly after.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { Embedder } from "./embedding/index.js";
import {
  createSlugResolver,
  extractFrontmatterEdges,
  extractPageEdges,
  type SlugResolver,
} from "./graph/index.js";
import { type Frontmatter, parse } from "./storage/frontmatter.js";
import { type MarkdownStore, pathDescriptor } from "./storage/markdown-store.js";
import { type Edge, hashContent, type Storage } from "./storage/sqlite.js";

export type ReindexOutcome =
  | "skipped_unchanged"
  | "skipped_unindexed"
  | "synced"
  | "synced_async"
  | "ingested_orphan";

export type ReindexResult = {
  filePath: string;
  outcome: ReindexOutcome;
  /** Sha-256 of the body after re-index. */
  contentHash: string;
};

export type ReindexOptions = {
  storage: Storage;
  markdownStore: MarkdownStore;
  /** Optional embedder; when omitted, the chunk's vector row is left alone. */
  embedder?: Embedder;
  /** Resolver shared across a sweep so wikilinks resolve consistently. */
  resolver?: SlugResolver;
  /** Recompute metadata, embeddings, and edges even when content hash matches. */
  force?: boolean;
};

/**
 * Reconcile a single file with the index. Returns a result with the
 * outcome so callers (the watcher's per-file logger) can summarise
 * activity without doing their own diffing.
 */
export async function reindexFile(filePath: string, opts: ReindexOptions): Promise<ReindexResult> {
  const text = await readFile(filePath, "utf8");
  const { frontmatter, body } = parse(text);
  const newHash = hashContent(body);

  const existing = opts.storage.getChunkByPath(filePath);
  if (existing === undefined) {
    // The watcher saw a file that's not in the index. Could be a
    // hand-created file before it's been ingested, or a stray .md
    // outside the canonical scope/type structure. Surface as
    // skipped_unindexed so the caller can decide whether to ingest it.
    return { filePath, outcome: "skipped_unindexed", contentHash: newHash };
  }
  const { type, slug } = pathDescriptor(opts.markdownStore.rootDir, filePath);
  const scope = scopeForFile(opts.markdownStore.rootDir, filePath);
  if (scope !== undefined) opts.storage.upsertSlug(scope, slug, existing.id);
  const metadata = frontmatterToMetadata(frontmatter, existing.metadata);
  const entities = Array.isArray(metadata.entities)
    ? metadata.entities.filter((e): e is string => typeof e === "string")
    : [];
  opts.storage.upsertChunkEntities(existing.id, entities);

  if (!opts.force && existing.contentHash === newHash) {
    return { filePath, outcome: "skipped_unchanged", contentHash: newHash };
  }

  const embedding = opts.embedder ? (await opts.embedder.embed([body]))[0] : undefined;
  opts.storage.upsertChunk({
    id: existing.id,
    path: filePath,
    type,
    ordinal: existing.ordinal,
    content: body,
    contentHash: newHash,
    metadata,
    ...(embedding !== undefined ? { embedding } : {}),
  });

  // Replace outbound edges to reflect the new body.
  const resolver = opts.resolver ?? createSlugResolver();
  if (opts.resolver === undefined) resolver.register(slug, existing.id);
  const topics = Array.isArray(metadata.topics)
    ? metadata.topics.filter((t): t is string => typeof t === "string")
    : [];
  const edges: Edge[] = [
    ...extractPageEdges({
      fromChunkId: existing.id,
      body,
      type,
      entities,
      resolveSlug: (s, sc) => resolver.resolve(s, sc),
    }),
  ];
  if (entities.length > 0 || topics.length > 0) {
    edges.push(
      ...extractFrontmatterEdges({
        fromChunkId: existing.id,
        frontmatter: {
          ...(entities.length > 0 ? { entities } : {}),
          ...(topics.length > 0 ? { topics } : {}),
        },
        resolveSlug: (s, sc) => resolver.resolve(s, sc),
      }),
    );
  }
  opts.storage.replaceOutboundEdges(existing.id, edges);

  return {
    filePath,
    outcome: opts.embedder ? "synced_async" : "synced",
    contentHash: newHash,
  };
}

/**
 * Walk every live chunk's file path and reconcile each, then sweep
 * the filesystem for orphan markdown files (on disk but not in the
 * index) and ingest them. Used by `brain reindex` to rebuild the
 * index from disk in one pass. Returns a summary of outcomes.
 *
 * The orphan sweep heals files that the write pipeline left behind
 * after a crash between `markdownStore.write()` and
 * `storage.upsertChunks()` (BRAIN-180). Without it, only the nuclear
 * `brain rebuild-index` (which drops the SQLite cache) recovers
 * them.
 */
export async function reindexAll(
  opts: ReindexOptions,
): Promise<{ outcomes: Record<ReindexOutcome, number>; failed: string[] }> {
  const out: Record<ReindexOutcome, number> = {
    skipped_unchanged: 0,
    skipped_unindexed: 0,
    synced: 0,
    synced_async: 0,
    ingested_orphan: 0,
  };
  const failed: string[] = [];
  // Build a slug-resolver up front so cross-file wikilinks resolve.
  const resolver = createSlugResolver();
  const all = opts.storage.listLiveChunks();
  for (const c of all) {
    const slug = c.path.split("/").pop()?.replace(/\.md$/, "");
    if (slug) resolver.register(slug, c.id);
  }
  for (const c of all) {
    try {
      const r = await reindexFile(c.path, { ...opts, resolver });
      out[r.outcome] += 1;
    } catch (err) {
      failed.push(c.path);
      void err;
    }
  }

  // Orphan sweep: any .md file under the markdown root that isn't
  // already in the index is a crash residue (or a hand-created file
  // outside the normal write path). Ingest it so the index reflects
  // disk-truth without requiring `brain rebuild-index`.
  const indexed = new Set(all.map((c) => c.path));
  const orphans = await listMarkdownFiles(opts.markdownStore.rootDir);
  for (const filePath of orphans) {
    if (indexed.has(filePath)) continue;
    try {
      await ingestOrphan(filePath, { ...opts, resolver });
      out.ingested_orphan += 1;
    } catch (err) {
      failed.push(filePath);
      void err;
    }
  }

  return { outcomes: out, failed };
}

/**
 * Ingest a single orphan .md file: read, parse, mint or reuse an id,
 * upsert into storage, populate entity/slug indexes, extract edges,
 * and re-embed if an embedder is configured.
 */
async function ingestOrphan(
  filePath: string,
  opts: ReindexOptions & { resolver: SlugResolver },
): Promise<void> {
  const { type, slug } = pathDescriptor(opts.markdownStore.rootDir, filePath);
  const scope = scopeForFile(opts.markdownStore.rootDir, filePath);
  const text = await readFile(filePath, "utf8");
  const { frontmatter, body } = parse(text);
  const id =
    typeof frontmatter.id === "string" && frontmatter.id.length > 0 ? frontmatter.id : nanoid();
  const contentHash = hashContent(body);
  const metadata = frontmatterToMetadata(frontmatter, undefined);
  const entities = Array.isArray(metadata.entities)
    ? metadata.entities.filter((e): e is string => typeof e === "string")
    : [];
  const topics = Array.isArray(metadata.topics)
    ? metadata.topics.filter((t): t is string => typeof t === "string")
    : [];
  const embedding = opts.embedder ? (await opts.embedder.embed([body]))[0] : undefined;
  opts.storage.upsertChunk({
    id,
    path: filePath,
    type,
    ordinal: 0,
    content: body,
    contentHash,
    metadata,
    ...(embedding !== undefined ? { embedding } : {}),
  });
  opts.storage.upsertChunkEntities(id, entities);
  if (scope !== undefined) opts.storage.upsertSlug(scope, slug, id);
  opts.resolver.register(slug, id);
  const edges: Edge[] = extractPageEdges({
    fromChunkId: id,
    body,
    type,
    entities,
    resolveSlug: (s, sc) => opts.resolver.resolve(s, sc),
  });
  if (entities.length > 0 || topics.length > 0) {
    edges.push(
      ...extractFrontmatterEdges({
        fromChunkId: id,
        frontmatter: {
          ...(entities.length > 0 ? { entities } : {}),
          ...(topics.length > 0 ? { topics } : {}),
        },
        resolveSlug: (s, sc) => opts.resolver.resolve(s, sc),
      }),
    );
  }
  opts.storage.replaceOutboundEdges(id, edges);
}

/**
 * Recursively walk `rootDir` for `.md` files that match the canonical
 * `<scope>/<type>/<slug>.md` shape. Skip `.cache/` and dotfile-style
 * directories so editor cruft / sqlite caches don't get picked up.
 */
async function listMarkdownFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        // Confirm the path matches <scope>/<type>/<slug>.md before
        // including it. pathDescriptor throws on the wrong shape;
        // catching keeps stray markdown elsewhere in the tree out of
        // the ingest set.
        try {
          pathDescriptor(rootDir, fullPath);
          out.push(fullPath);
        } catch {
          // not in the canonical layout; ignore.
        }
      }
    }
  }
  await walk(rootDir);
  return out;
}

/**
 * Pull metadata fields out of the parsed frontmatter, falling back
 * to the indexed metadata for fields we expect to persist (id, etc).
 * Frontmatter is canonical for everything except the chunk id and
 * ordinal (which the orchestrator owns).
 */
function scopeForFile(rootDir: string, filePath: string): string | undefined {
  const rel = filePath.startsWith(rootDir)
    ? filePath.slice(rootDir.length).replace(/^\/+/, "")
    : filePath;
  const parts = rel.split("/").filter((p) => p !== "");
  if (parts.length < 3) return undefined;
  return parts.slice(0, -2).join("/");
}

function frontmatterToMetadata(
  frontmatter: Frontmatter,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const fm: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(frontmatter)) {
    // Skip fields the index owns rather than the frontmatter.
    if (key === "id" || key === "type") continue;
    fm[key] = value;
  }
  return fm;
}
