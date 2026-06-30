/**
 * `brain restore <slug>` — undo a soft-delete.
 *
 * Clears `deleted_at` and `archive_expires_at` so the chunk is
 * once again searchable. No-op if the chunk wasn't archived.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import type { ParsedArgs } from "../shared/args.js";
import { flag } from "../shared/args.js";
import { resolveBrainPath, resolveScope } from "../shared/brain.js";
import { resolveSlugPath } from "./get.js";

export async function runRestore(args: ParsedArgs): Promise<void> {
  const slug = args.positional[0];
  if (slug === undefined || slug === "") {
    process.stderr.write("Usage: brain restore <slug>\n");
    process.exit(2);
  }

  const rootDir = resolveBrainPath(flag(args, "root"));
  const scope = resolveScope(flag(args, "scope"));

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
      process.stderr.write(`Index has no row for ${filePath}\n`);
      process.exit(1);
    }
    const r = db
      .prepare<unknown, [string]>(
        "UPDATE chunks SET deleted_at = NULL, archive_expires_at = NULL WHERE id = ?",
      )
      .run(row.id);
    if ((r.changes ?? 0) === 0) {
      process.stdout.write(`${slug} was not archived; nothing to do\n`);
      return;
    }
    process.stdout.write(`restored ${slug}\n`);
  } finally {
    db.close();
  }
}
