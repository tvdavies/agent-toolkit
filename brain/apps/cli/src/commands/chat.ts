import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { generateText } from "ai";
import type { ParsedArgs } from "../shared/args.js";
import { flag } from "../shared/args.js";
import {
  authDir,
  buildBrainChatModel,
  openBrain,
  resolveBrainHome,
  resolveBrainPath,
  resolveScope,
} from "../shared/brain.js";

const SYSTEM_PROMPT = `You are Tom's personal assistant. Answer concisely.
Use recalled memories when relevant. If you don't know the answer, say so. Do not fabricate.`;

export async function runChat(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const scope = resolveScope(flag(args, "scope"));
  const purposeRaw = flag(args, "model-purpose") ?? "consolidator";
  if (
    !["extractor", "observer", "consolidator", "contextualiser", "reranker"].includes(purposeRaw)
  ) {
    process.stderr.write(
      `Invalid --model-purpose ${purposeRaw}. Use extractor | observer | consolidator | contextualiser | reranker.\n`,
    );
    process.exit(2);
  }
  const modelPurpose = purposeRaw as
    | "extractor"
    | "observer"
    | "consolidator"
    | "contextualiser"
    | "reranker";

  const brain = await openBrain({ homeDir, rootDir, scope, asyncWrite: true });
  const chat = buildBrainChatModel(brain.config, modelPurpose, authDir(homeDir));
  const rl = createInterface({ input: stdin, output: stdout });
  stdout.write(`brain chat (${chat.id}, scope=${scope}). Ctrl-D to exit.\n`);

  try {
    for (;;) {
      const q = (await rl.question("> ")).trim();
      if (!q) continue;
      const recordedAt = new Date().toISOString();
      try {
        const retrieval = await brain.memory.retrieve({ query: q });
        const memoryBlock = retrieval.items.length
          ? `\n\nRelevant memories:\n${retrieval.items
              .map((m, i) => `${i + 1}. ${m.content}`)
              .join("\n")}`
          : "";
        const started = Date.now();
        const res = await generateText({
          model: chat.model,
          system: `${SYSTEM_PROMPT}${memoryBlock}`,
          prompt: q,
        });
        const latencyMs = Date.now() - started;
        stdout.write(`\n${res.text}\n\n`);
        stdout.write(
          `[${latencyMs}ms · ${res.usage?.inputTokens ?? 0} in / ${res.usage?.outputTokens ?? 0} out]\n\n`,
        );
        await brain.memory.record({ kind: "user-turn", text: q, recordedAt });
        await brain.memory.record({
          kind: "assistant-turn",
          text: res.text,
          recordedAt: new Date().toISOString(),
        });
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
      }
    }
  } finally {
    rl.close();
    await brain.close();
  }
}
