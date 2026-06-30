/**
 * `brain why <query>` — show the score breakdown per retrieved hit.
 *
 * Like `brain query` but renders every multiplier that fired for
 * each result, so you can see whether bm25, vector, type-multiplier,
 * decay, backlink, or authority drove the rank. Mirrors GBrain's
 * `gbrain why` operator command.
 */

import type { ParsedArgs } from "../shared/args.js";
import { bool, flag, intFlag } from "../shared/args.js";
import { openBrain, resolveBrainHome, resolveBrainPath, resolveScope } from "../shared/brain.js";

export async function runWhy(args: ParsedArgs): Promise<void> {
  const queryText = args.positional.join(" ").trim();
  if (queryText === "") {
    process.stderr.write("Usage: brain why <text>\n");
    process.exit(2);
  }

  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const scope = resolveScope(flag(args, "scope"));
  const limit = intFlag(args, "limit", 5);
  const json = bool(args, "json");
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
    if (result.items.length === 0) {
      process.stdout.write("(no matching memories)\n");
      return;
    }
    process.stdout.write(`query: ${queryText}\n`);
    process.stdout.write(
      `diagnostics: bm25=${result.diagnostics?.bm25Hits ?? 0} vec=${result.diagnostics?.vectorHits ?? 0} reranker=${result.diagnostics?.rerankerRan ? "yes" : "no"}\n\n`,
    );
    result.items.forEach((m, i) => {
      const path = m.source.id;
      const trimmed = path.split("/").slice(-2).join("/");
      process.stdout.write(`[${i + 1}] ${trimmed}  score=${m.score.toFixed(3)}\n`);
      const s = m.scoring;
      if (s === undefined) {
        process.stdout.write(`    (no breakdown — older memory or cached path)\n\n`);
        return;
      }
      const parts: string[] = [];
      parts.push(`rrf=${s.rrfBase.toFixed(3)}`);
      const c = s.contributions;
      if (c.bm25 !== undefined) parts.push(`bm25=${c.bm25.toFixed(3)}`);
      if (c.vector !== undefined) parts.push(`vector=${c.vector.toFixed(3)}`);
      if (c.entity !== undefined) parts.push(`entity=${c.entity.toFixed(3)}`);
      if (s.cosineBlend !== undefined) parts.push(`×cos=${s.cosineBlend.toFixed(3)}`);
      if (s.typeMultiplier !== undefined) parts.push(`×type=${s.typeMultiplier.toFixed(2)}`);
      if (s.decayMultiplier !== undefined) parts.push(`×decay=${s.decayMultiplier.toFixed(2)}`);
      if (s.assistantBoost !== undefined) parts.push(`×asst=${s.assistantBoost.toFixed(2)}`);
      if (s.backlinkBoost !== undefined) parts.push(`×back=${s.backlinkBoost.toFixed(2)}`);
      if (s.authorityMultiplier !== undefined)
        parts.push(`×auth=${s.authorityMultiplier.toFixed(2)}`);
      if (s.rerankerRanked) parts.push("reranked");
      process.stdout.write(`    ${parts.join("  ")}\n`);
      const preview = m.content.split("\n").slice(0, 3).join("\n").slice(0, 280);
      process.stdout.write(`    ${preview.replace(/\n/g, "\n    ")}\n\n`);
    });
  } finally {
    await brain.close();
  }
}
