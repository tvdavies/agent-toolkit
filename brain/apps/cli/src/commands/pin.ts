/**
 * `brain pin <slug>` — promote a memory to `authority: pinned`.
 *
 * Pinned memories outweigh extracted/inferred ones during retrieval
 * (×3.0 boost). Use for "facts the brain must never forget" — your
 * birthday, your spouse's preferences, the company's mission
 * statement.
 *
 * Implementation: rewrite the file's YAML frontmatter to set
 * `authority: pinned`, leaving the body untouched. The next reindex
 * (manual or via `brain watch`) picks up the change. We don't go
 * through the index here so the markdown stays the source of truth.
 *
 * `--unpin` reverses to `authority: manual` (next-highest tier; the
 * user clearly cared about this memory). `--authority <level>` sets
 * an explicit value.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { type Frontmatter, parse, serialise } from "@ai-assistant/memory";
import type { ParsedArgs } from "../shared/args.js";
import { bool, flag } from "../shared/args.js";
import { resolveBrainPath, resolveScope } from "../shared/brain.js";
import { resolveSlugPath } from "./get.js";

const VALID_LEVELS = new Set([
  "pinned",
  "manual",
  "observed",
  "extracted",
  "imported",
  "inferred",
  "consolidated",
]);

export async function runPin(args: ParsedArgs): Promise<void> {
  const slug = args.positional[0];
  if (slug === undefined || slug === "") {
    process.stderr.write("Usage: brain pin <slug> [--unpin | --authority <level>]\n");
    process.exit(2);
  }
  const rootDir = resolveBrainPath(flag(args, "root"));
  const scope = resolveScope(flag(args, "scope"));
  const unpin = bool(args, "unpin");
  const explicit = flag(args, "authority");
  const target = explicit ?? (unpin ? "manual" : "pinned");
  if (!VALID_LEVELS.has(target)) {
    process.stderr.write(`Invalid authority "${target}". Valid: ${[...VALID_LEVELS].join(", ")}\n`);
    process.exit(2);
  }

  const filePath = resolveSlugPath(rootDir, scope, slug);
  if (filePath === undefined) {
    process.stderr.write(`No memory matches "${slug}"\n`);
    process.exit(1);
  }

  const text = readFileSync(filePath, "utf8");
  const { frontmatter, body } = parse(text);
  const updated: Frontmatter = { ...frontmatter, authority: target };
  writeFileSync(filePath, serialise(updated, body));

  process.stdout.write(
    `set authority="${target}" on ${slug}\n  file: ${filePath}\n  hint: brain reindex (or run `,
  );
  process.stdout.write(`brain watch in another tab) to update the index\n`);
}
