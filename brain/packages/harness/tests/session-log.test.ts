import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionLog } from "../src/session-log.ts";

describe("SessionLog", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sessionlog-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes events as JSONL with ISO-string dates", async () => {
    const log = new SessionLog("abc", dir);
    await log.open();
    log.append({
      type: "turn-start",
      ts: new Date("2026-04-24T10:00:00.000Z"),
      turnId: "t1",
      input: "hi",
    });
    log.append({
      type: "turn-end",
      ts: new Date("2026-04-24T10:00:01.500Z"),
      turnId: "t1",
      output: "hello",
    });
    await log.close();

    const content = await readFile(path.join(dir, "abc.jsonl"), "utf-8");
    const [firstLine, secondLine, ...rest] = content.trim().split("\n");
    expect(rest).toHaveLength(0);
    if (!firstLine || !secondLine) throw new Error("expected two JSONL lines");

    const first = JSON.parse(firstLine);
    expect(first.type).toBe("turn-start");
    expect(first.ts).toBe("2026-04-24T10:00:00.000Z");
    expect(first.input).toBe("hi");

    const second = JSON.parse(secondLine);
    expect(second.type).toBe("turn-end");
    expect(second.ts).toBe("2026-04-24T10:00:01.500Z");
    expect(second.output).toBe("hello");
  });

  it("throws on append before open", () => {
    const log = new SessionLog("abc", dir);
    expect(() =>
      log.append({ type: "turn-start", ts: new Date(), turnId: "t1", input: "hi" }),
    ).toThrow("not opened");
  });

  it("close() is idempotent after close", async () => {
    const log = new SessionLog("abc", dir);
    await log.open();
    await log.close();
    await log.close();
  });
});
