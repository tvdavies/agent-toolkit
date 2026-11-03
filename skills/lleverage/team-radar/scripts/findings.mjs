#!/usr/bin/env node
// Usage: findings.mjs --in findings.json [--state FILE] [--seen KEY,KEY | --seen-file FILE]
//                     [--record] [--json] [--now ISO]
//
// Validates the analysis's findings, gives each a stable key, drops the ones already
// flagged and not materially changed, ranks the rest and prints the result for Sal:
// Markdown by default, JSON with --json.
//
// Input (findings.json):
//   { "window": {"since": ISO, "until": ISO},
//     "findings": [ { "type", "title", "priority", "confidence", "who": [..], "what", "why",
//                     "action", "subjects": [PR URL | LLE-123 | branch URL, ..],
//                     "evidence": [ {"label", "url"}, .. ] } ],
//     "gaps": ["what the run couldn't reach and what access would fix it", ..] }
//
// Key: tr-<10 hex> from the type and the sorted subjects, so the same problem about the
// same PRs and issues gets the same key every day. A finding is
//   new       key never flagged before (not in --state, not in --seen)
//   changed   flagged before, but its priority rose or it now cites a PR or issue it
//             didn't before
//   repeat    flagged before and nothing material changed: left out of the output
// Prior keys come from the state file (default ~/.local/state/team-radar/state.json)
// and from --seen / --seen-file (keys Sal passes in from earlier runs; either works
// alone). --record writes the flagged findings and the window end (as lastRun, the
// next run's default start) back to the state file, atomically.
//
// Exit: 0 nothing to flag, 3 something to flag, 2 bad input.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRIORITIES, CONFIDENCE, findingKey, findingRefs, linkLinearIds, validateFinding } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(name);
if (flag("--help") || !opt("--in")) {
  const src = fs.readFileSync(new URL(import.meta.url), "utf8");
  console.error(src.split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(flag("--help") ? 0 : 2);
}

const fail = (msg) => {
  console.error(`findings.mjs: ${msg}`);
  process.exit(2);
};
let input;
try {
  input = JSON.parse(fs.readFileSync(opt("--in"), "utf8"));
} catch (error) {
  fail(`can't read ${opt("--in")}: ${error.message}`);
}
if (Array.isArray(input)) input = { findings: input };
const findings = input.findings ?? [];
const gaps = input.gaps ?? [];
const problems = findings.flatMap((f, n) => validateFinding(f).map((p) => `finding ${n + 1} (${f.title ?? "untitled"}): ${p}`));
if (problems.length) fail(`fix these and run again:\n  ${problems.join("\n  ")}`);

const statePath = opt("--state", path.join(os.homedir(), ".local/state/team-radar/state.json"));
let state = { version: 1, lastRun: null, flagged: {} };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(statePath, "utf8")) };
} catch {}
const seen = new Set([
  ...String(opt("--seen", "")).split(/[\s,]+/).filter(Boolean),
  ...(opt("--seen-file") ? fs.readFileSync(opt("--seen-file"), "utf8").split(/[\s,]+/).filter(Boolean) : []),
]);
const now = opt("--now", new Date().toISOString());
const rank = (p) => PRIORITIES.indexOf(p);

const annotated = findings.map((f) => {
  const key = findingKey(f);
  const refs = findingRefs(f);
  const prior = state.flagged[key];
  let status = "new";
  let change = null;
  if (prior) {
    const added = refs.filter((r) => !prior.refs.includes(r) && /^(gh|linear|branch):/.test(r));
    if (rank(f.priority) < rank(prior.priority)) change = `priority rose from ${prior.priority} to ${f.priority}`;
    else if (added.length) change = `now also involves ${added.join(", ")}`;
    status = change ? "changed" : "repeat";
  } else if (seen.has(key)) status = "repeat";
  return { key, status, change, firstFlagged: prior?.firstFlagged ?? null, refs, ...f };
});
const flagged = annotated
  .filter((f) => f.status !== "repeat")
  .sort((a, b) => rank(a.priority) - rank(b.priority) || CONFIDENCE.indexOf(a.confidence) - CONFIDENCE.indexOf(b.confidence));
const repeats = annotated.filter((f) => f.status === "repeat");

if (flag("--record")) {
  for (const f of flagged) {
    state.flagged[f.key] = { type: f.type, title: f.title, priority: f.priority, refs: f.refs, firstFlagged: f.firstFlagged ?? now, lastFlagged: now };
  }
  // A repeat keeps its record; forget anything not flagged for 60 days.
  const cutoff = new Date(new Date(now).getTime() - 60 * 864e5).toISOString();
  for (const [k, v] of Object.entries(state.flagged)) if ((v.lastFlagged ?? "") < cutoff) delete state.flagged[k];
  state.lastRun = input.window?.until ?? now;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

if (flag("--json")) {
  console.log(JSON.stringify({ window: input.window ?? null, flag: flagged, suppressed: repeats.map((f) => ({ key: f.key, title: f.title })), gaps }, null, 2));
} else {
  const L = [];
  const span = input.window ? ` (${input.window.since.slice(0, 16).replace("T", " ")} to ${input.window.until.slice(0, 16).replace("T", " ")} UTC)` : "";
  if (flagged.length === 0) {
    L.push(`Team radar${span}: nothing to flag.`);
    if (repeats.length) L.push(`${repeats.length} earlier finding(s) still stand unchanged: ${repeats.map((f) => f.key).join(", ")}.`);
  } else {
    L.push(`Team radar${span}: ${flagged.length} to flag.`, "");
    flagged.forEach((f, n) => {
      L.push(`${n + 1}. ${f.priority}: ${f.title} (${f.status === "changed" ? `changed: ${f.change}` : "new"}, ${f.confidence} confidence, ${f.key})`);
      L.push(`   What: ${linkLinearIds(f.what)}`);
      L.push(`   Who: ${f.who.join(", ")}`);
      L.push(`   Why it matters: ${linkLinearIds(f.why)}`);
      L.push(`   Suggested action: ${linkLinearIds(f.action)}`);
      L.push(`   Evidence: ${f.evidence.map((e) => (e.label ? `${e.label} ${e.url}` : e.url)).join(" · ")}`);
      L.push("");
    });
    if (repeats.length) L.push(`Unchanged since flagged before, left out: ${repeats.map((f) => f.key).join(", ")}.`);
  }
  if (gaps.length) L.push("", "Not checked this run:", ...gaps.map((g) => `- ${g}`));
  console.log(L.join("\n").trim());
}
process.exit(flagged.length ? 3 : 0);
