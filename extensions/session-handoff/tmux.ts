import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type Run = (file: string, args: string[]) => Promise<string>;
export const run: Run = async (file, args) => {
  const result = await exec(file, args, { timeout: 5_000, maxBuffer: 64 * 1024 });
  return result.stdout.trim();
};

export type Pane = { pane: string; window: string; session: string; panes: number; linked: boolean };
export type Terminal = { pane?: string; tty?: string; interactive: boolean };

export async function currentTerminal(): Promise<Terminal> {
  if (!process.stdin.isTTY) return { interactive: false };
  try {
    return { interactive: true, pane: process.env.TMUX_PANE, tty: await realpath("/dev/fd/0") };
  } catch {
    return { interactive: true }; // Pi naming still works; tmux mutation fails closed.
  }
}

export async function ownPane(terminal: Terminal, execute: Run): Promise<Pane> {
  if (!terminal.interactive || !terminal.tty || !terminal.pane || !/^%\d+$/.test(terminal.pane)) {
    throw new Error("An interactive Pi terminal inside tmux is required.");
  }
  const fields = (await execute("tmux", [
    "display-message", "-p", "-t", terminal.pane,
    "#{pane_id}\t#{window_id}\t#{session_id}\t#{window_panes}\t#{window_linked}\t#{pane_tty}",
  ])).split("\t");
  const [pane, window, session, panes, linked, tty] = fields;
  if (fields.length !== 6 || !pane || !window || !session || pane !== terminal.pane || tty !== terminal.tty ||
      !/^@\d+$/.test(window ?? "") || !/^\$\d+$/.test(session ?? "") ||
      !/^[1-9]\d*$/.test(panes ?? "") || !/^[01]$/.test(linked ?? "")) {
    throw new Error("Cannot prove ownership of this tmux pane; no tmux changes made.");
  }
  return { pane, window, session, panes: Number(panes), linked: linked === "1" };
}

export async function executable(name: string, searchPath = process.env.PATH ?? ""): Promise<string> {
  for (const directory of searchPath.split(delimiter)) {
    // Do not execute a project-local lookalike from an empty/relative PATH entry.
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  throw new Error(`${name} was not found on the absolute executable PATH.`);
}

/** Small argv tokenizer: quoting only, never expansion, evaluation or shell execution. */
export function words(input: string): string[] {
  const result: string[] = [];
  let word = "", quote = "", started = false, escaped = false;
  for (const char of input) {
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = ""; else word += char; continue; }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) { if (started) result.push(word); word = ""; started = false; }
    else { word += char; started = true; }
  }
  if (quote || escaped) throw new Error("Unclosed quote or trailing escape in command arguments.");
  if (started) result.push(word);
  return result;
}

export function labelPart(value: string, maximum: number): string {
  const clean = value.trim();
  if (!clean || clean.length > maximum || /[\p{C}\r\n\t]/u.test(clean) || /#[({]/.test(clean)) {
    throw new Error(`Names must be non-empty, single-line plain text of at most ${maximum} characters.`);
  }
  return clean.replace(/ +/g, " ");
}
