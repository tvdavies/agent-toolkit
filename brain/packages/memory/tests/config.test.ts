import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, loadBrainConfig } from "../src/config/index.ts";

describe("loadBrainConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brain-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults when no config.yaml exists", () => {
    const result = loadBrainConfig({ homeDir: dir, env: {} });
    expect(result.source).toBe("default");
    expect(result.path).toBeNull();
    expect(result.config).toEqual(defaultConfig());
  });

  it("parses a valid YAML config", () => {
    writeFileSync(
      join(dir, "config.yaml"),
      `
providers:
  gateway: { type: vercel-ai-gateway }
  codex: { type: codex-subscription }

models:
  cheap-extract: { provider: codex, id: gpt-5-mini }
  embed-large:   { provider: gateway, id: google/gemini-embedding-001, dim: 3072 }
  rerank-fast:   { provider: gateway, id: claude-haiku-4-5-20251001 }

purposes:
  extractor:      cheap-extract
  observer:       cheap-extract
  consolidator:   cheap-extract
  contextualiser: cheap-extract
  embedder:       embed-large
  reranker:       rerank-fast
`,
    );

    const result = loadBrainConfig({ homeDir: dir, env: {} });
    expect(result.source).toBe("file");
    expect(result.config.providers.codex?.type).toBe("codex-subscription");
    expect(result.config.models["embed-large"]?.dim).toBe(3072);
    expect(result.config.purposes.extractor).toBe("cheap-extract");
  });

  it("rejects models that reference an unknown provider", () => {
    writeFileSync(
      join(dir, "config.yaml"),
      `
providers:
  gateway: { type: vercel-ai-gateway }

models:
  bad: { provider: ghost, id: whatever }

purposes:
  extractor:      bad
  observer:       bad
  consolidator:   bad
  contextualiser: bad
  embedder:       bad
  reranker:       bad
`,
    );
    expect(() => loadBrainConfig({ homeDir: dir, env: {} })).toThrow(/unknown provider "ghost"/);
  });

  it("rejects purposes that reference an unknown model", () => {
    writeFileSync(
      join(dir, "config.yaml"),
      `
providers:
  gateway: { type: vercel-ai-gateway }

models:
  default-extract: { provider: gateway, id: x }
  default-embed:   { provider: gateway, id: y, dim: 1 }
  default-rerank:  { provider: gateway, id: z }

purposes:
  extractor:      default-extract
  observer:       default-extract
  consolidator:   default-extract
  contextualiser: default-extract
  embedder:       default-embed
  reranker:       missing-model
`,
    );
    expect(() => loadBrainConfig({ homeDir: dir, env: {} })).toThrow(
      /unknown model "missing-model"/,
    );
  });

  it("rejects unknown provider types", () => {
    writeFileSync(
      join(dir, "config.yaml"),
      `
providers:
  weird: { type: cuneiform-tablets }

models:
  m: { provider: weird, id: x }

purposes:
  extractor:      m
  observer:       m
  consolidator:   m
  contextualiser: m
  embedder:       m
  reranker:       m
`,
    );
    expect(() => loadBrainConfig({ homeDir: dir, env: {} })).toThrow(/providers\.weird\.type/);
  });

  it("env vars override purposes after schema validation", () => {
    writeFileSync(
      join(dir, "config.yaml"),
      `
providers:
  gateway: { type: vercel-ai-gateway }

models:
  default-extract: { provider: gateway, id: x }
  smart-extract:   { provider: gateway, id: y }
  default-embed:   { provider: gateway, id: e, dim: 3 }
  default-rerank:  { provider: gateway, id: r }

purposes:
  extractor:      default-extract
  observer:       default-extract
  consolidator:   default-extract
  contextualiser: default-extract
  embedder:       default-embed
  reranker:       default-rerank
`,
    );

    const result = loadBrainConfig({
      homeDir: dir,
      env: { BRAIN_PURPOSE_EXTRACTOR: "smart-extract" },
    });
    expect(result.config.purposes.extractor).toBe("smart-extract");
    expect(result.overrides).toEqual(["BRAIN_PURPOSE_EXTRACTOR"]);
  });

  it("env override that names an unknown model throws", () => {
    expect(() =>
      loadBrainConfig({
        homeDir: dir,
        env: { BRAIN_PURPOSE_EXTRACTOR: "no-such-model" },
      }),
    ).toThrow(/BRAIN_PURPOSE_EXTRACTOR="no-such-model"/);
  });

  it("BRAIN_CONFIG env points at a custom path", () => {
    const customPath = join(dir, "elsewhere.yaml");
    writeFileSync(
      customPath,
      `
providers:
  gateway: { type: vercel-ai-gateway }

models:
  m: { provider: gateway, id: x }

purposes:
  extractor:      m
  observer:       m
  consolidator:   m
  contextualiser: m
  embedder:       m
  reranker:       m
`,
    );
    const result = loadBrainConfig({ homeDir: dir, env: { BRAIN_CONFIG: customPath } });
    expect(result.path).toBe(customPath);
  });

  it("BRAIN_CONFIG pointing at a missing file throws", () => {
    expect(() =>
      loadBrainConfig({ homeDir: dir, env: { BRAIN_CONFIG: "/nonexistent.yaml" } }),
    ).toThrow(/BRAIN_CONFIG points at/);
  });

  it("malformed YAML errors clearly", () => {
    writeFileSync(join(dir, "config.yaml"), ":\n  - ]\n[invalid");
    expect(() => loadBrainConfig({ homeDir: dir, env: {} })).toThrow();
  });
});
