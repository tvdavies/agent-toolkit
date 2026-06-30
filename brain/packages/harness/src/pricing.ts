/**
 * USD per 1M tokens. Hand-maintained. Baseline figures from
 * docs/research/model-role-map.md (Apr 2026).
 *
 * This is where routing cost-awareness lives until we wire provider APIs
 * for live pricing. When a model isn't in the table, cost defaults to 0 —
 * the session log still records input/output tokens, so we can back-fill.
 */
export const PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-7": { input: 15, output: 75 },

  // OpenAI
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },

  // Google
  "gemini-3-flash": { input: 0.5, output: 3 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },

  // Local (self-hosted, electricity only — we bill 0)
  "gemma3:1b": { input: 0, output: 0 },
  "gemma3:4b": { input: 0, output: 0 },
  "gemma3:12b": { input: 0, output: 0 },
  "qwen3-reranker:0.6b": { input: 0, output: 0 },
};

export function priceOf(model: string, inputTokens: number, outputTokens: number): number {
  const row = PRICING[model];
  if (!row) return 0;
  return (row.input * inputTokens + row.output * outputTokens) / 1_000_000;
}
