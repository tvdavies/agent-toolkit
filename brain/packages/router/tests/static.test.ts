import type { Role, RoutingDecision } from "@ai-assistant/contracts";
import { describe, expect, it } from "vitest";
import { StaticRouter } from "../src/static.ts";

describe("StaticRouter", () => {
  it("returns the decision for a mapped role", async () => {
    const router = new StaticRouter({
      assistant: { provider: "anthropic", model: "haiku" },
      extraction: { provider: "ollama", model: "gemma3:4b" },
      classification: { provider: "ollama", model: "gemma3:1b" },
      entropy: { provider: "ollama", model: "gemma3:1b" },
      rerank: { provider: "ollama", model: "qwen3-reranker:0.6b" },
      compression: { provider: "ollama", model: "gemma3:12b" },
      orchestration: { provider: "anthropic", model: "sonnet" },
    });
    const decision = await router.select({ role: "assistant" });
    expect(decision).toEqual({ provider: "anthropic", model: "haiku" });
  });

  it("throws for an unmapped role", async () => {
    const router = new StaticRouter({} as Record<Role, RoutingDecision>);
    await expect(router.select({ role: "assistant" })).rejects.toThrow(/No routing defined/);
  });

  describe("defaults()", () => {
    it("covers every role in the enum", async () => {
      const router = StaticRouter.defaults();
      const roles: Role[] = [
        "assistant",
        "orchestration",
        "extraction",
        "classification",
        "entropy",
        "rerank",
        "compression",
      ];
      for (const role of roles) {
        const decision = await router.select({ role });
        expect(decision.provider).toMatch(/^(anthropic|openai|google|ollama)$/);
        expect(decision.model).toBeTruthy();
      }
    });

    it("routes assistant to Claude Haiku 4.5 by default", async () => {
      const decision = await StaticRouter.defaults().select({ role: "assistant" });
      expect(decision.provider).toBe("anthropic");
      expect(decision.model).toContain("haiku");
    });
  });
});
