import { describe, expect, test } from "bun:test";
import { createOurMemory } from "../src/memory.js";
import { proceduralWriter } from "../src/write/procedural.js";

describe("procedural memory", () => {
  test("proceduralWriter records tool-call workflows", async () => {
    const chunks = await proceduralWriter.process(
      [{ kind: "tool-call", tool: "read", args: { path: "README.md" }, result: "ok" }],
      3,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe("procedural");
    expect(chunks[0]?.metadata?.tool).toBe("read");
  });

  test("Memory records tool-call events when procedural writer is configured", async () => {
    const memory = await createOurMemory({
      rootDir: await mktemp(),
      scope: "s",
      writer: proceduralWriter,
    });
    await memory.record({
      kind: "tool-call",
      tool: "grep",
      args: { q: "foo" },
      result: "found foo",
    });
    const result = await memory.retrieve({ query: "grep foo", skipEmbed: true });
    expect(result.items[0]?.content).toContain("Tool workflow");
    await memory.close?.();
  });
});

async function mktemp(): Promise<string> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtempSync(join(tmpdir(), "procedural-"));
}
