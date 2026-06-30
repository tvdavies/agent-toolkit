#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { IngestRecord, SOURCE_ENVELOPE_SCHEMA, type SourceEnvelope } from "@ai-assistant/contracts";

type ClaudeEntry = Record<string, unknown> & {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  message?: { role?: string; content?: unknown; model?: string; usage?: unknown };
  attachment?: unknown;
  worktreeSession?: Record<string, unknown>;
};

const args = parseArgs(process.argv.slice(2));
const records = importClaudeSessionRecords({
  root: args.root,
  limit: args.limit,
  maxBodyChars: args.maxBodyChars,
});
for (const record of records)
  process.stdout.write(`${JSON.stringify({ type: "record", record })}\n`);

function parseArgs(argv: string[]): { root?: string; limit: number; maxBodyChars: number } {
  let root: string | undefined;
  let limit = 100;
  let maxBodyChars = 100_000;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root" || arg === "--path") root = argv[++i];
    else if (arg === "--limit") limit = Number.parseInt(argv[++i] ?? "100", 10) || 100;
    else if (arg === "--max-body-chars")
      maxBodyChars = Number.parseInt(argv[++i] ?? "100000", 10) || 100_000;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: brain-connector-claude-code-sessions [--root ~/.claude/projects] [--limit 100] [--max-body-chars 100000]\n",
      );
      process.exit(0);
    }
  }
  return { ...(root !== undefined ? { root } : {}), limit, maxBodyChars };
}

function defaultClaudeSessionsRoot(): string {
  const env = process.env.CLAUDE_CODE_SESSION_DIR;
  if (env !== undefined && env !== "") return expandTilde(env);
  const config = process.env.CLAUDE_CONFIG_DIR;
  if (config !== undefined && config !== "") return join(expandTilde(config), "projects");
  return join(homedir(), ".claude", "projects");
}

function importClaudeSessionRecords(opts: {
  root?: string;
  limit: number;
  maxBodyChars: number;
}): IngestRecord[] {
  const root = resolve(expandTilde(opts.root ?? defaultClaudeSessionsRoot()));
  const files = findJsonlFiles(root)
    .filter((f) => !f.endsWith("history.jsonl"))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, opts.limit);
  return files
    .map((file) => readClaudeSessionRecord(file, opts.maxBodyChars))
    .filter((r): r is IngestRecord => r !== undefined);
}

function readClaudeSessionRecord(filePath: string, maxBodyChars: number): IngestRecord | undefined {
  const entries = readJsonl(filePath);
  const rawSessionId = findSessionId(entries) ?? basename(filePath).replace(/\.jsonl$/, "");
  const sessionId = `${rawSessionId}:${sha256(filePath).slice(0, 12)}`;
  const messages = entries.filter(
    (e) => (e.type === "user" || e.type === "assistant") && e.message !== undefined,
  );
  if (messages.length === 0) return undefined;
  const firstContext = entries.find((e) => typeof e.cwd === "string");
  const cwd =
    typeof firstContext?.cwd === "string" ? firstContext.cwd : cwdFromProjectPath(filePath);
  const startedAt = entries
    .map((e) => e.timestamp)
    .filter((t): t is string => typeof t === "string")
    .sort()[0];
  const observedAt = latestTimestamp(entries) ?? startedAt;
  const title = firstUserText(messages) ?? `Claude Code session ${sessionId.slice(0, 8)}`;
  const body = truncateBody(renderSessionBody(entries, filePath, sessionId), maxBodyChars);
  const workspace = cwd !== undefined ? workspaceForCwd(cwd, firstContext?.gitBranch) : undefined;
  const model = latestModel(messages);
  const worktree = entries.find((e) => e.type === "worktree-state")?.worktreeSession;
  const envelope: SourceEnvelope = {
    schema: SOURCE_ENVELOPE_SCHEMA,
    sourceKind: "claude-code-session",
    sourceId: sessionId,
    sourceInstanceId: "claude-code-local",
    sourceVersion: firstContext?.version,
    recordedAt: startedAt,
    title,
    contentHash: sha256(body),
    participants: [
      { role: "user", name: process.env.USER ?? "user" },
      { role: "assistant", name: "Claude Code" },
    ],
    ...(workspace !== undefined ? { workspace } : {}),
    metadata: {
      sessionFile: filePath,
      entryCount: entries.length,
      messageCount: messages.length,
      ...(model !== undefined ? { modelId: model } : {}),
      ...(worktree !== undefined ? { worktree } : {}),
    },
  };
  const record = {
    schema: "brain.ingest.v1",
    source: {
      instanceId: "claude-code-local",
      kind: "claude-code-session",
      externalId: sessionId,
      uri: `file://${filePath}`,
      collection: cwd ?? dirname(filePath),
    },
    title,
    body,
    bodyFormat: "markdown",
    createdAt: startedAt,
    observedAt,
    updatedAt: observedAt,
    tags: ["claude-code", "session"],
    envelope,
    raw: { filePath, entries },
  };
  return IngestRecord.parse(record);
}

function renderSessionBody(entries: ClaudeEntry[], filePath: string, sessionId: string): string {
  const firstContext = entries.find((e) => typeof e.cwd === "string");
  const lines = [
    `# Claude Code session ${sessionId}`,
    "",
    typeof firstContext?.cwd === "string" ? `CWD: ${firstContext.cwd}` : undefined,
    typeof firstContext?.gitBranch === "string" ? `Branch: ${firstContext.gitBranch}` : undefined,
    `File: ${filePath}`,
    "",
  ].filter((v): v is string => v !== undefined);

  for (const entry of entries) {
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const role = entry.message?.role ?? entry.type;
    const text = messageText(entry.message?.content);
    if (text.trim() === "") continue;
    lines.push(`## ${role} ${entry.timestamp ?? ""}`.trim(), "", text, "");
  }
  return lines.join("\n").trimEnd();
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      out.push(part);
      continue;
    }
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") out.push(p.text);
    else if ((p.type === "tool_use" || p.type === "toolUse") && typeof p.name === "string")
      out.push(`[tool call: ${p.name} ${JSON.stringify(p.input ?? {})}]`);
    else if ((p.type === "tool_result" || p.type === "toolResult") && p.content !== undefined)
      out.push(`[tool result] ${stringifyCompact(p.content)}`);
  }
  return out.join("\n");
}

function firstUserText(entries: ClaudeEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "user") continue;
    const text = messageText(entry.message?.content).trim().replace(/\s+/g, " ");
    if (text !== "") return text.slice(0, 140);
  }
  return undefined;
}

function findSessionId(entries: ClaudeEntry[]): string | undefined {
  for (const e of entries) if (typeof e.sessionId === "string") return e.sessionId;
  return undefined;
}

function latestModel(entries: ClaudeEntry[]): string | undefined {
  return entries
    .map((e) => e.message?.model)
    .filter((m): m is string => typeof m === "string")
    .at(-1);
}

function latestTimestamp(entries: ClaudeEntry[]): string | undefined {
  return entries
    .map((e) => e.timestamp)
    .filter((t): t is string => typeof t === "string")
    .sort()
    .at(-1);
}

function cwdFromProjectPath(filePath: string): string | undefined {
  const projectDir = basename(dirname(filePath));
  if (!projectDir.startsWith("-")) return undefined;
  const decoded = projectDir.replace(/^-/, "/").replace(/-/g, "/").replace(/\/\//g, "/");
  return decoded === "/" ? undefined : decoded;
}

function workspaceForCwd(cwd: string, branchHint: unknown): SourceEnvelope["workspace"] {
  const gitRepo = git(cwd, ["config", "--get", "remote.origin.url"]);
  const branch =
    typeof branchHint === "string" ? branchHint : git(cwd, ["branch", "--show-current"]);
  return {
    cwd,
    projectName: basename(cwd),
    ...(gitRepo !== undefined ? { gitRepo } : {}),
    ...(branch !== undefined ? { branch } : {}),
  };
}

function git(cwd: string, args: string[]): string | undefined {
  if (!existsSync(cwd)) return undefined;
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : undefined;
}

function findJsonlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out;
}

function readJsonl(path: string): ClaudeEntry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as ClaudeEntry;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is ClaudeEntry => entry !== undefined);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function truncateBody(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  const head = Math.floor(maxChars * 0.7);
  const tail = Math.max(0, maxChars - head - 200);
  return `${body.slice(0, head)}\n\n[... transcript truncated for ingestion: original ${body.length} chars ...]\n\n${body.slice(-tail)}`;
}
function stringifyCompact(value: unknown): string {
  return (typeof value === "string" ? value : JSON.stringify(value))
    .replace(/\s+/g, " ")
    .slice(0, 1000);
}
function expandTilde(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
