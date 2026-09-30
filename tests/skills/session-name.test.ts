import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const naming = source("skills/general/session-name/SKILL.md");

describe("session-name skill contract", () => {
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
    expect(naming).not.toContain("handoff");
  });
});
