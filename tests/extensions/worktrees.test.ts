import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  START_TICKET_SKILL_PATH,
  default as worktreesExtension,
  normaliseTicketIdentifier,
  startTicketPrompt,
} from "../../extensions/worktrees.ts";

describe("start-ticket command adapter", () => {
  it("normalises an exact Linear identifier", () => {
    expect(normaliseTicketIdentifier(" lle-11972 ")).toBe("LLE-11972");
  });

  it("rejects flag-like, partial, and multiple identifiers", () => {
    for (const input of ["--schema", "LLE-", "ticket LLE-123", "LLE-1 LLE-2"]) {
      expect(() => normaliseTicketIdentifier(input)).toThrow(
        "Invalid Linear issue identifier",
      );
    }
  });

  it("builds a thin prompt that loads the shared skill", () => {
    const prompt = startTicketPrompt("lle-11972");

    expect(prompt).toContain("/skills/general/start-ticket/SKILL.md");
    expect(START_TICKET_SKILL_PATH).toContain("/skills/general/start-ticket/SKILL.md");
    expect(existsSync(START_TICKET_SKILL_PATH)).toBe(true);
    expect(prompt).toContain("Ticket: LLE-11972");
    expect(prompt).not.toContain("Completion contract");
    expect(prompt).not.toContain("git worktree add");
  });

  it("registers /start-ticket and /wt-ticket as the same thin adapter", async () => {
    const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
    const messages: string[] = [];
    const pi = {
      on: () => undefined,
      registerTool: () => undefined,
      registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
        commands.set(name, options.handler);
      },
      sendUserMessage: (message: string) => messages.push(message),
    } as unknown as ExtensionAPI;
    const ctx = {
      waitForIdle: async () => undefined,
      ui: { input: async () => undefined },
    } as unknown as ExtensionCommandContext;

    worktreesExtension(pi);
    await commands.get("start-ticket")?.("LLE-11972", ctx);
    await commands.get("wt-ticket")?.("LLE-11972", ctx);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(messages[1]);
    expect(messages[0]).toContain("Ticket: LLE-11972");
  });
});
