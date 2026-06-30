import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Memory, RetrievalResult } from "@ai-assistant/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeReplayMetrics,
  createJsonlSink,
  type EvalCaptureRow,
  parseCaptureJsonl,
  scrubPii,
  wrapMemoryForCapture,
} from "../src/eval-capture.ts";

const stubResult = (paths: string[]): RetrievalResult => ({
  items: paths.map((p, i) => ({
    id: `id-${i}`,
    content: `body-${i}`,
    source: { kind: "memory" as const, id: p },
    score: 1 - i * 0.1,
    entities: [],
    writtenAt: new Date(0),
  })),
});

const stubMemory = (paths: string[]): Memory => ({
  retrieve: async () => stubResult(paths),
  record: async () => {},
});

describe("scrubPii", () => {
  it("redacts emails", () => {
    expect(scrubPii("contact me at alice@example.com please")).toBe("contact me at [EMAIL] please");
  });

  it("redacts SSN-shaped numbers", () => {
    expect(scrubPii("my ssn is 123-45-6789")).toBe("my ssn is [SSN]");
  });

  it("redacts long digit sequences (cards / accounts)", () => {
    expect(scrubPii("card 4111111111111111 ok")).toBe("card [NUMBER] ok");
  });

  it("redacts long phone numbers", () => {
    const out = scrubPii("call +44 20 7946 0000 anytime");
    expect(out).toContain("[PHONE]");
  });

  it("preserves short numbers like years", () => {
    expect(scrubPii("the 2024 conference")).toBe("the 2024 conference");
  });

  it("preserves names and proper nouns", () => {
    expect(scrubPii("Sarah and Mike attended")).toBe("Sarah and Mike attended");
  });
});

describe("wrapMemoryForCapture", () => {
  let dir: string;
  let captureFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-cap-"));
    captureFile = join(dir, "capture.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends one JSONL row per retrieve() call", async () => {
    const wrapped = wrapMemoryForCapture(stubMemory(["a.md", "b.md"]), {
      sink: createJsonlSink(captureFile),
    });
    await wrapped.retrieve({ query: "first" });
    await wrapped.retrieve({ query: "second" });
    const rows = parseCaptureJsonl(readFileSync(captureFile, "utf8"));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.query).toBe("first");
    expect(rows[1]?.query).toBe("second");
    expect(rows[0]?.paths).toEqual(["a.md", "b.md"]);
  });

  it("scrubs PII from the query", async () => {
    const wrapped = wrapMemoryForCapture(stubMemory(["a.md"]), {
      sink: createJsonlSink(captureFile),
    });
    await wrapped.retrieve({ query: "email me at foo@bar.com" });
    const rows = parseCaptureJsonl(readFileSync(captureFile, "utf8"));
    expect(rows[0]?.query).toBe("email me at [EMAIL]");
  });

  it("doesn't break the underlying retrieve() result on sink failure", async () => {
    const wrapped = wrapMemoryForCapture(stubMemory(["a.md"]), {
      sink: {
        write: () => {
          throw new Error("boom");
        },
      },
    });
    const r = await wrapped.retrieve({ query: "x" });
    expect(r.items).toHaveLength(1);
  });
});

describe("computeReplayMetrics", () => {
  const cap = (paths: string[], latencyMs = 100): EvalCaptureRow => ({
    capturedAt: "",
    query: "x",
    paths,
    scores: paths.map(() => 1),
    latencyMs,
    retrievedItems: paths.length,
  });

  it("perfect replay yields jaccard 1.0 + top1 1.0", () => {
    const captured = [cap(["a", "b", "c"])];
    const replayed = [cap(["a", "b", "c"])];
    const m = computeReplayMetrics(captured, replayed);
    expect(m.meanJaccardAtK).toBe(1);
    expect(m.top1Stability).toBe(1);
  });

  it("disjoint top-K yields jaccard 0", () => {
    const captured = [cap(["a", "b", "c"])];
    const replayed = [cap(["d", "e", "f"])];
    const m = computeReplayMetrics(captured, replayed);
    expect(m.meanJaccardAtK).toBe(0);
    expect(m.top1Stability).toBe(0);
  });

  it("flipped top-1 reduces stability but keeps overlap", () => {
    const captured = [cap(["a", "b"])];
    const replayed = [cap(["b", "a"])];
    const m = computeReplayMetrics(captured, replayed);
    expect(m.meanJaccardAtK).toBe(1); // same set
    expect(m.top1Stability).toBe(0);
  });

  it("reports latency Δ", () => {
    const captured = [cap(["a"], 100)];
    const replayed = [cap(["a"], 250)];
    expect(computeReplayMetrics(captured, replayed).latencyDeltaMs).toBe(150);
  });

  it("skips pairs with empty results", () => {
    const m = computeReplayMetrics([cap([])], [cap(["a"])]);
    expect(m.comparedQueries).toBe(0);
  });
});
