import type { RoutingDecision } from "@ai-assistant/contracts";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { generateText, type LanguageModel, type LanguageModelUsage } from "ai";
import { nanoid } from "nanoid";
import { priceOf } from "./pricing.js";
import { SessionLog } from "./session-log.js";
import { ToolRegistry } from "./tools.js";
import type { HarnessConfig, RunTurnInput, RunTurnOutput } from "./types.js";

/**
 * Prefer the Vercel AI Gateway if `AI_GATEWAY_API_KEY` is set — one key,
 * any provider, unified billing. Fall back to per-provider adapters (which
 * pick up their own env keys) only when the gateway isn't configured.
 */
function resolveModel(decision: RoutingDecision): LanguageModel {
  if (process.env.AI_GATEWAY_API_KEY) {
    switch (decision.provider) {
      case "anthropic":
      case "openai":
      case "google":
        return `${decision.provider}/${decision.model}`;
      case "ollama":
      case "mock":
        // fall through to adapter branch below
        break;
    }
  }
  switch (decision.provider) {
    case "anthropic":
      return anthropic(decision.model);
    case "openai":
      return openai(decision.model);
    case "google":
      return google(decision.model);
    case "ollama":
      throw new Error(
        "Ollama provider not wired yet. Add @ai-sdk/ollama in packages/harness and extend resolveModel.",
      );
    case "mock":
      throw new Error("Mock provider is test-only.");
    default: {
      const _exhaustive: never = decision.provider;
      throw new Error(`Unknown provider: ${String(_exhaustive)}`);
    }
  }
}

function readUsage(usage: LanguageModelUsage | undefined): {
  inputTokens: number;
  outputTokens: number;
} {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };
}

/**
 * M0 walking-skeleton agent loop. Single-step:
 *   retrieve → route → generate → record.
 * Tools, subagents, cascading escalation land later.
 */
export class Agent {
  private readonly registry = new ToolRegistry();
  private readonly sessionId = nanoid();
  private session: SessionLog | null = null;

  constructor(private readonly cfg: HarnessConfig) {
    for (const tool of cfg.tools ?? []) this.registry.register(tool);
  }

  async open(): Promise<void> {
    this.session = new SessionLog(this.sessionId, this.cfg.sessionDir);
    await this.session.open();
  }

  async close(): Promise<void> {
    await this.session?.close();
    this.session = null;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnOutput> {
    if (!this.session) throw new Error("Agent.open() must be called before runTurn.");
    const turnId = nanoid();
    const now = (): Date => new Date();

    this.session.append({
      type: "turn-start",
      ts: now(),
      turnId,
      input: input.userInput,
    });

    const retrieval = await this.cfg.memory.retrieve({ query: input.userInput });
    this.session.append({ type: "retrieval", ts: now(), turnId, result: retrieval });

    const decision = await this.cfg.router.select({ role: "assistant" });
    this.session.append({ type: "routing", ts: now(), turnId, decision });

    const started = Date.now();
    const result = await generateText({
      model: resolveModel(decision),
      system: this.cfg.systemPrompt,
      prompt: input.userInput,
      abortSignal: input.abortSignal,
      temperature: decision.temperature,
      maxOutputTokens: decision.maxTokens,
    });
    const latencyMs = Date.now() - started;
    const { inputTokens, outputTokens } = readUsage(result.usage);
    const costUsd = priceOf(decision.model, inputTokens, outputTokens);

    this.session.append({
      type: "model-call",
      ts: now(),
      turnId,
      provider: decision.provider,
      model: decision.model,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
    });

    await this.cfg.memory.record({ kind: "user-turn", text: input.userInput });
    await this.cfg.memory.record({ kind: "assistant-turn", text: result.text });

    this.session.append({ type: "turn-end", ts: now(), turnId, output: result.text });

    return {
      assistant: result.text,
      turnId,
      costUsd,
      latencyMs,
      inputTokens,
      outputTokens,
    };
  }
}
