import type {
  AtomicMemoryCandidate,
  AtomicMemoryInput,
  MemorySynthesizeGenerator,
} from "@ai-assistant/memory";
import { generateObject, generateText, type LanguageModel } from "ai";
import { z } from "zod";

const AtomicMemorySchema = z.object({
  type: z.enum(["facts", "preferences", "events", "decisions", "context", "observations"]),
  content: z.string().max(260).describe("One atomic, self-contained memory statement."),
  entities: z.array(z.string()).describe("Named entities in the memory; empty array if none."),
  confidence: z.number().min(0).max(1),
  provenance: z.object({
    sourceIds: z.array(z.string()).describe("Input ids that support this memory."),
    sourceTypes: z.array(z.string()).describe("raw/reflection source kinds used."),
    derivation: z.enum([
      "user-stated",
      "assistant-inferred",
      "tool-observed",
      "reflection-derived",
      "mixed",
    ]),
  }),
});

const OutputSchema = z.object({ memories: z.array(AtomicMemorySchema) });

type Output = z.infer<typeof OutputSchema>;

const SYSTEM_PROMPT = `You synthesize durable atomic memories from raw captures and dream/reflection notes.

Rules:
- Emit only memories likely to help future recall.
- One claim per memory. Split unrelated ideas.
- Prefer explicit user facts, decisions, preferences, durable project context, tool-observed facts, and assistant findings the user asked for.
- Do not emit broad diary summaries; reflections are evidence, not the memory shape.
- Every memory must be self-contained: name the project, product, person, issue, source, or system instead of saying "this project", "the issue", "current implementation", etc.
- Every memory must cite sourceIds from the provided inputs.
- Use British English. No markdown except names/ids if needed.`;

const VAGUE_CLAIM_PATTERNS: readonly RegExp[] = [
  /\bcurrent\s+implementation\b/i,
  /\bthis\s+(?:project|repo|repository|codebase|implementation|system|issue|task|feature|bug|ticket|PR|pull request)\b/i,
  /\bthe\s+(?:project|repo|repository|codebase|implementation|system|issue|task|feature|bug|ticket|PR|pull request)\b/i,
];

/**
 * Durable memories must survive being read without the originating chat/source
 * beside them. Flag deictic phrases that usually indicate the model copied
 * local conversational context instead of naming the thing it means.
 */
export function lintVagueMemoryClaim(content: string): string[] {
  const searchable = stripQuotedText(content);
  const matches: string[] = [];
  for (const pattern of VAGUE_CLAIM_PATTERNS) {
    const match = searchable.match(pattern);
    if (match?.[0] !== undefined) matches.push(match[0].toLowerCase());
  }
  return [...new Set(matches)];
}

function filterVagueAtomicMemories(
  candidates: readonly AtomicMemoryCandidate[],
): AtomicMemoryCandidate[] {
  return candidates.filter((candidate) => lintVagueMemoryClaim(candidate.content).length === 0);
}

function stripQuotedText(content: string): string {
  let output = "";
  let quote: string | undefined;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (quote !== undefined) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    output += ch;
  }
  return output;
}

export function buildMemorySynthesizeGenerator(opts: {
  scope: string;
  model: LanguageModel | string;
}): MemorySynthesizeGenerator {
  return async ({ inputs, ctx }) => {
    if (inputs.length === 0) return { memoriesWritten: 0, message: "no_inputs" };
    const candidates = filterVagueAtomicMemories(await generateAtomicMemories(opts.model, inputs));
    if (ctx.dryRun) {
      return {
        memoriesWritten: candidates.length,
        message: `would write ${candidates.length} atomic memor${candidates.length === 1 ? "y" : "ies"}`,
      };
    }

    let written = 0;
    for (const memory of candidates) {
      await ctx.markdownStore.write({
        scope: opts.scope,
        type: memory.type,
        body: memory.content,
        frontmatter: {
          type: memory.type,
          entities: memory.entities,
          confidence: memory.confidence,
          sourceKind: "synthesis",
          authority: memory.provenance.derivation,
          origin: "daemon-synthesize",
          provenance_json: JSON.stringify(memory.provenance),
          sourceIds: memory.provenance.sourceIds,
          sourceTypes: memory.provenance.sourceTypes,
          derivation: memory.provenance.derivation,
        },
        recordedAt: newestRecordedAt(inputs, memory.provenance.sourceIds),
      });
      written++;
    }
    return {
      memoriesWritten: written,
      message: `wrote ${written} atomic memor${written === 1 ? "y" : "ies"}`,
    };
  };
}

async function generateAtomicMemories(
  model: LanguageModel | string,
  inputs: readonly AtomicMemoryInput[],
): Promise<AtomicMemoryCandidate[]> {
  const prompt = `Inputs:\n${inputs.map((i) => `---\nid: ${i.id}\ntype: ${i.sourceType}\nrecordedAt: ${i.recordedAt ?? "unknown"}\nenvelope: ${JSON.stringify(i.envelope ?? null)}\n${i.body}`).join("\n")}\n\nReturn JSON now.`;
  try {
    const result = await generateObject({
      model,
      system: SYSTEM_PROMPT,
      prompt,
      schema: OutputSchema,
    });
    return result.object.memories;
  } catch (firstError) {
    const text = await generateText({
      model,
      system: `${SYSTEM_PROMPT}\nReturn only JSON matching {"memories":[...]}.`,
      prompt,
    });
    const parsed = parseOutput(text.text);
    if (parsed !== undefined) return parsed.memories;
    throw firstError;
  }
}

function parseOutput(text: string): Output | undefined {
  const candidates = [
    text,
    text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1],
    text.match(/\{[\s\S]*\}/)?.[0],
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      const parsed = OutputSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {}
  }
  return undefined;
}

function newestRecordedAt(
  inputs: readonly AtomicMemoryInput[],
  ids: readonly string[],
): string | undefined {
  const idSet = new Set(ids);
  return inputs
    .filter((i) => idSet.has(i.id) && i.recordedAt !== undefined)
    .map((i) => i.recordedAt as string)
    .sort()
    .at(-1);
}
