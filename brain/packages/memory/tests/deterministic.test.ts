import { describe, expect, test } from "bun:test";
import {
  appointmentExtractor,
  createDeterministicWriter,
  pendingActionExtractor,
  quantityExtractor,
} from "../src/write/deterministic.js";

describe("deterministic extractors", () => {
  test("pendingActionExtractor captures reminder-style commitments", () => {
    const out = pendingActionExtractor.extract({
      kind: "user-turn",
      text: "Don't let me forget to renew my passport tomorrow.",
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("pending-action");
    expect(out[0]?.content).toContain("renew my passport tomorrow");
  });

  test("appointmentExtractor captures scheduled commitments with time/date", () => {
    const out = appointmentExtractor.extract({
      kind: "user-turn",
      text: "I have a dentist appointment next Monday at 9am.",
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("appointment");
    expect(out[0]?.content).toContain("dentist appointment next Monday at 9am");
  });

  test("quantityExtractor captures money and unit quantities", () => {
    const out = quantityExtractor.extract({
      kind: "user-turn",
      text: "I spent $42 and walked 5 miles today.",
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("quantity");
    expect(out[0]?.content).toContain("$42");
    expect(out[0]?.content).toContain("5 miles");
  });

  test("createDeterministicWriter composes extractors into chunks with provenance", async () => {
    const writer = createDeterministicWriter();
    const chunks = await writer.process(
      [
        {
          kind: "user-turn",
          text: "Remind me to call the vet tomorrow at 3pm. It should cost £80.",
          recordedAt: "2026-05-08T10:00:00Z",
        },
      ],
      7,
    );
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]?.ordinal).toBe(7);
    expect(chunks.every((c) => c.metadata?.sourceKind === "deterministic-extraction")).toBe(true);
    expect(chunks.every((c) => c.metadata?.authority === "observed")).toBe(true);
    expect(chunks.every((c) => typeof c.metadata?.confidence === "number")).toBe(true);
  });
});
