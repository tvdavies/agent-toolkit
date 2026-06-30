/**
 * YAML frontmatter for memory files.
 *
 * We deliberately implement a tiny dialect rather than depending on a
 * full YAML parser. Memory frontmatter only ever holds primitive
 * scalars (string, number, boolean, ISO date) and arrays of strings —
 * none of YAML's tagged types, anchors, multiline blocks, nested maps,
 * or implicit-typing footguns are needed. A targeted serialiser is
 * smaller, faster, and immune to upstream YAML breakage.
 *
 * The on-disk shape is:
 *
 *     ---
 *     id: abc123
 *     type: fact
 *     recordedAt: 2024-03-15
 *     entities:
 *       - Sarah
 *       - Mike
 *     topics: []
 *     ---
 *
 *     <markdown body>
 *
 * Round-trips: `parse(serialise(meta, body)) === { meta, body }`.
 */

export type FrontmatterValue = string | number | boolean | readonly string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export type ParsedFile = {
  frontmatter: Frontmatter;
  body: string;
};

const DELIM = "---";

export function serialise(frontmatter: Frontmatter, body: string): string {
  const lines: string[] = [DELIM];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(...renderField(key, value));
  }
  lines.push(DELIM, "");
  return `${lines.join("\n")}\n${body.replace(/\n+$/, "")}\n`;
}

export function parse(text: string): ParsedFile {
  const lines = text.split("\n");
  if (lines[0] !== DELIM) {
    return { frontmatter: {}, body: text };
  }
  let i = 1;
  const fm: Record<string, FrontmatterValue> = {};
  let currentKey: string | undefined;
  let currentList: string[] | undefined;
  while (i < lines.length && lines[i] !== DELIM) {
    const raw = lines[i] as string;
    if (raw.startsWith("  - ") && currentKey !== undefined && currentList !== undefined) {
      currentList.push(unquote(raw.slice(4)));
      i++;
      continue;
    }
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (m === null) {
      i++;
      continue;
    }
    // close any pending list
    if (currentKey !== undefined && currentList !== undefined) {
      fm[currentKey] = [...currentList];
      currentList = undefined;
    }
    const key = m[1] as string;
    const rest = (m[2] ?? "").trim();
    if (rest === "") {
      // start of a list (next lines should be `  - …`)
      currentKey = key;
      currentList = [];
    } else if (rest === "[]") {
      fm[key] = [];
      currentKey = undefined;
    } else {
      fm[key] = parseScalar(rest);
      currentKey = undefined;
    }
    i++;
  }
  if (currentKey !== undefined && currentList !== undefined) {
    fm[currentKey] = [...currentList];
  }
  // Skip the closing delimiter and any blank lines that follow.
  if (lines[i] === DELIM) i++;
  while (i < lines.length && lines[i] === "") i++;
  const body = lines.slice(i).join("\n").replace(/\n+$/, "");
  return { frontmatter: fm, body };
}

function renderField(key: string, value: FrontmatterValue): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${key}: []`];
    return [`${key}:`, ...value.map((v) => `  - ${quote(v)}`)];
  }
  if (typeof value === "boolean") return [`${key}: ${value ? "true" : "false"}`];
  if (typeof value === "number") return [`${key}: ${value}`];
  // string branch — TS can't always narrow `readonly string[]` away
  // from this position, so assert.
  return [`${key}: ${quote(value as string)}`];
}

const NEEDS_QUOTING_RE = /[":\\#@`%&*?|>!{}[\]]|^[\s-]|\s$/;

function quote(s: string): string {
  // Bare strings work for most identifiers, slugs, and ISO dates.
  // Quote anything containing characters that would confuse the parser.
  if (s === "") return '""';
  if (NEEDS_QUOTING_RE.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

function unquote(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function parseScalar(s: string): FrontmatterValue {
  const u = unquote(s);
  if (u === "true") return true;
  if (u === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(u)) return Number(u);
  return u;
}
