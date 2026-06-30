import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { SessionEvent } from "@ai-assistant/contracts";

/**
 * Append-only JSONL session log. One file per session.
 * Dates serialised as ISO strings so the log replays cleanly.
 */
export class SessionLog {
  private stream: WriteStream | null = null;

  constructor(
    readonly sessionId: string,
    readonly dir: string,
  ) {}

  async open(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${this.sessionId}.jsonl`);
    this.stream = createWriteStream(file, { flags: "a" });
  }

  append(event: SessionEvent): void {
    if (!this.stream) throw new Error("SessionLog not opened");
    const serialisable = JSON.parse(
      JSON.stringify(event, (_k, v) => (v instanceof Date ? v.toISOString() : v)),
    );
    this.stream.write(`${JSON.stringify(serialisable)}\n`);
  }

  async close(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>((resolve, reject) => {
      this.stream?.end((err: unknown) => (err ? reject(err) : resolve()));
    });
    this.stream = null;
  }
}
