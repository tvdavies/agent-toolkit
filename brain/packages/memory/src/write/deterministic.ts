import type { MemoryType } from "../storage/markdown-store.js";
import type { WriteEvent, Writer, WrittenChunk } from "./types.js";

export type DeterministicExtraction = {
  type: MemoryType;
  content: string;
  confidence: number;
  kind: "pending-action" | "appointment" | "quantity";
  entities?: string[];
};

export interface DeterministicExtractor {
  readonly id: string;
  extract(event: WriteEvent): DeterministicExtraction[];
}

export type DeterministicWriterOptions = {
  extractors?: readonly DeterministicExtractor[];
};

export function createDeterministicWriter(opts: DeterministicWriterOptions = {}): Writer {
  const extractors = opts.extractors ?? [pendingActionExtractor, appointmentExtractor, quantityExtractor];
  return {
    async process(events, baseOrdinal): Promise<WrittenChunk[]> {
      const chunks: WrittenChunk[] = [];
      let offset = 0;
      for (const event of events) {
        for (const extractor of extractors) {
          for (const item of extractor.extract(event)) {
            chunks.push({
              type: item.type,
              ordinal: baseOrdinal + offset++,
              content: item.content,
              metadata: {
                kind: item.kind,
                confidence: item.confidence,
                sourceKind: "deterministic-extraction",
                extractedBy: extractor.id,
                authority: "observed",
                ...(event.recordedAt !== undefined ? { recordedAt: event.recordedAt } : {}),
                ...(item.entities !== undefined ? { entities: item.entities } : {}),
              },
            });
          }
        }
      }
      return chunks;
    },
  };
}

const PENDING_RE =
  /\b(?:remind me to|don't let me forget to|do not let me forget to|i need to remember to|i need to|i have to|i've got to|i must|i should)\s+([^.!?\n]+)/gi;

export const pendingActionExtractor: DeterministicExtractor = {
  id: "deterministic:pending-action:v1",
  extract(event) {
    const text = eventText(event);
    const out: DeterministicExtraction[] = [];
    for (const m of text.matchAll(PENDING_RE)) {
      const action = cleanFragment(m[1] ?? "");
      if (action.length < 3) continue;
      out.push({
        type: "events",
        kind: "pending-action",
        confidence: 0.9,
        content: `User needs to ${action}.`,
      });
    }
    return out;
  },
};

const APPOINTMENT_RE =
  /\b(?:appointment|check-?up|consultation|meeting|call|dentist|doctor|gp|therapy|physio|vet)\b[^.!?\n]*/gi;
const DATE_OR_TIME_RE =
  /\b(?:today|tomorrow|tonight|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)|this\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)|\d{1,2}(?::\d{2})?\s?(?:am|pm)|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2})\b/i;

export const appointmentExtractor: DeterministicExtractor = {
  id: "deterministic:appointment:v1",
  extract(event) {
    const text = eventText(event);
    const out: DeterministicExtraction[] = [];
    for (const m of text.matchAll(APPOINTMENT_RE)) {
      const fragment = cleanFragment(m[0] ?? "");
      if (!DATE_OR_TIME_RE.test(fragment)) continue;
      out.push({
        type: "events",
        kind: "appointment",
        confidence: 0.85,
        content: `User has an appointment or scheduled commitment: ${fragment}.`,
        entities: extractTitleCase(fragment),
      });
    }
    return out;
  },
};

const MONEY_RE =
  /(?:[$£€]\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?|\b\d+(?:\.\d+)?\s?(?:dollars?|pounds?|euros?|usd|gbp|eur)\b)/gi;
const UNIT_QUANTITY_RE =
  /\b\d+(?:\.\d+)?\s?(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|km|kilometres?|kilometers?|miles?|kg|lbs?|percent|%)\b/gi;

export const quantityExtractor: DeterministicExtractor = {
  id: "deterministic:quantity:v1",
  extract(event) {
    if (event.kind !== "user-turn" && event.kind !== "ingested-item") return [];
    const text = eventText(event);
    const matches = [...text.matchAll(MONEY_RE), ...text.matchAll(UNIT_QUANTITY_RE)]
      .map((m) => m[0])
      .filter(Boolean);
    if (matches.length === 0) return [];
    const unique = [...new Set(matches.map((m) => m.trim()))];
    return [
      {
        type: "facts",
        kind: "quantity",
        confidence: 0.8,
        content: `User mentioned concrete quantity/value(s): ${unique.join(", ")}.`,
      },
    ];
  },
};

function eventText(event: WriteEvent): string {
  return event.kind === "ingested-item"
    ? event.content
    : event.kind === "tool-call"
      ? `${event.tool} ${JSON.stringify(event.args)} ${JSON.stringify(event.result)}`
      : event.text;
}

function cleanFragment(s: string): string {
  return s
    .trim()
    .replace(/^to\s+/i, "")
    .replace(/[,:;\s]+$/g, "");
}

function extractTitleCase(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*\b/g)) {
    const v = m[0];
    if (!/^(I|The|A|An|Next|This|Today|Tomorrow)$/.test(v)) out.add(v);
  }
  return [...out];
}
