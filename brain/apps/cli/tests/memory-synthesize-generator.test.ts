import { describe, expect, it } from "vitest";
import { lintVagueMemoryClaim } from "../src/daemon/memory-synthesize-generator.ts";

describe("memory synthesis vague claim linter", () => {
  it("flags deictic project and issue references that are not self-contained", () => {
    expect(
      lintVagueMemoryClaim("The current implementation stores source envelopes next to the body."),
    ).toEqual(["current implementation"]);
    expect(
      lintVagueMemoryClaim("Tom decided the issue should be fixed before Gmail import."),
    ).toEqual(["the issue"]);
    expect(lintVagueMemoryClaim("This project uses a file-backed source package archive.")).toEqual(
      ["this project"],
    );
  });

  it("allows named contexts and quoted source text", () => {
    expect(
      lintVagueMemoryClaim(
        "The ai-assistant memory project uses a file-backed source package archive.",
      ),
    ).toEqual([]);
    expect(
      lintVagueMemoryClaim(
        'Tom said "this project" while discussing ai-assistant memory package naming.',
      ),
    ).toEqual([]);
  });
});
