export type L0Intent = "ask" | "edit" | "read" | "plan" | "chat";
export type L0Outcome = "ok" | "error" | "partial";

export type L0Observation = {
  at: string;
  intent: L0Intent;
  entities: string[];
  outcome: L0Outcome;
  summary: string;
};

export type L0Buffer = {
  version: 1;
  observations: L0Observation[];
};

export type L0Config = {
  maxObservations?: number;
  maxSummaryChars?: number;
};

const DEFAULT_MAX_OBSERVATIONS = 20;
const DEFAULT_MAX_SUMMARY_CHARS = 240;

export function createL0Buffer(): L0Buffer {
  return { version: 1, observations: [] };
}

export function appendL0Observation(
  buffer: L0Buffer,
  observation: L0Observation,
  config: L0Config = {},
): L0Buffer {
  const max = config.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;
  const maxSummary = config.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const next: L0Observation = {
    ...observation,
    summary:
      observation.summary.length > maxSummary
        ? `${observation.summary.slice(0, maxSummary - 1)}…`
        : observation.summary,
    entities: [...new Set(observation.entities)].slice(0, 12),
  };
  return { version: 1, observations: [...buffer.observations, next].slice(-max) };
}

export function compactL0Buffer(buffer: L0Buffer, config: L0Config = {}): L0Buffer {
  const max = config.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;
  if (buffer.observations.length <= max) return buffer;
  return { version: 1, observations: buffer.observations.slice(-max) };
}

export function renderL0Reminder(buffer: L0Buffer, limit = 8): string {
  const obs = buffer.observations.slice(-limit);
  if (obs.length === 0) return "";
  return [
    "Recent working memory:",
    ...obs.map((o) => {
      const entities = o.entities.length ? ` [${o.entities.join(", ")}]` : "";
      return `- ${o.at}: ${o.intent}/${o.outcome}${entities} — ${o.summary}`;
    }),
  ].join("\n");
}

export function inferL0Intent(text: string): L0Intent {
  if (/\b(edit|change|update|modify|fix)\b/i.test(text)) return "edit";
  if (/\b(read|show|open|look at|inspect)\b/i.test(text)) return "read";
  if (/\b(plan|design|roadmap|strategy)\b/i.test(text)) return "plan";
  if (/\?$/.test(text.trim()) || /\b(what|why|how|when|where|who)\b/i.test(text)) return "ask";
  return "chat";
}

export function extractL0Entities(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*\b/g)) {
    const v = m[0];
    if (!/^(I|The|A|An|This|That|What|How|Why|When|Where|Who)$/.test(v)) out.add(v);
  }
  return [...out].slice(0, 12);
}
