/**
 * `brain auth test --provider <name> [--model <id>] [--prompt <text>] [--object]`
 *
 * Smoke-tests the configured provider end-to-end. Two modes:
 *   - default: `generateText` with a one-line prompt.
 *   - `--object`: `generateObject` against a tiny zod schema, to
 *     confirm structured output (the extractor's hot path) works.
 *
 * Reads the stored token at `<home>/auth/<provider>.json`, builds
 * the right `buildChatModel` spec, and invokes the AI SDK.
 */

import {
  type BrainConfig,
  buildChatModel,
  loadBrainConfig,
  type ProviderSpec,
  readToken,
  type StoredToken,
} from "@ai-assistant/memory";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { ParsedArgs } from "../../shared/args.js";
import { bool, flag } from "../../shared/args.js";
import { authDir, resolveBrainHome } from "../../shared/brain.js";

const ObjectSchema = z.object({
  greeting: z.string().describe("a single-word greeting"),
  language: z.string().describe("the language of the greeting in lowercase"),
});

const DEFAULT_MODELS: Record<string, string> = {
  codex: "gpt-5.1-codex-mini",
  openai: "gpt-5.1",
  anthropic: "claude-haiku-4-5-20251001",
  "openai-compatible": "google/gemini-3-flash",
};

export async function runAuthTest(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const authPath = authDir(homeDir);
  const providerKey = flag(args, "provider") ?? "codex";
  const wantObject = bool(args, "object");
  const defaultPrompt = wantObject
    ? "Return a single-word greeting in French. Match the schema exactly."
    : "Say hello in exactly one word.";
  const prompt = flag(args, "prompt") ?? defaultPrompt;

  const stored = readToken(authPath, providerKey);
  if (stored === null) {
    process.stderr.write(
      `No token at ${authPath}/${providerKey}.json. Run \`brain auth login --provider ${providerKey}\`.\n`,
    );
    process.exit(2);
  }

  let config: BrainConfig | undefined;
  try {
    config = loadBrainConfig({ homeDir }).config;
  } catch {
    // Auth test can still run for built-in providers even when the
    // user's config is temporarily invalid.
  }

  const spec = inferSpec(providerKey, stored, config);
  const modelId = flag(args, "model") ?? defaultModelFor(providerKey, config) ?? "gpt-5.1";

  let model: ReturnType<typeof buildChatModel>;
  try {
    model = buildChatModel({
      spec,
      modelId,
      env: process.env,
      authPath,
      ...(stored.type === "api-key" ? { apiKey: stored.access } : {}),
    });
  } catch (err) {
    process.stderr.write(`Build provider failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  process.stdout.write(`provider: ${providerKey} (${spec.type})\n`);
  process.stdout.write(`model:    ${modelId}\n`);
  process.stdout.write(`mode:     ${wantObject ? "generateObject" : "generateText"}\n`);
  process.stdout.write(`prompt:   ${prompt}\n\n`);

  const started = Date.now();
  try {
    if (wantObject) {
      const result = await generateObject({
        model: model as Parameters<typeof generateObject>[0]["model"],
        schema: ObjectSchema,
        prompt,
      });
      const elapsedMs = Date.now() - started;
      process.stdout.write(
        `response (${elapsedMs}ms):\n${JSON.stringify(result.object, null, 2)}\n\n`,
      );
      printUsage(result.usage);
    } else {
      const result = await generateText({
        model: model as Parameters<typeof generateText>[0]["model"],
        prompt,
      });
      const elapsedMs = Date.now() - started;
      process.stdout.write(`response (${elapsedMs}ms):\n${result.text}\n\n`);
      printUsage(result.usage);
    }
  } catch (err) {
    process.stderr.write(
      `${wantObject ? "generateObject" : "generateText"} failed: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }
}

function printUsage(usage: unknown): void {
  if (usage === undefined || usage === null || typeof usage !== "object") return;
  const u = usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  process.stdout.write(
    `usage: input=${u.inputTokens ?? "?"} output=${u.outputTokens ?? "?"} total=${u.totalTokens ?? "?"}\n`,
  );
}

function inferSpec(providerKey: string, stored: StoredToken, config?: BrainConfig): ProviderSpec {
  const configured = config?.providers[providerKey];
  if (configured !== undefined) return configured;
  if (providerKey === "codex") {
    return { type: "codex-subscription" };
  }
  if (providerKey === "openai") {
    return { type: "openai" };
  }
  if (providerKey === "anthropic") {
    return { type: "anthropic" };
  }
  if (stored.baseUrl !== undefined) {
    return {
      type: "openai-compatible",
      base_url: stored.baseUrl,
    };
  }
  throw new Error(
    `Don't know how to build a provider spec for "${providerKey}". Add it to ~/brain/config.yaml or store a token with baseUrl.`,
  );
}

function defaultModelFor(providerKey: string, config?: BrainConfig): string | undefined {
  if (config !== undefined) {
    const match = Object.values(config.models).find((m) => m.provider === providerKey);
    if (match !== undefined) return match.id;
  }
  return DEFAULT_MODELS[providerKey];
}
