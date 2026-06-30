import { describe, expect, it } from "vitest";
import { type Frontmatter, parse, serialise } from "../src/storage/frontmatter.ts";

describe("frontmatter serialise + parse", () => {
  it("round-trips a typical fact frontmatter", () => {
    const fm: Frontmatter = {
      id: "abc123",
      type: "fact",
      recordedAt: "2024-03-15",
      entities: ["Sarah", "Mike"],
      topics: ["wedding", "family"],
    };
    const body = "User attended Sarah and Mike's wedding.";
    const text = serialise(fm, body);
    const parsed = parse(text);
    expect(parsed.frontmatter).toEqual(fm);
    expect(parsed.body).toBe(body);
  });

  it("emits arrays in dash-list form", () => {
    const text = serialise({ entities: ["A", "B", "C"] }, "body");
    expect(text).toContain("entities:\n  - A\n  - B\n  - C");
  });

  it("emits empty arrays inline as []", () => {
    const text = serialise({ entities: [], topics: [] }, "body");
    expect(text).toContain("entities: []");
    expect(text).toContain("topics: []");
  });

  it("preserves multi-line bodies including blank lines", () => {
    const body = "Line one.\n\nLine three.\n\nLine five.";
    const parsed = parse(serialise({ id: "x" }, body));
    expect(parsed.body).toBe(body);
  });

  it("quotes strings containing colons or hashes", () => {
    const text = serialise({ note: "hello: world", tag: "#urgent" }, "body");
    expect(text).toContain('note: "hello: world"');
    expect(text).toContain('tag: "#urgent"');
    const parsed = parse(text);
    expect(parsed.frontmatter.note).toBe("hello: world");
    expect(parsed.frontmatter.tag).toBe("#urgent");
  });

  it("preserves numbers and booleans through round-trip", () => {
    const fm: Frontmatter = { count: 42, archived: true, ratio: 0.5 };
    const parsed = parse(serialise(fm, "body"));
    expect(parsed.frontmatter).toEqual(fm);
  });

  it("returns empty frontmatter when no delimiter is present", () => {
    const parsed = parse("just a body, no frontmatter\nat all");
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe("just a body, no frontmatter\nat all");
  });

  it("handles missing trailing newline on body", () => {
    const text = "---\nid: x\n---\n\nhello";
    expect(parse(text).body).toBe("hello");
  });

  it("handles entries within quotes containing escaped quotes", () => {
    const fm: Frontmatter = { quote: 'she said "hi"' };
    const parsed = parse(serialise(fm, "body"));
    expect(parsed.frontmatter.quote).toBe('she said "hi"');
  });

  it("handles list items containing colons or commas via quoting", () => {
    const fm: Frontmatter = { entities: ["Alice: the architect", "Bob, the builder"] };
    const parsed = parse(serialise(fm, "body"));
    expect(parsed.frontmatter.entities).toEqual(fm.entities);
  });
});
