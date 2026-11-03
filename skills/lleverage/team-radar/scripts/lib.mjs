// Pure helpers shared by gather.mjs and findings.mjs. No I/O here, so the tests can
// drive them through the scripts' CLIs with fixed inputs.

import { createHash } from "node:crypto";

export const PRIORITIES = ["Urgent", "High", "Medium", "Low"];
export const CONFIDENCE = ["high", "medium", "low"];
export const FINDING_TYPES = [
  "conflict", // two pieces of work touch the same code, schema, API or service incompatibly
  "duplicate", // two people building the same thing
  "contradicts-decision", // work against a meeting, Slack or Linear decision
  "scope-drift", // PR does more or other than its ticket
  "no-ticket", // significant work with no Linear issue
  "missing-consideration", // migrations, flags, compatibility, rollout, tenancy, observability, tests, cost
  "rework-risk", // approach likely to need redoing given something else in flight
  "blocked-or-colliding", // someone blocked, or about to collide, who doesn't seem to know
];

const DAY = 864e5;

/**
 * The review window. An explicit --since wins. Otherwise the last recorded run (if it
 * is less than maxDays old), otherwise the previous working day at the same time, so
 * a Monday run covers Friday to Monday and a weekend run also reaches back to Friday.
 */
export function computeWindow({ now, since, lastRun, maxDays = 7 }) {
  const until = new Date(now);
  if (since) return { since: new Date(since).toISOString(), until: until.toISOString(), basis: "explicit --since" };
  if (lastRun) {
    const last = new Date(lastRun);
    if (!Number.isNaN(last.getTime()) && last < until && until - last <= maxDays * DAY) {
      return { since: last.toISOString(), until: until.toISOString(), basis: "since last recorded run" };
    }
  }
  const back = { 0: 2, 1: 3, 6: 1 }[until.getUTCDay()] ?? 1; // Sun→Fri, Mon→Fri, Sat→Fri
  return {
    since: new Date(until.getTime() - back * DAY).toISOString(),
    until: until.toISOString(),
    basis: back === 1 ? "previous 24 hours" : "previous working day (weekend rolled in)",
  };
}

/** Linear identifiers in free text, branch names included (lle-123-foo → LLE-123). */
export function linearIds(text, teamKeys) {
  const keys = new Set((teamKeys ?? []).map((k) => k.toUpperCase()));
  const found = new Set();
  for (const m of String(text ?? "").matchAll(/(?<![A-Za-z0-9])([A-Za-z]{2,6})-(\d{1,6})(?![0-9])/g)) {
    const key = m[1].toUpperCase();
    if (keys.size && !keys.has(key)) continue;
    found.add(`${key}-${Number(m[2])}`);
  }
  return [...found].sort();
}

const AREA_RULES = [
  ["migration", /(^|\/)(migrations?|drizzle|prisma|alembic)(\/|$)|\.sql$/i],
  ["schema", /schema|\.proto$|openapi|graphql|zod/i],
  ["api-contract", /(^|\/)(api|routes?|rpc|trpc|handlers?)(\/|$)|\.proto$|openapi/i],
  ["mobile", /(^|\/)(mobile|ios|android|expo|react-native)(\/|$)/i],
  ["auth-tenancy", /auth|permission|rbac|tenan|workos|(^|[/_-])acl|access-grant|network-policy/i],
  ["feature-flag", /flag|posthog|growthbook|launchdarkly/i],
  ["infra", /(^|\/)(infra|infrastructure|k8s|kubernetes|helm|terraform|argocd?|charts?|deploy)(\/|$)|Dockerfile|\.ya?ml$/i],
  ["ci", /(^|\/)\.github\//],
];
const NOISE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|CHANGELOG\.md)$|(^|\/)(__snapshots__|generated|dist)\//;

/** Coarse tags for the areas a change touches, to point the analysis at risky ones. */
export function fileAreas(paths) {
  const areas = new Set();
  for (const p of paths ?? []) for (const [name, re] of AREA_RULES) if (re.test(p)) areas.add(name);
  return [...areas].sort();
}

const UNSHIPPED = new Set(["OPEN", "DRAFT", "BRANCH"]);

/**
 * Pairs of work items by different people that touch the same files, where at least
 * one of the two hasn't shipped yet (open, draft or a branch): two merged PRs have
 * already been reconciled by the merge. Lockfiles and generated files are left out,
 * and so are files touched by more than maxPerFile items (shared hot spots such as a
 * router index say little). Each item: { ref, author, state, self?, files[] }.
 */
export function overlaps(items, { maxPerFile = 8 } = {}) {
  const byFile = new Map();
  for (const item of items) {
    if (item.state === "CLOSED") continue;
    for (const f of new Set(item.files ?? [])) {
      if (NOISE.test(f)) continue;
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(item);
    }
  }
  const pairs = new Map();
  for (const [file, list] of byFile) {
    if (list.length < 2 || list.length > maxPerFile) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i], list[j]].sort((x, y) => x.ref.localeCompare(y.ref));
        if (a.author === b.author) continue;
        if (!UNSHIPPED.has(a.state) && !UNSHIPPED.has(b.state)) continue;
        if (a.self && b.self) continue;
        const sig = `${a.ref} ${b.ref}`;
        if (!pairs.has(sig)) pairs.set(sig, { items: [a, b].map((x) => ({ ref: x.ref, author: x.author, state: x.state })), files: [] });
        pairs.get(sig).files.push(file);
      }
    }
  }
  return [...pairs.values()]
    .map((p) => ({ ...p, files: p.files.sort(), areas: fileAreas(p.files) }))
    .sort((a, b) => b.areas.length - a.areas.length || b.files.length - a.files.length);
}

const STOP = new Set("a an and the of to for in on with from by is be it its as at or not no add adds added fix fixes fixed make use when so that this into via new show".split(" "));
const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

/**
 * Pairs of items by different people whose titles share most of their words: a cheap
 * hint at duplicated work. Each item: { ref, author, title }.
 */
export function similarTitles(items, { threshold = 0.6, minWords = 3 } = {}) {
  const prepared = items.map((i) => ({ ...i, w: words(i.title) })).filter((i) => i.w.size >= minWords);
  const out = [];
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const a = prepared[i];
      const b = prepared[j];
      if (a.author === b.author) continue;
      let shared = 0;
      for (const w of a.w) if (b.w.has(w)) shared++;
      const score = shared / (a.w.size + b.w.size - shared);
      if (score >= threshold) out.push({ score: Math.round(score * 100) / 100, items: [a, b].map(({ w: _w, ...rest }) => rest) });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/** Canonical subject for a PR URL, Linear URL/ID, branch or anything else. */
export function canonicalRef(ref) {
  const s = String(ref).trim();
  let m = s.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i);
  if (m) return `gh:${m[1].toLowerCase()}#${m[2]}`;
  m = s.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (m) return `gh:${m[1].toLowerCase()}#${m[2]}`;
  m = s.match(/linear\.app\/[^/\s]+\/issue\/([A-Za-z]{2,6}-\d+)/i) ?? s.match(/^([A-Za-z]{2,6}-\d+)$/);
  if (m) return `linear:${m[1].toUpperCase()}`;
  m = s.match(/github\.com\/([^/\s]+\/[^/\s]+)\/tree\/(.+)$/i);
  if (m) return `branch:${m[1].toLowerCase()}:${decodeURIComponent(m[2])}`;
  return s.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
}

/** Stable key for a finding: its type and the sorted work items it is about. */
export function findingKey(finding) {
  const subjects = [...new Set((finding.subjects ?? []).map(canonicalRef))].sort();
  const digest = createHash("sha256").update(`${finding.type}|${subjects.join(",")}`).digest("hex");
  return `tr-${digest.slice(0, 10)}`;
}

/** Linear IDs and PR URLs referenced anywhere in a finding (for change detection). */
export function findingRefs(finding) {
  const refs = new Set((finding.subjects ?? []).map(canonicalRef));
  for (const e of finding.evidence ?? []) if (e?.url) refs.add(canonicalRef(e.url));
  return [...refs].sort();
}

/** Problems with a finding as the analysis wrote it, or [] when it is well formed. */
export function validateFinding(f) {
  const problems = [];
  if (!FINDING_TYPES.includes(f.type)) problems.push(`type must be one of ${FINDING_TYPES.join(", ")}`);
  if (!PRIORITIES.includes(f.priority)) problems.push(`priority must be a Linear priority name (${PRIORITIES.join(", ")})`);
  if (!CONFIDENCE.includes(f.confidence)) problems.push(`confidence must be ${CONFIDENCE.join(", ")}`);
  for (const field of ["title", "what", "why", "action"]) if (!String(f[field] ?? "").trim()) problems.push(`${field} is required`);
  if (!Array.isArray(f.who) || f.who.length === 0) problems.push("who must name at least one person");
  if (!Array.isArray(f.subjects) || f.subjects.length === 0) problems.push("subjects must list the PRs, issues or branches involved");
  if (!Array.isArray(f.evidence) || !f.evidence.some((e) => /^https?:\/\//.test(e?.url ?? ""))) problems.push("evidence needs at least one link");
  if (/\bSEV ?\d\b/i.test(JSON.stringify(f))) problems.push("use Linear priority names, never SEV levels");
  return problems;
}

/** Bare Linear IDs in prose become Linear links (IDs already inside a URL are left alone). */
export function linkLinearIds(text, teamKeys = ["LLE", "FDE", "CC", "DES", "LLEV", "LEG", "EDU", "CRB", "AGE"]) {
  const keys = teamKeys.join("|");
  const re = new RegExp(`(?<![\\w/-])((?:${keys})-\\d+)(?![\\w-])`, "g");
  return String(text).replace(re, "https://linear.app/lleverage/issue/$1");
}
