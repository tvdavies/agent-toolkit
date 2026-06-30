/**
 * `brain ls [type]` — list memories under the brain.
 *
 * Without an argument, lists across all types. With one positional
 * (e.g. `brain ls facts`), filters to that type. Output format:
 * relative slug per line, sorted; `--json` produces structured
 * output with sizes + modification times.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { MEMORY_TYPES, type MemoryType } from "@ai-assistant/memory";
import type { ParsedArgs } from "../shared/args.js";
import { bool, flag } from "../shared/args.js";
import { resolveBrainPath, resolveScope } from "../shared/brain.js";

type Entry = { type: MemoryType; slug: string; path: string; bytes: number; mtimeMs: number };

export async function runLs(args: ParsedArgs): Promise<void> {
  const rootDir = resolveBrainPath(flag(args, "root"));
  const scope = resolveScope(flag(args, "scope"));
  const json = bool(args, "json");
  const filter = args.positional[0] as MemoryType | undefined;

  if (filter !== undefined && !MEMORY_TYPES.includes(filter)) {
    process.stderr.write(`Unknown memory type "${filter}". Valid: ${MEMORY_TYPES.join(", ")}\n`);
    process.exit(2);
  }

  const types = filter ? [filter] : MEMORY_TYPES;
  const entries: Entry[] = [];
  for (const type of types) {
    const dir = resolve(rootDir, scope, type);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const path = resolve(dir, name);
      const st = statSync(path);
      entries.push({
        type,
        slug: name.replace(/\.md$/, ""),
        path,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.slug.localeCompare(b.slug) : a.type.localeCompare(b.type),
  );

  if (json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return;
  }
  if (entries.length === 0) {
    process.stdout.write(filter ? `(no ${filter} yet)\n` : "(brain is empty)\n");
    return;
  }
  let currentType = "";
  for (const e of entries) {
    if (e.type !== currentType) {
      if (currentType !== "") process.stdout.write("\n");
      process.stdout.write(`${e.type}/\n`);
      currentType = e.type;
    }
    process.stdout.write(`  ${e.slug}\n`);
  }
}
