import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const handoff = source("skills/general/handoff/SKILL.md");
const naming = source("skills/general/session-name/SKILL.md");

describe("separate handoff and session-name skill contracts", () => {
  it("keeps handoff explicit-only, with an optional reference and a human-owned command", () => {
    expect(handoff).toMatch(/^name: handoff$/m);
    expect(handoff).toMatch(/^disable-model-invocation: true$/m);
    for (const phrase of ["/skill:handoff", "local handoff file", "HTTP(S) URL", "visible human confirmation", "no model-callable tool", "read-only", "waits for the user", "not an OS"]) {
      // The OS-boundary distinction is documented by the companion extension.
      expect(phrase === "not an OS" ? source("extensions/session-handoff/README.md") : handoff).toContain(phrase);
    }
    expect(source("extensions/session-handoff/handoff.ts")).not.toContain("pi.registerTool(");
    expect(handoff).toContain("Do not run Pi through bash");
    expect(handoff).toContain("Without a reference or instructions");
    expect(handoff).toContain("does not copy the parent's conversation");
  });
  it("allows meaningful self-naming independently, without turning it into delegation", () => {
    expect(naming).toMatch(/^name: session-name$/m);
    expect(naming).not.toMatch(/^disable-model-invocation: true$/m);
    expect(naming).toContain("set_session_name");
    expect(naming).toContain("Ally - Agent Node");
    expect(naming).toContain("**Never use `rename-session`**");
    expect(naming).toContain("not** an instruction to rename every ten minutes");
    expect(naming).toContain("Do not synthesise this command");
    expect(naming).toContain("A name manually set with `/name`");
    expect(naming).toContain("it never\nlaunches");
  });
});
