import { describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NAME_ENTRY, nextName, readNameState, registerSessionName, renameOwnWindow, RENAME_COOLDOWN_MS, type NameRequest, type NameState } from "./session-name";
import { labelPart, type Run } from "./tmux";

const terminal = { interactive: true, pane: "%4", tty: "/dev/pts/8" };
function harness(settings: { initial?: string; confirm?: boolean; tmux?: boolean } = {}) {
  let current = settings.initial, now = 1_000, confirm = settings.confirm ?? true;
  const entries: { type: string; customType: string; data: NameState }[] = [];
  const calls: string[][] = [], notices: string[] = [];
  type Tool = { execute: (id: string, request: NameRequest, signal: AbortSignal | undefined, update: unknown, ctx: ExtensionContext) => Promise<unknown> };
  let tool: Tool | undefined;
  let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  const api = {
    registerTool(value: Tool) { tool = value; },
    registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; },
    getSessionName: () => current,
    setSessionName: (name: string) => { current = name; },
    appendEntry: (customType: string, data: NameState) => entries.push({ type: "custom", customType, data }),
  };
  const ctx = { hasUI: true, sessionManager: { getEntries: () => entries }, ui: { confirm: async () => confirm, notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
  registerSessionName(api as never, {
    execute: async (_file, args) => { calls.push(args); return args[0] === "display-message" ? "%4\t@3\t$1\t1\t0\t/dev/pts/8" : ""; },
    terminal: async () => ({ ...terminal, interactive: settings.tmux ?? true }), now: () => now,
  });
  return { entries, calls, notices, name: () => current, setManualName: (value: string) => { current = value; },
    advance: () => { now += RENAME_COOLDOWN_MS + 1; }, setConfirmation: (value: boolean) => { confirm = value; },
    rename: (request: NameRequest) => tool!.execute("test", request, undefined, undefined, ctx),
    command: (args: string) => command!(args, ctx) };
}

describe("stable session naming (mock tmux only)", () => {
  it("pins an assigned identity, retains it on topic updates and makes repeats no-ops", async () => {
    const h = harness();
    await h.rename({ identity: "Ally", topic: "Agent Node" });
    expect(h.name()).toBe("Ally - Agent Node");
    expect(h.entries).toHaveLength(1);
    const calls = h.calls.length;
    expect(await h.rename({ topic: "Agent Node" })).toMatchObject({ details: { changed: false } });
    expect(h.calls).toHaveLength(calls); expect(h.entries).toHaveLength(1);
    h.advance(); await h.rename({ topic: "Order intake" });
    expect(h.name()).toBe("Ally - Order intake");
    expect(h.entries.at(-1)!.data.identity).toBe("Ally");
    expect(h.calls.filter(args => args[0] === "rename-window").at(-1)).toEqual(["rename-window", "-t", "@3", "Ally - Order intake"]);
  });
  it("refuses identity churn and frequent topic changes, without scheduling a retry", async () => {
    const h = harness(); await h.rename({ identity: "Ally", topic: "Agent Node" });
    await expect(h.rename({ identity: "Billy", topic: "Agent Node" })).rejects.toThrow("assigned identity Ally");
    await expect(h.rename({ topic: "Testing" })).rejects.toThrow("ten minutes");
    expect(h.entries).toHaveLength(1); expect(h.name()).toBe("Ally - Agent Node");
  });
  it("can pin a newly assigned identity without waiting for a generic topic cooldown", async () => {
    const h = harness(); await h.rename({ topic: "Agent Node" });
    await h.rename({ identity: "Ally" }); expect(h.name()).toBe("Ally - Agent Node");
  });
  it("protects an initial manual name and a subsequent /name override", async () => {
    const manual = harness({ initial: "User title" });
    await expect(manual.rename({ topic: "Other" })).rejects.toThrow("user already named");
    expect(manual.entries).toHaveLength(0); expect(manual.calls).toHaveLength(0);
    const h = harness(); await h.rename({ identity: "Ally", topic: "Agent Node" });
    h.setManualName("Keep this"); h.advance();
    await expect(h.rename({ topic: "Another task" })).rejects.toThrow("user already named");
    expect(h.name()).toBe("Keep this");
  });
  it("requires a human confirmation to adopt a manual name or replace a pinned identity", async () => {
    const h = harness({ initial: "User title", confirm: false });
    await h.command('--identity Ally --topic "Agent Node"'); expect(h.name()).toBe("User title");
    h.setConfirmation(true); await h.command('--identity Ally --topic "Agent Node"'); expect(h.name()).toBe("Ally - Agent Node");
    await h.command('--identity Wally --topic "Workflow 2.0"'); expect(h.name()).toBe("Wally - Workflow 2.0");
    await h.command(""); expect(h.notices.at(-1)).toContain("Wally");
    const count = h.entries.length;
    await h.command('--identity Wally --identity Billy'); expect(h.entries).toHaveLength(count);
  });
  it("works without tmux while reporting partial naming", async () => {
    const h = harness({ tmux: false });
    expect(await h.rename({ topic: "Retry fix" })).toMatchObject({ details: { changed: true, warning: expect.stringContaining("could not safely rename") } });
    expect(h.name()).toBe("Retry fix"); expect(h.calls).toHaveLength(0);
  });
  it("serialises sibling tool calls so later calls see the established identity", async () => {
    const h = harness();
    const results = await Promise.allSettled([h.rename({ identity: "Ally", topic: "Agent Node" }), h.rename({ identity: "Billy", topic: "Bugs" })]);
    expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(h.name()).toBe("Ally - Agent Node");
  });
  it("reconstructs identity/cooldown from persisted entries", () => {
    const initial = nextName(undefined, undefined, { identity: "Ally", topic: "Agent Node" }, 1_000);
    const restored = readNameState([{ type: "custom", customType: NAME_ENTRY, data: initial }]);
    expect(restored).toEqual(initial);
    expect(() => nextName(restored, initial.label, { identity: "Billy" }, 999_999)).toThrow("assigned identity");
    expect(readNameState([{ type: "custom", customType: NAME_ENTRY, data: { topic: 3 } }])).toBeUndefined();
  });
  it("refuses controls and oversized labels", () => {
    for (const value of ["", "a\nb", "a\tb", "a\x1bb", "#(command)", "#{pane_title}", "a".repeat(65)]) expect(() => labelPart(value, 64)).toThrow();
    expect(() => nextName(undefined, undefined, { identity: "a".repeat(24), topic: "b".repeat(48) }, 0)).toThrow();
  });
  it("never renames a shared/linked window or the containing tmux session", async () => {
    for (const output of ["%4\t@3\t$1\t2\t0\t/dev/pts/8", "%4\t@3\t$1\t1\t1\t/dev/pts/8", "%4\t@3\t$1\t1\t0\t/dev/pts/other"]) {
      const calls: string[][] = [];
      const execute: Run = async (_file, args) => { calls.push(args); return output; };
      expect(await renameOwnWindow("Ally", terminal, execute)).toHaveProperty("warning");
      expect(calls).toHaveLength(1);
    }
    const h = harness(); await h.rename({ identity: "Ally", topic: "Agent Node" });
    expect(h.calls.some(args => args.includes("-g") || ["rename-session", "send-keys", "new-window"].includes(args[0]!))).toBe(false);
    expect(h.calls.some(args => args.includes("automatic-rename") && args.at(-1) === "off")).toBe(true);
  });
});
