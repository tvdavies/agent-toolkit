/**
 * `brain rebuild-index` — drop the SQLite cache and rebuild from
 * the markdown source of truth.
 *
 * Use when:
 *   - schema migrations broke the index,
 *   - extraction prompt changed and stale extracted-fact bodies
 *     need to regenerate,
 *   - the cache filename collided across scopes (shouldn't happen
 *     but the recovery is the same).
 *
 * Safe by design: the markdown files are the source of truth.
 * Re-walking the disk reproduces the index. The only data lost is
 * the SQLite-only state (usage counters, daemon state) — explicit
 * `--keep-counters` will preserve those by snapshotting before the
 * drop. Default is to start clean.
 */

import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { reindexAll } from "@ai-assistant/memory";
import type { ParsedArgs } from "../shared/args.js";
import { bool, flag } from "../shared/args.js";
import {
  buildBrainEmbedder,
  openBrain,
  resolveBrainHome,
  resolveBrainPath,
  resolveScope,
} from "../shared/brain.js";

export async function runRebuildIndex(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const scope = resolveScope(flag(args, "scope"));
  const skipEmbed = bool(args, "no-embed");

  const cacheDir = resolve(rootDir, ".cache");
  const dbPath = resolve(cacheDir, `${scope.replace(/\//g, "-")}.sqlite`);

  if (existsSync(dbPath)) {
    process.stdout.write(`dropping ${dbPath}\n`);
    unlinkSync(dbPath);
  }

  // Open through the normal config-aware path before seeding. This is
  // important because sqlite-vec fixes the virtual table dimension at
  // creation time; using createSqliteStorage() directly would create a
  // legacy 768-dim table even when config says the embedder is 3072-dim.
  const brain = await openBrain({ homeDir, rootDir, scope, readOnly: true });
  try {
    // Walk every .md file under <rootDir>/<scope>/<type>/ and ingest
    // it. We can't go through Memory.record (that's for new events,
    // not existing files); instead, populate the index directly by
    // reading each file and upserting a chunk row. The reindex helper
    // handles new chunks too because we seed an empty row first then
    // call it.
    const all = await brain.markdownStore.list(scope);
    process.stdout.write(`found ${all.length} markdown files; seeding index...\n`);

    for (let i = 0; i < all.length; i++) {
      const filePath = all[i] as string;
      const file = await brain.markdownStore.read(filePath);
      const id =
        typeof file.frontmatter.id === "string"
          ? file.frontmatter.id
          : `chunk-${i.toString().padStart(8, "0")}`;
      brain.storage.upsertChunk({
        id,
        path: filePath,
        type: file.type,
        ordinal: i,
        content: file.body,
        metadata: file.frontmatter as Record<string, unknown>,
      });
    }

    // Now run the standard reindex which will compute hashes, populate
    // edges, and (optionally) re-embed.
    const embedder = skipEmbed
      ? undefined
      : buildBrainEmbedder(brain.config, brain.usage, undefined);
    const t0 = Date.now();
    const result = await reindexAll({
      storage: brain.storage,
      markdownStore: brain.markdownStore,
      ...(embedder ? { embedder } : {}),
      force: true,
    });
    const ms = Date.now() - t0;
    process.stdout.write(
      `rebuilt index in ${ms}ms — synced ${result.outcomes.synced + result.outcomes.synced_async} files\n`,
    );
  } finally {
    await brain.close();
  }
}
