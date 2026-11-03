#!/usr/bin/env node
// Usage: show.mjs --data DIR/data.json REF [REF...]
//
// Prints everything gather.mjs collected about each work item: a PR (URL or
// owner/repo#N), a Linear issue (LLE-123 or its URL) or a branch (its tree URL).
// PRs: body, files, linked issues. Issues: description, activity, comments, PRs,
// relations. Branches: commits and files against the default branch. Read-only.

import fs from "node:fs";
import { canonicalRef } from "./lib.mjs";
import { clip } from "./digest.mjs";

const argv = process.argv.slice(2);
const i = argv.indexOf("--data");
if (i < 0 || !argv[i + 1] || argv.includes("--help")) {
  console.error("usage: show.mjs --data DIR/data.json <PR URL | owner/repo#N | LLE-123 | branch URL> ...");
  process.exit(argv.includes("--help") ? 0 : 2);
}
const data = JSON.parse(fs.readFileSync(argv[i + 1], "utf8"));
const refs = argv.filter((_, n) => n !== i && n !== i + 1);
const MAX = 4000;

const prs = new Map();
const branches = new Map();
for (const r of data.github?.repos ?? []) {
  for (const p of [...r.prs, ...r.openPrs]) prs.set(canonicalRef(p.url), p);
  for (const b of r.branches) branches.set(canonicalRef(b.url), b);
}
const issues = new Map();
for (const x of [...(data.linear?.issues ?? []), ...(data.linear?.linked ?? [])]) issues.set(canonicalRef(x.identifier), x);

let missing = 0;
for (const ref of refs) {
  const key = canonicalRef(ref);
  const out = [];
  if (prs.has(key)) {
    const p = prs.get(key);
    out.push(`# ${p.url} [${p.state}] by ${p.author}${p.self ? " (Tom)" : ""}`, `"${p.title}"`);
    out.push(`created ${p.createdAt}, updated ${p.updatedAt}${p.mergedAt ? `, merged ${p.mergedAt}` : ""}; ${p.head} → ${p.base}; +${p.additions}/-${p.deletions}; review ${p.reviewDecision || "none"}`);
    out.push(`linear: ${p.linear.join(" ") || "none"}; labels: ${p.labels.join(", ") || "none"}; areas: ${p.areas.join(", ") || "none"}`);
    out.push(`files (${p.files.length}${p.changedFiles > p.files.length ? ` of ${p.changedFiles}` : ""}):`, ...p.files.map((f) => `  ${f}`));
    if (p.body) out.push("body:", clip(p.body, MAX));
  } else if (issues.has(key)) {
    const x = issues.get(key);
    out.push(`# ${x.url} [${x.state.name}, ${x.priorityLabel}] ${x.team.key}`, `"${x.title}"`);
    out.push(`assignee ${x.assignee?.name ?? "none"}, creator ${x.creator?.name ?? "?"}, created ${x.createdAt}${x.project ? `, project ${x.project.name}` : ""}${x.cycle ? `, cycle ${x.cycle.number}` : ""}`);
    if (x.labels?.length) out.push(`labels: ${x.labels.join(", ")}`);
    if (x.relations?.length) out.push(`relations: ${x.relations.map((r) => `${r.type} ${r.issue}`).join(", ")}`);
    const links = (x.attachments ?? []).map((a) => a.url);
    if (links.length) out.push(`attachments: ${links.join(" ")}`);
    for (const e of x.activity?.events ?? []) out.push(`  ${e.at} ${e.who} ${e.what}`);
    out.push("description:", clip(x.description, MAX));
    for (const c of x.activity?.comments ?? []) out.push(`comment ${c.user.name} ${c.createdAt} ${c.url}:`, clip(c.body, 1500));
  } else if (branches.has(key)) {
    const b = branches.get(key);
    out.push(`# ${b.url} by ${b.author}${b.self ? " (Tom)" : ""}, last commit ${b.committedAt}`);
    if (b.compareError) out.push(`compare failed: ${b.compareError}`);
    else out.push(`${b.ahead} ahead / ${b.behind} behind; areas: ${b.areas.join(", ") || "none"}`, "commits:", ...b.commits.map((c) => `  ${c}`), "files:", ...b.files.map((f) => `  ${f}`));
  } else {
    missing++;
    out.push(`# ${ref}: not in this gather (outside the window or the scanned repos/teams). Use gh or linear-cli directly.`);
  }
  console.log(out.join("\n") + "\n");
}
process.exit(missing === refs.length && refs.length > 0 ? 1 : 0);
