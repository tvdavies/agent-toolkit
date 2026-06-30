/**
 * `brain rm <slug>` — soft-delete a memory.
 *
 * Stamps `deleted_at` in the SQLite index so the chunk vanishes
 * from search; the markdown file stays on disk for the recovery
 * window (default 30 days). Use `brain restore <slug>` to undo,
 * or `--purge` to skip the recovery window and drop immediately.
 */

import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { ParsedArgs } from "../shared/args.js";
import { bool, flag } from "../shared/args.js";
import { resolveBrainPath, resolveScope } from "../shared/brain.js";
import { resolveSlugPath } from "./get.js";

export async function runRm(args: ParsedArgs): Promise<void> {
  const slug = args.positional[0];
  if (slug === undefined || slug === "") {
    process.stderr.write("Usage: brain rm <slug>\n");
    process.exit(2);
  }

  const rootDir = resolveBrainPath(flag(args, "root"));
  const scope = resolveScope(flag(args, "scope"));
  const purge = bool(args, "purge");

  const filePath = resolveSlugPath(rootDir, scope, slug);
  if (filePath === undefined) {
    process.stderr.write(`No memory matches "${slug}"\n`);
    process.exit(1);
  }

  const dbPath = resolve(rootDir, ".cache", `${scope.replace(/\//g, "-")}.sqlite`);
  const db = new Database(dbPath);
  try {
    const row = db
      .prepare<{ id: string }, [string]>("SELECT id FROM chunks WHERE path = ?")
      .get(filePath);
    if (row === null) {
      process.stderr.write(`Index has no row for ${filePath}; deleting file only\n`);
      if (purge) unlinkSync(filePath);
      return;
    }
    if (purge) {
      // Drop the row + the file. Edges from this chunk go with it
      // via the next daemon link-fix; we don't cascade them here so
      // a daemon-driven purge sweep stays the canonical cleanup
      // path.
      db.prepare<unknown, [string]>("DELETE FROM chunks WHERE id = ?").run(row.id);
      unlinkSync(filePath);
      process.stdout.write(`purged ${slug}\n`);
    } else {
      const now = Date.now();
      const expires = now + 30 * 24 * 60 * 60 * 1000;
      db.prepare<unknown, [number, number, string]>(
        "UPDATE chunks SET deleted_at = ?, archive_expires_at = ? WHERE id = ?",
      ).run(now, expires, row.id);
      process.stdout.write(
        `archived ${slug}\n  recovery window: 30 days (until ${new Date(expires).toISOString()})\n  restore: brain restore ${slug}\n`,
      );
    }
  } finally {
    db.close();
  }
}
