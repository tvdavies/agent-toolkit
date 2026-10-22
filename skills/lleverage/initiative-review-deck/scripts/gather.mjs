#!/usr/bin/env node
// Gather one week of a Linear initiative into data.json and digest.md.
//
//   gather.mjs --initiative "<initiative name>" [--from 2026-10-09] [--to 2026-10-16] [--out DIR]
//
// --from / --to bound the review week (dates are UTC midnights; --to is exclusive).
// Defaults: --to is the next Friday on or after today, --from is 7 days before it.
// Writes into DIR (default ./<initiative-slug>-<to>):
//   data.json   everything the deck builder needs: initiative, projects, milestones with
//               issue counts and a derived status, issues, updates, comments and links
//   digest.md   the same week as readable Markdown, for writing content.json
//
// Talks to Linear through `linear-cli api query`, so it uses linear-cli's own auth
// (LINEAR_API_KEY or ~/.config/linear-cli). Read-only: it never mutates anything.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const initiativeName = opt("--initiative");
if (!initiativeName) {
  console.error('usage: gather.mjs --initiative "<name>" [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out DIR]');
  process.exit(2);
}

const day = (d) => d.toISOString().slice(0, 10);
function nextFriday(from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
const to = opt("--to") ? new Date(`${opt("--to")}T00:00:00Z`) : nextFriday();
const from = opt("--from") ? new Date(`${opt("--from")}T00:00:00Z`) : new Date(to.getTime() - 7 * 864e5);
const slug = initiativeName.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const outDir = opt("--out", `${slug}-${day(to)}`);
fs.mkdirSync(outDir, { recursive: true });
const inWeek = (iso) => !!iso && iso >= from.toISOString() && iso < to.toISOString();

function gql(query, variables = {}) {
  const args = ["api", "query", query, "-o", "json", "-q"];
  for (const [k, v] of Object.entries(variables)) if (v !== undefined && v !== null) args.push("-v", `${k}=${v}`);
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync("linear-cli", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    let body;
    try {
      body = JSON.parse(r.stdout);
    } catch {
      body = { error: true, message: (r.stderr || r.stdout || "no output").trim() };
    }
    if (!body.error && !body.errors) return body.data;
    if (attempt >= 3) throw new Error(`Linear query failed: ${JSON.stringify(body).slice(0, 600)}`);
    spawnSync("sleep", [String(attempt * 2)]);
  }
}

function paged(query, variables, pick) {
  const nodes = [];
  let after;
  do {
    const conn = pick(gql(query, { ...variables, after }));
    nodes.push(...conn.nodes);
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : undefined;
  } while (after);
  return nodes;
}

const URL_RE = /https?:\/\/[^\s)<>\]"']+/g;
const links = (text) => [...new Set((text ?? "").match(URL_RE) ?? [])].map((u) => u.replace(/[.,;:]+$/, ""));

// 1. The initiative.
const found = gql(
  `query($name:String!){ initiatives(filter:{name:{eqIgnoreCase:$name}}, first:5){ nodes{
     id name url description content status targetDate owner{name}
     links{nodes{label url}} documents{nodes{title url updatedAt creator{name}}}
     initiativeUpdates(first:10){nodes{body health createdAt url user{name}}}
     projects(first:50){nodes{id}} } } }`,
  { name: initiativeName },
).initiatives.nodes;
if (found.length !== 1) throw new Error(`expected one initiative named '${initiativeName}', found ${found.length}`);
const ini = found[0];

// 2. Each project, its milestones, updates, documents, links and issues.
const ISSUE_FIELDS = `identifier title url description priority estimate createdAt startedAt completedAt canceledAt updatedAt
  state{name type} assignee{name} projectMilestone{id} labels{nodes{name}}`;
const projects = ini.projects.nodes.map(({ id }) => {
  const p = gql(
    `query($id:String!){ project(id:$id){ id name url description content state progress health startDate targetDate
       status{name type} lead{name}
       projectMilestones{nodes{id name description targetDate progress status sortOrder}}
       projectUpdates(first:10){nodes{body health createdAt url user{name}}}
       documents{nodes{title url updatedAt creator{name}}}
       externalLinks{nodes{label url}} } }`,
    { id },
  ).project;
  const issues = paged(
    `query($id:String!,$after:String){ project(id:$id){ issues(first:50, after:$after){ nodes{ ${ISSUE_FIELDS} } pageInfo{hasNextPage endCursor} } } }`,
    { id },
    (d) => d.project.issues,
  ).map((i) => ({ ...i, milestoneId: i.projectMilestone?.id ?? null, labels: i.labels.nodes.map((l) => l.name), projectMilestone: undefined }));
  const comments = paged(
    `query($id:ID!,$from:DateTimeOrDuration!,$to:DateTimeOrDuration!,$after:String){ comments(first:50, after:$after,
       filter:{ createdAt:{gte:$from, lt:$to}, issue:{ project:{ id:{eq:$id} } } }){
       nodes{ body createdAt url user{name} issue{identifier title url} } pageInfo{hasNextPage endCursor} } }`,
    { id, from: from.toISOString(), to: to.toISOString() },
    (d) => d.comments,
  );
  return { ...p, issues, comments };
});

// 3. Milestone counts and a derived status.
const TYPE = { completed: "done", canceled: "cancelled", duplicate: "cancelled", started: "started", unstarted: "todo", backlog: "backlog", triage: "backlog" };
function counts(issues) {
  const c = { total: 0, done: 0, started: 0, todo: 0, backlog: 0, cancelled: 0, doneThisWeek: 0, doneAndAddedThisWeek: 0, startedThisWeek: 0, addedThisWeek: 0 };
  for (const i of issues) {
    const t = TYPE[i.state.type] ?? "backlog";
    c[t]++;
    if (t !== "cancelled") c.total++;
    if (t === "done" && inWeek(i.completedAt)) c.doneThisWeek++;
    // Completed issues that were also created this week: high means small slices, so read
    // the completion count as activity rather than progress.
    if (t === "done" && inWeek(i.completedAt) && inWeek(i.createdAt)) c.doneAndAddedThisWeek++;
    if (inWeek(i.startedAt)) c.startedThisWeek++;
    if (inWeek(i.createdAt)) c.addedThisWeek++;
  }
  c.doneAtStart = c.done - c.doneThisWeek;
  c.totalAtStart = issues.filter((i) => i.createdAt < from.toISOString() && !(i.canceledAt && i.canceledAt < from.toISOString())).length;
  return c;
}
// done: Linear says done, or every live issue is done. at-risk: target date passed, or
// within 10 days of the week's end with less than 70% done. in-progress: anything done or
// started. not-started otherwise. content.json can override any of these.
function derive(m, c) {
  const pct = c.total ? c.done / c.total : 0;
  if (m.status === "done" || (c.total > 0 && c.done === c.total)) return "done";
  if (m.targetDate) {
    const daysLeft = (new Date(`${m.targetDate}T23:59:59Z`) - to) / 864e5;
    if (daysLeft < 0 || (daysLeft <= 10 && pct < 0.7)) return "at-risk";
  }
  if (c.done + c.started > 0) return "in-progress";
  return "not-started";
}
for (const p of projects) {
  const ms = [...p.projectMilestones.nodes].sort((a, b) => a.sortOrder - b.sortOrder);
  p.milestones = ms.map((m) => {
    const c = counts(p.issues.filter((i) => i.milestoneId === m.id));
    return { ...m, counts: c, derived: derive(m, c) };
  });
  const loose = p.issues.filter((i) => !i.milestoneId);
  p.unmilestoned = counts(loose);
  p.counts = counts(p.issues);
  delete p.projectMilestones;
}

// 4. Week activity and every link worth a look.
const nameOf = (p, id) => p.milestones.find((m) => m.id === id)?.name ?? "No milestone";
const activity = projects.flatMap((p) =>
  p.issues.flatMap((i) => {
    const out = [];
    if (i.state.type === "completed" && inWeek(i.completedAt)) out.push({ kind: "completed", at: i.completedAt });
    if (inWeek(i.startedAt) && i.state.type === "started") out.push({ kind: "started", at: i.startedAt });
    if (inWeek(i.createdAt)) out.push({ kind: "added", at: i.createdAt });
    if (["canceled", "duplicate"].includes(i.state.type) && inWeek(i.canceledAt)) out.push({ kind: "cancelled", at: i.canceledAt });
    return out.map((a) => ({ ...a, project: p.name, milestone: nameOf(p, i.milestoneId), id: i.identifier, title: i.title, url: i.url, assignee: i.assignee?.name ?? null, state: i.state.name }));
  }),
);
const linkSources = [
  ...links(ini.content).map((url) => ({ url, from: "initiative" })),
  ...ini.links.nodes.map((l) => ({ url: l.url, label: l.label, from: "initiative link" })),
  ...projects.flatMap((p) => [
    ...links(p.content).map((url) => ({ url, from: `${p.name} overview` })),
    ...p.externalLinks.nodes.map((l) => ({ url: l.url, label: l.label, from: `${p.name} link` })),
    ...p.milestones.flatMap((m) => links(m.description).map((url) => ({ url, from: `${p.name} · ${m.name}` }))),
    ...p.issues.filter((i) => inWeek(i.updatedAt)).flatMap((i) => links(i.description).map((url) => ({ url, from: i.identifier }))),
    ...p.comments.flatMap((c) => links(c.body).map((url) => ({ url, from: `comment on ${c.issue.identifier}` }))),
  ]),
];
const docLinks = [];
for (const l of linkSources) {
  if (!/files\.myslop\.app|plans\.myslop\.app|linear\.app\/[^/]+\/document|docs\.google|notion\.so/.test(l.url)) continue;
  // Per-ticket evidence documents are detail, not reading for a review.
  if (/\/document\/lle-\d+-(evidence|original)/.test(l.url)) continue;
  // Linear document URLs keep working when the title changes; match them on the trailing id.
  const key = (u) => u.match(/linear\.app\/[^/]+\/document\/.*-([0-9a-f]{12})$/)?.[1] ?? u;
  const seen = docLinks.find((d) => key(d.url) === key(l.url));
  if (seen) seen.from.includes(l.from) || seen.from.push(l.from);
  else docLinks.push({ ...l, from: [l.from] });
}

docLinks.sort((a, b) => b.from.length - a.from.length);

const data = {
  generatedAt: new Date().toISOString(),
  window: { from: from.toISOString(), to: to.toISOString(), fromDay: day(from), toDay: day(to) },
  initiative: { ...ini, projects: undefined },
  projects,
  activity: activity.sort((a, b) => a.at.localeCompare(b.at)),
  docLinks,
};
fs.writeFileSync(path.join(outDir, "data.json"), JSON.stringify(data, null, 2));

// 5. digest.md: the week for a reader (the agent writing content.json).
const pct = (c) => (c.total ? Math.round((100 * c.done) / c.total) : 0);
const md = [];
md.push(`# ${ini.name}: week ${day(from)} to ${day(to)} (exclusive)`, "", `Initiative: ${ini.url} · owner ${ini.owner?.name ?? "?"} · status ${ini.status} · target ${ini.targetDate ?? "none"}`, "", `> ${ini.description ?? ""}`, "");
for (const u of ini.initiativeUpdates.nodes) md.push(`- Initiative update ${u.createdAt.slice(0, 10)} (${u.user?.name}, ${u.health}): ${u.url}\n\n${u.body}\n`);
md.push("## Projects and milestones", "");
for (const p of projects) {
  const c = p.counts;
  md.push(`### ${p.name} (${p.status?.name}, lead ${p.lead?.name ?? "?"}, Linear progress ${Math.round(p.progress * 100)}%, target ${p.targetDate ?? "none"})`, p.url, "", `Issues: ${c.done}/${c.total} done (${pct(c)}%), ${c.started} in progress; this week ${c.doneThisWeek} done (${c.doneAndAddedThisWeek} of them also added this week), ${c.startedThisWeek} started, ${c.addedThisWeek} added.`, "");
  for (const m of p.milestones) {
    const k = m.counts;
    md.push(`- **${m.name}** [${m.derived}] target ${m.targetDate ?? "none"} · Linear ${Math.round(m.progress)}% · issues ${k.done}/${k.total} done (was ${k.doneAtStart}/${k.totalAtStart}), ${k.started} started; +${k.doneThisWeek} done this week`);
  }
  if (p.unmilestoned.total) md.push(`- _No milestone_: ${p.unmilestoned.done}/${p.unmilestoned.total} done, +${p.unmilestoned.doneThisWeek} this week`);
  for (const u of p.projectUpdates.nodes.filter((u) => inWeek(u.createdAt))) md.push("", `Project update ${u.createdAt.slice(0, 10)} (${u.user?.name}, ${u.health}): ${u.url}`, "", u.body);
  md.push("");
}
md.push("## Activity this week", "");
for (const kind of ["completed", "started", "added", "cancelled"]) {
  const rows = activity.filter((a) => a.kind === kind);
  md.push(`### ${kind} (${rows.length})`, "");
  for (const a of rows) md.push(`- ${a.at.slice(0, 10)} [${a.id}](${a.url}) ${a.title} · ${a.project} / ${a.milestone} · ${a.assignee ?? "unassigned"} · ${a.state}`);
  md.push("");
}
md.push("## Comments this week", "");
for (const p of projects) for (const c of p.comments) md.push(`- ${c.createdAt.slice(0, 16)} ${c.user?.name ?? "?"} on [${c.issue.identifier}](${c.url}) ${c.issue.title}: ${c.body.replace(/\s+/g, " ").slice(0, 600)}`);
md.push("", "## Documents and links", "");
for (const d of [...ini.documents.nodes, ...projects.flatMap((p) => p.documents.nodes)]) md.push(`- [${d.title}](${d.url}) updated ${d.updatedAt.slice(0, 10)}`);
for (const d of docLinks) md.push(`- ${d.label ? `${d.label}: ` : ""}${d.url} (from ${d.from.join(", ")})`);
fs.writeFileSync(path.join(outDir, "digest.md"), md.join("\n") + "\n");

const all = projects.reduce((s, p) => s + p.issues.length, 0);
console.log(`${ini.name}: ${projects.length} projects, ${projects.reduce((s, p) => s + p.milestones.length, 0)} milestones, ${all} issues, ${activity.filter((a) => a.kind === "completed").length} completed this week`);
console.log(`wrote ${path.join(outDir, "data.json")} and ${path.join(outDir, "digest.md")}`);
