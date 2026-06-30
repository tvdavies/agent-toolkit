import type { IngestedItem } from "@ai-assistant/contracts";
import { describe, expect, it } from "vitest";
import { MockConnector } from "../src/index.ts";

describe("MockConnector", () => {
  const connector = new MockConnector();

  it("exposes id and empty scopes", () => {
    expect(connector.id).toBe("mock");
    expect(connector.scopes).toEqual([]);
  });

  describe("tools()", () => {
    it("returns a single mock.search tool", () => {
      const tools = connector.tools();
      expect(tools).toHaveLength(1);
      const tool = tools[0];
      if (!tool) throw new Error("expected a tool");
      expect(tool.name).toBe("mock.search");
      expect(tool.tags).toContain("read");
    });

    it("matches messages by case-insensitive substring", async () => {
      const tool = connector.tools()[0];
      if (!tool) throw new Error("expected a tool");
      const result = (await tool.call(
        { query: "LONGMEMEVAL" },
        { sessionId: "s1", turnId: "t1" },
      )) as Array<{ text: string }>;
      expect(result).toHaveLength(1);
      expect(result[0]?.text).toMatch(/LongMemEval/);
    });

    it("returns an empty array when nothing matches", async () => {
      const tool = connector.tools()[0];
      if (!tool) throw new Error("expected a tool");
      const result = (await tool.call(
        { query: "absolutely-no-match-xyz" },
        { sessionId: "s1", turnId: "t1" },
      )) as unknown[];
      expect(result).toEqual([]);
    });
  });

  describe("backfill()", () => {
    it("yields IngestedItem objects with kind=mock and parsed dates", async () => {
      const items: IngestedItem[] = [];
      if (!connector.backfill) throw new Error("expected backfill method");
      for await (const item of connector.backfill()) items.push(item);
      expect(items).toHaveLength(3);
      for (const item of items) {
        expect(item.source.kind).toBe("mock");
        expect(item.ingestedAt).toBeInstanceOf(Date);
        expect(item.content).toMatch(/^\[#devs\]/);
      }
    });
  });
});
