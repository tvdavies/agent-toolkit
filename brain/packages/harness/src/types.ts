import type { Memory, ModelRouter, Tool } from "@ai-assistant/contracts";

export type HarnessConfig = {
  memory: Memory;
  router: ModelRouter;
  tools?: Tool[];
  /** Directory where JSONL session logs are written. Created if missing. */
  sessionDir: string;
  systemPrompt: string;
};

export type RunTurnInput = {
  userInput: string;
  abortSignal?: AbortSignal;
};

export type RunTurnOutput = {
  assistant: string;
  turnId: string;
  costUsd: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
};
