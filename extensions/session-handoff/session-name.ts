import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { currentTerminal, labelPart, ownPane, run, words, type Run, type Terminal } from "./tmux";

export const NAME_ENTRY = "toolkit.session-name/v1";
export const RENAME_COOLDOWN_MS = 10 * 60 * 1_000;
export type NameState = { identity?: string; topic: string; label: string; renamedAt: number };
export type NameRequest = { identity?: string; topic?: string };

export function readNameState(entries: readonly { type: string; customType?: string; data?: unknown }[]): NameState | undefined {
  let state: NameState | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== NAME_ENTRY || !entry.data || typeof entry.data !== "object") continue;
    const data = entry.data as Record<string, unknown>;
    if (typeof data.topic !== "string" || typeof data.label !== "string" || typeof data.renamedAt !== "number" || !Number.isFinite(data.renamedAt)) continue;
    if (data.identity !== undefined && typeof data.identity !== "string") continue;
    state = { identity: data.identity, topic: data.topic, label: data.label, renamedAt: data.renamedAt };
  }
  return state;
}

export function nextName(previous: NameState | undefined, current: string | undefined, request: NameRequest, now: number, human = false): NameState {
  if (!human && current && current !== previous?.label) {
    throw new Error("The user already named this session. Keep that name, or ask them to use /session-label to adopt a managed label.");
  }
  const suppliedIdentity = request.identity === undefined ? undefined : labelPart(request.identity, 24);
  const identity = suppliedIdentity ?? previous?.identity;
  if (!human && previous?.identity && suppliedIdentity && suppliedIdentity !== previous.identity) {
    throw new Error(`Keep the assigned identity ${previous.identity}. Only a confirmed /session-label command can replace it.`);
  }
  const topic = request.topic === undefined ? (previous?.topic ?? "") : labelPart(request.topic, 48);
  const label = labelPart([identity, topic].filter(Boolean).join(" - "), 64);
  if (previous?.label === label) return previous;
  if (!human && previous && now - previous.renamedAt < RENAME_COOLDOWN_MS && !(identity && !previous.identity)) {
    throw new Error("Keep the current label: automatic topic changes are limited to once per ten minutes, and only for a real scope change.");
  }
  return { identity, topic, label, renamedAt: now };
}

export async function renameOwnWindow(label: string, terminal: Terminal, execute: Run): Promise<{ window?: string; warning?: string }> {
  try {
    const pane = await ownPane(terminal, execute);
    if (pane.panes !== 1 || pane.linked) return { warning: "Shared/multi-pane tmux window left unchanged; Pi name updated only." };
    // No target supplied by the model. Only this verified, unshared window.
    await execute("tmux", ["set-option", "-w", "-t", pane.window, "automatic-rename", "off"]);
    await execute("tmux", ["set-option", "-w", "-t", pane.window, "allow-rename", "off"]);
    await execute("tmux", ["rename-window", "-t", pane.window, label]);
    return { window: pane.window };
  } catch {
    return { warning: "Pi name updated, but this process could not safely rename its own tmux window. No other window or tmux session was targeted." };
  }
}

export type NamingDependencies = { execute: Run; terminal: () => Promise<Terminal>; now: () => number };
const defaults: NamingDependencies = { execute: run, terminal: currentTerminal, now: Date.now };

export function registerSessionName(pi: ExtensionAPI, deps: NamingDependencies = defaults): void {
  let pending: Promise<unknown> = Promise.resolve();
  function rename(request: NameRequest, ctx: ExtensionContext, human = false) {
    const perform = async () => {
      const previous = readNameState(ctx.sessionManager.getEntries());
      const state = nextName(previous, pi.getSessionName(), request, deps.now(), human);
      if (previous === state && pi.getSessionName() === state.label) return { changed: false, label: state.label };
      pi.setSessionName(state.label);
      pi.appendEntry(NAME_ENTRY, state);
      const terminalResult = await renameOwnWindow(state.label, await deps.terminal(), deps.execute);
      return { changed: true, label: state.label, ...terminalResult };
    };
    const result = pending.then(perform, perform);
    pending = result.catch(() => undefined);
    return result;
  }

  pi.registerTool({
    name: "set_session_name",
    label: "Name this session",
    description: "Set a concise stable Pi/session-window label once the task is clear. Read the session-name skill. Preserve any user-assigned identity; do not rename for transient progress. Only the current process's verified single-pane, unlinked tmux window is eligible. No agent launch or messaging. Topic changes have a ten-minute cooldown; manual names are protected.",
    parameters: Type.Object({
      identity: Type.Optional(Type.String({ maxLength: 24, description: "Only an identity explicitly assigned by the user or their handoff, e.g. Ally. Once set, retained automatically." })),
      topic: Type.Optional(Type.String({ maxLength: 48, description: "Stable scope in roughly 2–5 words, e.g. Agent Node. No timestamps, spinner states or per-step progress." })),
    }),
    async execute(_id, request, signal, _update, ctx) {
      signal?.throwIfAborted();
      const result = await rename(request, ctx);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerCommand("session-label", {
    description: "Confirm a manual naming override: --identity Ally --topic 'Agent Node'; no arguments shows the current name",
    handler: async (args, ctx) => {
      try {
        if (!args.trim()) { ctx.ui.notify(pi.getSessionName() ?? "This Pi session is unnamed.", "info"); return; }
        if (!ctx.hasUI || !(await deps.terminal()).interactive) throw new Error("A manual naming override requires an interactive terminal confirmation.");
        const tokens = words(args), request: NameRequest = {};
        for (let i = 0; i < tokens.length; i += 2) {
          const flag = tokens[i], value = tokens[i + 1];
          if (!value || !["--identity", "--topic"].includes(flag ?? "")) throw new Error("Use --identity Name and/or --topic 'Stable scope'.");
          if (flag === "--identity") { if (request.identity !== undefined) throw new Error("Repeated identity."); request.identity = value; }
          else { if (request.topic !== undefined) throw new Error("Repeated topic."); request.topic = value; }
        }
        const preview = nextName(readNameState(ctx.sessionManager.getEntries()), pi.getSessionName(), request, deps.now(), true);
        if (!await ctx.ui.confirm("Rename this Pi session and its own tmux window?", preview.label)) return;
        const result = await rename(request, ctx, true);
        ctx.ui.notify(JSON.stringify(result), "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Naming failed.", "error"); }
    },
  });
  // No per-turn hooks, periodic naming, self-prompts, send-keys or session-file edits.
}
