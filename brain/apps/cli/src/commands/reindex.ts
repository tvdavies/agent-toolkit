/**
 * `brain reindex` — full sweep of the markdown store → SQLite index.
 *
 * Walks every live chunk, reads its file from disk, and reconciles
 * the index. Useful when:
 *   - the SQLite cache was deleted or got out of sync,
 *   - the user mass-edited files outside `brain` (e.g. via grep + sed),
 *   - the daemon's link-fix needs a clean slate before catching up.
 *
 * Optional `--rebuild` drops every row in `chunks` first so you get
 * a from-scratch rebuild rather than incremental reconcile. Use when
 * the schema or extraction pipeline changed and old metadata
 * shouldn't survive.
 */

import { createGatewayEmbedder, reindexAll } from "@ai-assistant/memory";
import type { ParsedArgs } from "../shared/args.js";
import { bool, flag } from "../shared/args.js";
import { openBrain, resolveBrainHome, resolveBrainPath, resolveScope } from "../shared/brain.js";

export async function runReindex(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const scope = resolveScope(flag(args, "scope"));
  const json = bool(args, "json");
  const skipEmbed = bool(args, "no-embed");

  const brain = await openBrain({ homeDir, rootDir, scope, readOnly: true });
  try {
    const embedder = skipEmbed ? undefined : createGatewayEmbedder({ usage: brain.usage });
    const t0 = Date.now();
    const result = await reindexAll({
      storage: brain.storage,
      markdownStore: brain.markdownStore,
      ...(embedder ? { embedder } : {}),
    });
    const ms = Date.now() - t0;
    if (json) {
      process.stdout.write(`${JSON.stringify({ durationMs: ms, ...result }, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      `reindex complete in ${ms}ms\n` +
        `  unchanged:  ${result.outcomes.skipped_unchanged}\n` +
        `  unindexed:  ${result.outcomes.skipped_unindexed}\n` +
        `  synced:     ${result.outcomes.synced + result.outcomes.synced_async}\n` +
        (result.failed.length > 0
          ? `  failed:     ${result.failed.length}\n${result.failed.map((p) => `    ${p}`).join("\n")}\n`
          : ""),
    );
  } finally {
    await brain.close();
  }
}
