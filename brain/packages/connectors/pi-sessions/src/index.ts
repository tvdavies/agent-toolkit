#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { IngestRecord, SOURCE_ENVELOPE_SCHEMA, type SourceEnvelope } from "@ai-assistant/contracts";

type PiEntry = Record<string, unknown> & {
  type?: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  version?: unknown;
  message?: { role?: string; content?: unknown };
};

const args = parseArgs(process.argv.slice(2));
const records = importPiSessionRecords({
  root: args.root,
  limit: args.limit,
  maxBodyChars: args.maxBodyChars,
});
for (const record of records) {
  process.stdout.write(`${JSON.stringify({ type: "record", record })}\n`);
}

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
        "Usage: brain-connector-pi-sessions [--root ~/.pi/agent/sessions] [--limit 100] [--max-body-chars 100000]\n",
      );
      process.exit(0);
    }
  }
  return { ...(root !== undefined ? { root } : {}), limit, maxBodyChars };
}

function defaultPiSessionsRoot(): string {
  const envSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (envSessionDir !== undefined && envSessionDir !== "") return expandTilde(envSessionDir);
  const envAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (envAgentDir !== undefined && envAgentDir !== "")
    return join(expandTilde(envAgentDir), "sessions");
  return join(homedir(), ".pi", "agent", "sessions");
}

function importPiSessionRecords(opts: {
  root?: string;
  limit: number;
  maxBodyChars: number;
}): IngestRecord[] {
  const root = resolve(expandTilde(opts.root ?? defaultPiSessionsRoot()));
  const files = findJsonlFiles(root)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, opts.limit);
  return files
    .map((file) => readPiSessionRecord(file, opts.maxBodyChars))
    .filter((r): r is IngestRecord => r !== undefined);
}

function readPiSessionRecord(filePath: string, maxBodyChars: number): IngestRecord | undefined {
  const entries = readJsonl(filePath);
  const header = entries[0];
  if (header?.type !== "session" || typeof header.id !== "string") return undefined;
  const cwd = typeof header.cwd === "string" ? header.cwd : undefined;
  const sessionId = header.id;
  const startedAt = typeof header.timestamp === "string" ? header.timestamp : undefined;
  const model = latestModel(entries);
  const messages = entries.filter((e) => e.type === "message" && e.message !== undefined);
  if (messages.length === 0) return undefined;
  const title = firstUserText(messages) ?? `Pi session ${sessionId.slice(0, 8)}`;
  const body = truncateBody(renderSessionBody(entries, filePath), maxBodyChars);
  const workspace = cwd !== undefined ? workspaceForCwd(cwd) : undefined;
  const envelope: SourceEnvelope = {
    schema: SOURCE_ENVELOPE_SCHEMA,
    sourceKind: "pi-session",
    sourceId: sessionId,
    sourceInstanceId: "pi-local",
    sourceVersion: `session-v${String(header.version ?? "unknown")}`,
    recordedAt: startedAt,
    title,
    contentHash: sha256(body),
    participants: [
      { role: "user", name: process.env.USER ?? "user" },
      { role: "assistant", name: "Pi" },
    ],
    ...(workspace !== undefined ? { workspace } : {}),
    metadata: {
      sessionFile: filePath,
      entryCount: entries.length,
      messageCount: messages.length,
      ...(model.provider !== undefined ? { provider: model.provider } : {}),
      ...(model.modelId !== undefined ? { modelId: model.modelId } : {}),
      ...(model.thinkingLevel !== undefined ? { thinkingLevel: model.thinkingLevel } : {}),
    },
  };
  const record = {
    schema: "brain.ingest.v1",
    source: {
      instanceId: "pi-local",
      kind: "pi-session",
      externalId: sessionId,
      uri: `file://${filePath}`,
      collection: cwd ?? dirname(filePath),
    },
    title,
    body,
    bodyFormat: "markdown",
    createdAt: startedAt,
    observedAt: latestTimestamp(entries) ?? startedAt,
    updatedAt: latestTimestamp(entries) ?? startedAt,
    tags: ["pi", "session"],
    envelope,
    raw: { filePath, entries },
  };
  return IngestRecord.parse(record);
}

function renderSessionBody(entries: PiEntry[], filePath: string): string {
  const header = entries[0];
  const lines = [
    `# Pi session ${typeof header?.id === "string" ? header.id : basename(filePath)}`,
    "",
    typeof header?.cwd === "string" ? `CWD: ${header.cwd}` : undefined,
    typeof header?.timestamp === "string" ? `Started: ${header.timestamp}` : undefined,
    `File: ${filePath}`,
    "",
  ].filter((v): v is string => v !== undefined);

  for (const entry of entries) {
    if (entry.type === "model_change") {
      lines.push(
        `_Model: ${String(entry.provider ?? "unknown")}/${String(entry.modelId ?? "unknown")}_`,
        "",
      );
      continue;
    }
    if (entry.type !== "message" || entry.message === undefined) continue;
    const role = entry.message.role ?? "unknown";
    const text = messageText(entry.message.content);
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
    else if ((p.type === "toolCall" || p.type === "tool-call") && typeof p.name === "string") {
      out.push(`[tool call: ${p.name} ${JSON.stringify(p.arguments ?? {})}]`);
    } else if (
      (p.type === "toolResult" || p.type === "tool-result") &&
      typeof p.name === "string"
    ) {
      out.push(`[tool result: ${p.name}] ${stringifyCompact(p.result ?? p.content ?? "")}`);
    }
  }
  return out.join("\n");
}

function firstUserText(entries: PiEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.message?.role !== "user") continue;
    const text = messageText(entry.message.content).trim().replace(/\s+/g, " ");
    if (text !== "") return text.slice(0, 140);
  }
  return undefined;
}

function latestModel(entries: PiEntry[]): {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
} {
  const out: { provider?: string; modelId?: string; thinkingLevel?: string } = {};
  for (const entry of entries) {
    if (entry.type === "model_change") {
      if (typeof entry.provider === "string") out.provider = entry.provider;
      if (typeof entry.modelId === "string") out.modelId = entry.modelId;
    }
    if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string")
      out.thinkingLevel = entry.thinkingLevel;
  }
  return out;
}

function latestTimestamp(entries: PiEntry[]): string | undefined {
  return entries
    .map((e) => e.timestamp)
    .filter((t): t is string => typeof t === "string")
    .sort()
    .at(-1);
}

function workspaceForCwd(cwd: string): SourceEnvelope["workspace"] {
  const gitRepo = git(cwd, ["config", "--get", "remote.origin.url"]);
  const branch = git(cwd, ["branch", "--show-current"]);
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

function readJsonl(path: string): PiEntry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as PiEntry;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is PiEntry => entry !== undefined);
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
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").slice(0, 1000);
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
