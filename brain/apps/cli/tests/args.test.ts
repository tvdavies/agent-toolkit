import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/shared/args.js";

describe("parseArgs", () => {
  it("treats arguments after -- as positional text even when they look like flags", () => {
    const args = parseArgs(["query", "--format", "context", "--", "--starts-with-dash"]);
    expect(args.command).toBe("query");
    expect(args.flags.format).toBe("context");
    expect(args.positional).toEqual(["--starts-with-dash"]);
  });
});
