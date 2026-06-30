/**
 * Patterns generator. Reads recent reflections and asks an LLM to
 * surface themes that recur across ≥ minEvidence distinct
 * reflections. Each theme becomes a `patterns/<theme-slug>.md`
 * page; existing pattern pages with the same slug get rewritten in
 * place via the markdown store's collision suffix logic.
 */

import type { PatternsGenerator } from "@ai-assistant/memory";
import { generateObject } from "ai";
import { z } from "zod";

const PatternsSchema = z.object({
  patterns: z.array(
    z.object({
      slug: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]+$/)
        .describe("kebab-case slug for the pattern, max 60 chars"),
      title: z.string().describe("short headline title, 4-8 words"),
      summary: z
        .string()
        .max(800)
        .describe(
          "2-4 paragraphs that explain the pattern, the evidence reflections that support it, and what it implies.",
        ),
      evidenceIds: z
        .array(z.string())
        .min(2)
        .describe("ids of the reflections that evidence this pattern (must be ≥ 2)"),
    }),
  ),
});

const SYSTEM_PROMPT = `You read a stream of daily reflections and surface durable patterns the user will care about. A pattern recurs across ≥ 2 distinct reflections. It is NOT a one-day event. Output kebab-case slugs (no dates), short titles, and 2-4 paragraph summaries grounded in the evidence reflections. British English, third person, no em-dashes.`;

export type PatternsOpts = {
  rootDir: string;
  scope: string;
  model?: string;
};

export function buildPatternsGenerator(opts: PatternsOpts): PatternsGenerator {
  return async ({ reflections, ctx }) => {
    const reflectionDigest = reflections
      .map((r) => `[${r.id}] ${r.recordedAt ?? "?"} :: ${r.body.slice(0, 600)}`)
      .join("\n\n");

    const result = await generateObject({
      model: opts.model ?? "google/gemini-3-flash",
      system: SYSTEM_PROMPT,
      prompt: `${reflections.length} recent reflections:\n\n${reflectionDigest}\n\nReturn the patterns JSON.`,
      schema: PatternsSchema,
    });

    if (ctx.dryRun) {
      return {
        patternsWritten: result.object.patterns.length,
        message: "dry_run",
      };
    }

    let written = 0;
    for (const p of result.object.patterns) {
      const body = `${p.summary}\n\nEvidence: ${p.evidenceIds.join(", ")}`;
      await ctx.markdownStore.write({
        scope: opts.scope,
        type: "patterns",
        body,
        frontmatter: {
          type: "patterns",
          title: p.title,
          slug: p.slug,
          evidenceIds: p.evidenceIds,
          origin: "daemon-patterns",
          recordedAt: new Date(ctx.now()).toISOString().slice(0, 10),
        },
      });
      written++;
    }
    void opts.rootDir;
    return {
      patternsWritten: written,
      message: `wrote ${written} pattern page(s) from ${reflections.length} reflections`,
    };
  };
}
