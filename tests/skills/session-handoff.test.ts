import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const handoff = source("skills/general/handoff/SKILL.md");
const naming = source("skills/general/session-name/SKILL.md");

describe("separate handoff and session-name skill contracts", () => {
  it("makes handoff discoverable for explicit chat requests, through one confirmed batch tool", () => {
    expect(handoff).toMatch(/^name: handoff$/m);
    expect(handoff).not.toMatch(/^disable-model-invocation: true$/m);
    for (const phrase of ["/skill:handoff", "local handoff files", "HTTP(S) URL", "human", "confirmation", "read-only", "waits for the user", "handoff_sessions", "create three new sessions"]) {
      expect(handoff).toContain(phrase);
    }
    expect(handoff).toContain("Model invocation is allowed; autonomous spawning is not");
    expect(handoff).toContain("no slash command is required");
    expect(handoff).toContain("one `sessions` array");
    expect(handoff).toContain("1–6 entries");
    expect(source("extensions/session-handoff/handoff.ts")).toContain('name: "handoff_sessions"');
    expect(handoff).toContain("Do not run Pi through bash");
    expect(handoff).toContain("Without a reference or brief");
    expect(handoff).toContain("not copy the\n   entire parent transcript automatically");
    expect(handoff).toContain("not launch requests");
    expect(handoff).toContain("marked `not-started`");
    expect(handoff).toContain("host-enforced launch gate");
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
