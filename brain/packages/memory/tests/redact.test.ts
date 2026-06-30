import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOurMemory } from "../src/memory.ts";
import { redact, redactDeep, redactEvent } from "../src/redact.ts";
import { createMarkdownStore } from "../src/storage/markdown-store.ts";

// Assemble secrets from parts so no contiguous real-looking credential literal
// is ever committed to the repo (matches the agent-toolkit convention).
const tok = (...parts: string[]): string => parts.join("");

describe("redact — secret formats", () => {
  it("redacts prefixed env-var credential assignments", () => {
    const out = redact(`AWS_SECRET_ACCESS_KEY=${tok("wJalr", "XUtnFEMI", "K7MDENG", "bPxRfiCY")}`);
    expect(out).toContain("AWS_SECRET_ACCESS_KEY=[REDACTED]");
    expect(out).not.toContain("wJalr");
  });

  it("redacts the password in a connection URL but keeps scheme/user/host", () => {
    const out = redact(`postgres://app:${tok("s3cr", "etP", "ass")}@db.internal:5432/main`);
    expect(out).toBe("postgres://app:[REDACTED]@db.internal:5432/main");
  });

  it("redacts provider tokens (sk-, GitHub, Slack) and JWTs", () => {
    expect(redact(tok("sk-", "ant-", "a".repeat(24)))).toContain("[REDACTED-TOKEN]");
    expect(redact(tok("ghp_", "A1b2".repeat(6)))).toContain("[REDACTED-TOKEN]");
    expect(redact(tok("xoxb-", "1234567890", "-abcdef"))).toContain("[REDACTED-TOKEN]");
    expect(redact(tok("eyJ", "abcdefgh", ".", "ijklmnop", ".", "qrstuvwx"))).toContain(
      "[REDACTED-JWT]",
    );
  });

  it("redacts bare api_key assignments", () => {
    expect(redact(`api_key="${tok("abcd", "1234", "efgh")}"`)).toContain('api_key="[REDACTED]');
  });

  it("leaves ordinary prose untouched", () => {
    const prose = "The deploy script restarts the daemon and rebuilds the index.";
    expect(redact(prose)).toBe(prose);
  });

  it("is idempotent (re-running over redacted text changes nothing)", () => {
    const once = redact(`token ${tok("sk-", "x".repeat(30))} here`);
    expect(redact(once)).toBe(once);
  });
});

describe("redactEvent — per MemoryEvent kind", () => {
  const secret = tok("sk-", "live_", "z".repeat(24));

  it("scrubs user/assistant turn text", () => {
    const u = redactEvent({ kind: "user-turn", text: `my key is ${secret}` });
    expect(u.kind === "user-turn" && u.text).toContain("[REDACTED-TOKEN]");
    const a = redactEvent({ kind: "assistant-turn", text: `here: ${secret}` });
    expect(a.kind === "assistant-turn" && a.text).not.toContain(secret);
  });

  it("scrubs ingested-item content", () => {
    const e = redactEvent({
      kind: "ingested-item",
      source: { kind: "slack", id: "C1/1" },
      content: `password=${tok("hunter", "2hunter2")}`,
    });
    expect(e.kind === "ingested-item" && e.content).toContain("password=[REDACTED]");
  });

  it("deep-scrubs tool-call args and results", () => {
    const e = redactEvent({
      kind: "tool-call",
      tool: "bash",
      args: { cmd: `export TOKEN=${secret}` },
      result: [`logged in with ${secret}`],
    });
    expect(JSON.stringify(e)).not.toContain(secret);
  });

  it("redactDeep walks nested objects and arrays", () => {
    const scrubbed = redactDeep({ a: [{ b: `key ${secret}` }], n: 5, ok: true });
    expect(JSON.stringify(scrubbed)).not.toContain(secret);
    expect((scrubbed as { n: number }).n).toBe(5);
  });
});

describe("redaction on the live write path", () => {
  let rootDir: string;
  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "redact-e2e-"));
  });
  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it("never persists a secret recorded through memory.record()", async () => {
    const secret = tok("ghp_", "Z9y8".repeat(6));
    const memory = await createOurMemory({ rootDir, scope: "test" });
    try {
      await memory.record({
        kind: "ingested-item",
        source: { kind: "cli", id: "x/1" },
        content: `deploy token is ${secret}`,
        recordedAt: "2026-06-01T00:00:00Z",
      });
      // Flush the sync write buffer.
      await memory.retrieve({ query: "deploy token", skipEmbed: true });
    } finally {
      await memory.close?.();
    }

    const store = createMarkdownStore({ rootDir });
    const paths = await store.list("test", "observations");
    const file = paths[0] ? await store.read(paths[0]) : undefined;
    expect(file).toBeDefined();
    expect(file?.body).toContain("[REDACTED-TOKEN]");
    expect(file?.body).not.toContain(secret);
  });
});
