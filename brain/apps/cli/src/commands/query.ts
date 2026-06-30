/**
 * `brain query <text>` — search the brain.
 *
 * Mirrors the eval harness's Chain-of-Note formatter so what the
 * CLI shows is what an LLM actor would see. With `--json`, dumps
 * the raw RetrievalResult for piping into other tools.
 */

import type { RetrievalResult } from "@ai-assistant/contracts";
import type { ParsedArgs } from "../shared/args.js";
import { bool, flag, intFlag } from "../shared/args.js";
import { openBrain, resolveBrainHome, resolveBrainPath, resolveScope } from "../shared/brain.js";

export async function runQuery(args: ParsedArgs): Promise<void> {
  const queryText = args.positional.join(" ").trim();
  if (queryText === "") {
    process.stderr.write("Usage: brain query <text>\n");
    process.exit(2);
  }

  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const scope = resolveScope(flag(args, "scope"));
  const limit = intFlag(args, "limit", 5);
  const json = bool(args, "json");
  const format = flag(args, "format");
  const anchorDate = flag(args, "date");
  const noRerank = bool(args, "no-rerank");
  const noEmbed = bool(args, "no-embed");

  const brain = await openBrain({ homeDir, rootDir, scope, readOnly: true });
  try {
    const result = await brain.memory.retrieve({
      query: queryText,
      ...(anchorDate ? { anchorDate } : {}),
      budget: { maxItems: limit },
      ...(noRerank ? { skipReranker: true } : {}),
      ...(noEmbed ? { skipEmbed: true } : {}),
    });
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (format === "context") {
      process.stdout.write(formatContext(result));
      return;
    }
    if (result.items.length === 0) {
      process.stdout.write("(no matching memories)\n");
      return;
    }
    process.stdout.write(formatChainOfNote(result));
  } finally {
    await brain.close();
  }
}

function formatContext(r: RetrievalResult): string {
  if (r.items.length === 0) return "";
  return [
    "<brain_memories>",
    "Relevant memories retrieved from the user's brain. Use them as context; do not quote them as authoritative if the user contradicts them.",
    "",
    formatChainOfNote(r).trimEnd(),
    "</brain_memories>",
    "",
  ].join("\n");
}

function formatChainOfNote(r: RetrievalResult): string {
  return r.items
    .map((m, i) => {
      // Two prefix formats land on chunks: `[Date: YYYY-MM-DD ...]` from
      // the extracted-fact post-processor and `[YYYY-MM-DD] ...` from the
      // verbatim renderChunkContent path. Match either.
      const dateMatch = m.content.match(/^\[(?:Date:\s*)?(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch?.[1] ?? "undated";
      const path = m.source.id;
      const trimmed = path.split("/").slice(-2).join("/");
      return `[${i + 1}] [Date: ${date}] [Score: ${m.score.toFixed(3)}] [Source: ${trimmed}]\n${m.content}\n`;
    })
    .join("\n");
}
