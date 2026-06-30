/**
 * `brain get <slug>` — print one memory file.
 *
 * Slug can be `<type>/<slug>` (e.g. `facts/likes-decaf`) or just
 * `<slug>` (we'll search across types). With `--path`, prints the
 * absolute file path instead of the body.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MEMORY_TYPES } from "@ai-assistant/memory";
import type { ParsedArgs } from "../shared/args.js";
import { bool, flag } from "../shared/args.js";
import { resolveBrainPath, resolveScope } from "../shared/brain.js";

export async function runGet(args: ParsedArgs): Promise<void> {
  const slug = args.positional[0];
  if (slug === undefined || slug === "") {
    process.stderr.write("Usage: brain get <slug | type/slug>\n");
    process.exit(2);
  }

  const rootDir = resolveBrainPath(flag(args, "root"));
  const scope = resolveScope(flag(args, "scope"));
  const showPath = bool(args, "path");

  const filePath = resolveSlugPath(rootDir, scope, slug);
  if (filePath === undefined) {
    process.stderr.write(`No memory matches "${slug}" under ${rootDir}/${scope}\n`);
    process.exit(1);
  }
  if (showPath) {
    process.stdout.write(`${filePath}\n`);
    return;
  }
  process.stdout.write(readFileSync(filePath, "utf8"));
}

export function resolveSlugPath(rootDir: string, scope: string, slug: string): string | undefined {
  // Already qualified as type/slug.
  if (slug.includes("/")) {
    const path = resolve(rootDir, scope, `${slug}.md`);
    return existsSync(path) ? path : undefined;
  }
  // Search across all type directories.
  for (const type of MEMORY_TYPES) {
    const path = resolve(rootDir, scope, type, `${slug}.md`);
    if (existsSync(path)) return path;
  }
  return undefined;
}
