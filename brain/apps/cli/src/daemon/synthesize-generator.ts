/**
 * Synthesise generator. Reads recent `episodic/` chunks (verbatim
 * conversation turns), groups them by date, asks an LLM to extract
 * a daily reflection, and writes one `reflections/<date>.md` per
 * worth-processing day.
 *
 * The cheap-verdict layer GBrain uses (Haiku says "is this worth
 * processing?") is deferred for v1 — the cooldown + minEvidence
 * gates already prevent runaway spend, and the corpus this writes
 * over is small (one user's recent chats).
 */

import type { PhaseContext, SynthesizeGenerator, TranscriptInput } from "@ai-assistant/memory";
import { generateObject, generateText, type LanguageModel } from "ai";
import { z } from "zod";

const ReflectionSchema = z.object({
  date: z.string().describe("YYYY-MM-DD the reflection covers"),
  themes: z.array(z.string()).describe("3-5 short theme labels for the day"),
  summary: z
    .string()
    .max(800)
    .describe("Concise reflection on the day in third-person, 4-8 sentences."),
  surprising: z
    .string()
    .describe(
      "What was unexpected or out of character today, or an empty string if nothing stands out.",
    ),
});

const SYSTEM_PROMPT = `You are a reflective writer summarising a single day of conversation between a user and their assistant. Output one paragraph reflection that captures the day's themes, decisions, mood, and anything surprising — third-person, British English, no em-dashes, no preamble.`;

const REFLECTION_TYPE = "reflections" as const;

export type SynthesizeOpts = {
  rootDir: string;
  scope: string;
  /** Override the default extraction model resolution. */
  model?: LanguageModel | string;
};

/**
 * Pull recent episodic chunks via the storage layer, normalise
 * each into a TranscriptInput. Bucketed by recordedAt so the
 * generator can group per-day inside one phase run.
 *
 * Self-consumption guard: skip chunks tagged with
 * `frontmatter.origin = "daemon-*"` so the daemon's own output
 * never re-enters the synthesis loop. The cooldown timer protects
 * against immediate recursion; this protects against eventual
 * recursion when a long-archived daemon page resurfaces.
 */
export async function loadRecentEpisodicAsTranscripts(
  ctx: PhaseContext,
  opts: { lookbackHours?: number; limit?: number } = {},
): Promise<TranscriptInput[]> {
  const limit = opts.limit ?? 200;
  const cutoff = ctx.now() - (opts.lookbackHours ?? 24) * 60 * 60 * 1000;
  const chunks = ctx.storage
    .listLiveChunks()
    .filter((c) => c.type === "episodic")
    .filter((c) => !isDaemonEmitted(c.metadata))
    .map((c) => {
      const recordedAt =
        typeof c.metadata?.recordedAt === "string" ? c.metadata.recordedAt : undefined;
      return { c, recordedAtMs: recordedAt ? Date.parse(recordedAt) : Number.NaN };
    })
    .filter(({ recordedAtMs }) => (Number.isNaN(recordedAtMs) ? true : recordedAtMs >= cutoff))
    .slice(-limit);
  return chunks.map(({ c }) => ({
    id: c.id,
    body: c.content,
    ...(typeof c.metadata?.recordedAt === "string" ? { recordedAt: c.metadata.recordedAt } : {}),
  }));
}

function isDaemonEmitted(metadata: Record<string, unknown> | undefined): boolean {
  const origin = metadata?.origin;
  return typeof origin === "string" && origin.startsWith("daemon-");
}

export function buildSynthesizeGenerator(opts: SynthesizeOpts): SynthesizeGenerator {
  return async ({ transcripts, ctx }) => {
    if (transcripts.length === 0) return { pagesWritten: 0, message: "no_transcripts" };

    // Group by date (YYYY-MM-DD slice of recordedAt).
    const byDate = new Map<string, TranscriptInput[]>();
    for (const t of transcripts) {
      const date = (t.recordedAt ?? new Date(ctx.now()).toISOString()).slice(0, 10);
      const bucket = byDate.get(date) ?? [];
      bucket.push(t);
      byDate.set(date, bucket);
    }

    let pagesWritten = 0;
    for (const [date, ts] of byDate.entries()) {
      // Cooldown via daemon_state already gates re-runs across
      // cycles; within a cycle we still skip dates that already
      // have a reflection on disk to avoid overwriting hand edits.
      const targetSlug = `daily-${date}`;
      const existing = ctx.markdownStore.list(opts.scope, REFLECTION_TYPE);
      const existingPaths = await existing;
      if (existingPaths.some((p) => p.endsWith(`${targetSlug}.md`))) {
        continue;
      }

      const turns = ts.map((t) => `[${t.recordedAt ?? date}] ${t.body}`).join("\n");
      const reflection = await generateReflection({
        model: opts.model ?? "google/gemini-3-flash",
        date,
        turns,
      });

      if (ctx.dryRun) {
        pagesWritten++;
        continue;
      }
      const body = formatReflection(reflection);
      await ctx.markdownStore.write({
        scope: opts.scope,
        type: REFLECTION_TYPE,
        body,
        frontmatter: {
          type: REFLECTION_TYPE,
          recordedAt: date,
          topics: reflection.themes,
          origin: "daemon-reflect",
        },
        recordedAt: date,
      });
      pagesWritten++;
    }
    void opts.rootDir; // reserved for future per-phase root override.
    return {
      pagesWritten,
      message: `wrote ${pagesWritten} reflection page(s) across ${byDate.size} day(s)`,
    };
  };
}

type Reflection = z.infer<typeof ReflectionSchema>;

async function generateReflection(opts: {
  model: LanguageModel | string;
  date: string;
  turns: string;
}): Promise<Reflection> {
  const prompt = `Date: ${opts.date}\n\nTurns from this day:\n${opts.turns}\n\nProduce the reflection JSON now.`;
  try {
    const result = await generateObject({
      model: opts.model,
      system: SYSTEM_PROMPT,
      prompt,
      schema: ReflectionSchema,
    });
    return result.object;
  } catch (firstError) {
    try {
      const retry = await generateObject({
        model: opts.model,
        system: `${SYSTEM_PROMPT}\nReturn only valid JSON matching the requested schema.`,
        prompt,
        schema: ReflectionSchema,
      });
      return retry.object;
    } catch {
      const text = await generateText({
        model: opts.model,
        system: `${SYSTEM_PROMPT}\nReturn only JSON with keys date, themes, summary, and optional surprising.`,
        prompt,
      });
      const parsed = parseReflectionJson(text.text);
      if (parsed !== undefined) return parsed;
      throw firstError;
    }
  }
}

function parseReflectionJson(text: string): Reflection | undefined {
  const candidates = [
    text,
    text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1],
    text.match(/\{[\s\S]*\}/)?.[0],
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      const parsed = ReflectionSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next extraction strategy.
    }
  }
  return undefined;
}

function formatReflection(r: Reflection): string {
  const themes = r.themes.join(", ");
  const surprising = r.surprising.trim() !== "" ? `\n\nSurprising: ${r.surprising}` : "";
  return `Themes: ${themes}\n\n${r.summary}${surprising}`;
}
