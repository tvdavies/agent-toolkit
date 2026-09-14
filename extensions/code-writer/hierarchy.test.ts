import { describe, expect, it } from "bun:test";
import { formatHierarchyModel, matchesScopePattern, MAX_HIERARCHY_MODELS, parseHierarchy, parseHierarchyModel, splitHierarchyArguments } from "./hierarchy";

describe("code-writer hierarchy parsing", () => {
	it("keeps the requested order and per-model thinking suffixes", () => {
		const hierarchy = parseHierarchy(["anthropic-claude-code/claude-fable-5-1:high", "openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna:low"]);
		expect(hierarchy.primary).toEqual({ model: "anthropic-claude-code/claude-fable-5-1", provider: "anthropic-claude-code", id: "claude-fable-5-1", thinking: "high" });
		expect(hierarchy.fallbacks.map(formatHierarchyModel)).toEqual(["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna:low"]);
	});

	it("rejects duplicates, bare ids, patterns, inherit and unsupported suffixes", () => {
		expect(() => parseHierarchy(["openai-codex/gpt-6-astra", "openai-codex/gpt-6-astra:high"])).toThrow("more than once");
		expect(() => parseHierarchyModel("gpt-6-astra")).toThrow("fully qualified");
		expect(() => parseHierarchyModel("openai-codex/gpt-5.6-*")).toThrow("not a pattern");
		expect(() => parseHierarchyModel("inherit/x")).toThrow("inherit");
		expect(() => parseHierarchyModel("openai-codex/gpt-6-astra:turbo")).toThrow("unsupported thinking suffix");
		expect(() => parseHierarchy([])).toThrow("at least one");
		expect(() => parseHierarchy(Array.from({ length: MAX_HIERARCHY_MODELS + 1 }, (_, i) => `p/m${i}`))).toThrow(`at most ${MAX_HIERARCHY_MODELS}`);
	});

	it("splits whitespace and comma separated arguments", () => {
		expect(splitHierarchyArguments("a/b, c/d  e/f:low")).toEqual(["a/b", "c/d", "e/f:low"]);
	});

	it("matches native glob scope patterns and never treats inherit as a match at configuration time", () => {
		expect(matchesScopePattern("openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-*")).toBe(true);
		expect(matchesScopePattern("OpenAI-Codex/GPT-6-Astra", "openai-codex/gpt-6-astra")).toBe(true);
		expect(matchesScopePattern("openai/gpt-5.6-luna", "openai-codex/gpt-5.6-*")).toBe(false);
		expect(matchesScopePattern("openai-codex/gpt-6-astra", "inherit")).toBe(false);
	});
});
