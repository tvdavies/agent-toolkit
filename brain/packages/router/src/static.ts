import type { ModelRouter, Role, RoutingDecision, RoutingRequest } from "@ai-assistant/contracts";

/**
 * Static role → decision lookup. Baseline from docs/research/model-role-map.md.
 * Replace with cascade + classifier routing in Phase 1.5.
 */
export class StaticRouter implements ModelRouter {
  constructor(private readonly mapping: Record<Role, RoutingDecision>) {}

  async select(req: RoutingRequest): Promise<RoutingDecision> {
    const decision = this.mapping[req.role];
    if (!decision) throw new Error(`No routing defined for role: ${req.role}`);
    return decision;
  }

  /** Default mapping aligned with docs/research/model-role-map.md. */
  static defaults(): StaticRouter {
    return new StaticRouter({
      extraction: { provider: "ollama", model: "gemma3:4b" },
      classification: { provider: "ollama", model: "gemma3:1b" },
      entropy: { provider: "ollama", model: "gemma3:1b" },
      rerank: { provider: "ollama", model: "qwen3-reranker:0.6b" },
      compression: { provider: "ollama", model: "gemma3:12b" },
      assistant: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      orchestration: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
  }
}
