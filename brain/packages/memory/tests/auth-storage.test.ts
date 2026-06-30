import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireTokenLock,
  deleteToken,
  readToken,
  type StoredToken,
  withTokenLock,
  writeToken,
} from "../src/auth/index.ts";

const sample: StoredToken = {
  type: "oauth",
  access: "eyJfake.access.jwt",
  refresh: "rt-1",
  expires: Date.now() + 3_600_000,
  accountId: "user-123",
  provider: "codex",
  issuedAt: Date.now(),
};

describe("token storage", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brain-auth-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("read returns null when no token file exists", () => {
    expect(readToken(dir, "codex")).toBeNull();
  });

  it("write then read round-trips", () => {
    writeToken(dir, sample);
    const read = readToken(dir, "codex");
    expect(read).toEqual(sample);
  });

  it("written token has chmod 600", () => {
    writeToken(dir, sample);
    const mode = statSync(join(dir, "codex.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("delete removes the file and returns true", () => {
    writeToken(dir, sample);
    expect(deleteToken(dir, "codex")).toBe(true);
    expect(readToken(dir, "codex")).toBeNull();
  });

  it("delete returns false when no file existed", () => {
    expect(deleteToken(dir, "codex")).toBe(false);
  });

  it("invalid JSON errors clearly", () => {
    writeFileSync(join(dir, "codex.json"), "{ not json");
    expect(() => readToken(dir, "codex")).toThrow(/failed to parse token/);
  });

  it("schema-invalid token errors clearly", () => {
    writeFileSync(join(dir, "codex.json"), JSON.stringify({ type: "oauth" }));
    expect(() => readToken(dir, "codex")).toThrow(/invalid token/);
  });

  it("withTokenLock serialises concurrent writes", async () => {
    const order: string[] = [];
    await Promise.all([
      withTokenLock(dir, "codex", async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 50));
        order.push("a-end");
      }),
      withTokenLock(dir, "codex", async () => {
        order.push("b-start");
        await new Promise((r) => setTimeout(r, 50));
        order.push("b-end");
      }),
    ]);
    // Either A then B, or B then A — but never interleaved.
    const valid =
      JSON.stringify(order) === JSON.stringify(["a-start", "a-end", "b-start", "b-end"]) ||
      JSON.stringify(order) === JSON.stringify(["b-start", "b-end", "a-start", "a-end"]);
    expect(valid).toBe(true);
  });

  it("acquireTokenLock times out when the lock is held", async () => {
    const { release } = await acquireTokenLock(dir, "codex", { timeoutMs: 100 });
    try {
      await expect(
        acquireTokenLock(dir, "codex", { timeoutMs: 100, pollIntervalMs: 20 }),
      ).rejects.toThrow(/timed out/);
    } finally {
      release();
    }
  });
});
