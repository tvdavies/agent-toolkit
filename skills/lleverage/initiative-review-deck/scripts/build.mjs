#!/usr/bin/env node
// Build the initiative review deck HTML from gathered data and written content.
//
//   build.mjs DIR [--out DIR/deck.html]
//
// Reads DIR/data.json (from gather.mjs) and DIR/content.json (written by the agent, see
// references/content.md), starts from the brand kit's own layouts through the
// lleverage-presentations skill's new.mjs, and writes one fixed sequence of slides:
//
//   cover · direction · week at a glance · projects · one milestone slide per active
//   project · achieved · decisions · open questions · next steps · resources · close
//
// Render the result with lleverage-presentations' render.mjs. Nothing from the brand kit
// is copied into this skill; the kit stays in ~/.cache (see lleverage-presentations).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRES = process.env.LLEVERAGE_PRESENTATIONS_SCRIPTS
  ?? [path.resolve(here, "../../lleverage-presentations/scripts"), path.join(os.homedir(), ".agents/skills/lleverage-presentations/scripts")].find((d) => fs.existsSync(path.join(d, "new.mjs")));
if (!PRES) throw new Error("lleverage-presentations scripts not found; set LLEVERAGE_PRESENTATIONS_SCRIPTS");
const { splitPages } = await import(pathToFileURL(path.join(PRES, "lib/kit.mjs")).href);

const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith("--"));
if (!dir) {
  console.error("usage: build.mjs DIR [--out FILE]");
  process.exit(2);
}
const outIdx = argv.indexOf("--out");
const out = outIdx >= 0 ? argv[outIdx + 1] : path.join(dir, "deck.html");
const data = JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"));
const content = JSON.parse(fs.readFileSync(path.join(dir, "content.json"), "utf8"));

// ---------- helpers ----------
// No brand face draws arrow glyphs, and Linear names often carry them: write them as words.
const esc = (s) => String(s ?? "").replace(/\s*[→⟶]\s*/g, " to ").replace(/\s*[←⟵]\s*/g, " from ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Light inline markup in content strings: **bold** only.
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const shortDate = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}` : "");
const workspace = data.initiative.url.match(/linear\.app\/([^/]+)\//)?.[1] ?? "lleverage";
const issueUrl = new Map(data.projects.flatMap((p) => p.issues.map((i) => [i.identifier, i.url])));
const warnings = [];

// A ref is "LLE-123", a URL, or {label, url}. Rendered as a mono link.
function ref(r) {
  if (!r) return "";
  if (typeof r === "object") return `<a href="${esc(r.url)}">${esc(r.label ?? shortUrl(r.url))}</a>`;
  if (/^[A-Z]{2,6}-\d+$/.test(r)) return `<a href="${esc(issueUrl.get(r) ?? `https://linear.app/${workspace}/issue/${r}`)}">${r}</a>`;
  if (/^https?:\/\//.test(r)) return `<a href="${esc(r)}">${esc(shortUrl(r))}</a>`;
  warnings.push(`unlinked source: ${r}`);
  return esc(r);
}
function shortUrl(u) {
  const m = u.match(/^https?:\/\/([^/]+)(\/.*)?$/);
  if (!m) return u;
  const [, host, rest = ""] = m;
  if (/slack\.com/.test(host)) return `Slack ${rest.split("/")[2] ?? ""}`.trim();
  if (/linear\.app/.test(host)) {
    const seg = rest.split("/").filter(Boolean);
    const kind = seg[1];
    const name = (seg[2] ?? "").replace(/-[0-9a-f]{12}$/, "").replace(/-/g, " ");
    return `Linear ${kind} · ${name}`.slice(0, 60);
  }
  if (/github\.com/.test(host)) return rest.replace(/^\/[^/]+\//, "").replace("/pull/", "#");
  return `${host}${rest.replace(/\.html$/, "").replace(/^\/[0-9a-f]{10}\//, "/")}`.slice(0, 60);
}
const refs = (list) => (list ?? []).map(ref).join(" · ");
const sources = (list, top = 598) =>
  list?.length ? `<div class="micro irr-src" style="position:absolute;left:64px;top:${top}px;width:1152px;">SOURCES&nbsp;&nbsp;${refs(list)}</div>` : "";

// ---------- the kit's own layouts ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "irr-"));
const seed = path.join(tmp, "seed.html");
const made = spawnSync("node", [path.join(PRES, "new.mjs"), "--deck", seed, "Cover — dark", "Title only", "Close — dark"], { encoding: "utf8" });
if (made.status !== 0) throw new Error(`new.mjs failed: ${made.stderr || made.stdout}`);
const { head, pages, tail } = splitPages(fs.readFileSync(seed, "utf8"), "deck");
const [coverTpl, titleTpl, closeTpl] = pages;

// Replace what is inside one data-ph box; the box and its geometry stay as the kit drew them.
function fillPh(page, ph, inner) {
  const re = new RegExp(`(<div class="ph" data-ph="${ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>)(.*)(</div>)\\s*$`, "m");
  if (!re.test(page)) throw new Error(`placeholder ${ph} not found in layout`);
  return page.replace(re, (_, open, _inner, close) => `${open}${inner}${close}`);
}

let slideNo = 0;
function titleSlide(kicker, title, body) {
  slideNo++;
  const nn = String(slideNo).padStart(2, "0");
  let s = titleTpl
    .replace(/<h2 class="h2">[\s\S]*?<\/h2>/, `<h2 class="h2">${md(title)}</h2>`)
    .replace(/(<span style="color:var\(--ll-text-accent\);font-weight:700;">\/<\/span>)[^<]*/, `$1 ${esc(kicker.toUpperCase())} · ${nn}`);
  const start = s.indexOf("</div></div>", s.indexOf('class="kick-row"')) + "</div></div>".length;
  const end = s.indexOf('<hr class="ftr-rule">');
  return s.slice(0, start) + "\n" + body + "\n" + s.slice(end);
}

// ---------- data shaping ----------
const win = data.window;
const weekLabel = content.weekLabel ?? `${shortDate(win.fromDay)} – ${shortDate(new Date(Date.parse(win.to) - 864e5).toISOString())}`;
const projOverride = content.projects ?? {};
const projects = data.projects
  .filter((p) => !(projOverride[p.name]?.hide))
  .map((p) => ({ ...p, o: projOverride[p.name] ?? {} }))
  .sort((a, b) => (a.o.order ?? 99) - (b.o.order ?? 99) || b.counts.doneThisWeek - a.counts.doneThisWeek || b.counts.total - a.counts.total);
const msStatus = (p, m) => p.o.milestones?.[m.name]?.status ?? m.derived;
const STATUS = {
  done: ["Done", "tag"],
  "in-progress": ["In progress", "tag"],
  "at-risk": ["At risk", "tag solid"],
  "not-started": ["Not started", "tag irr-quiet"],
};
const tag = (s) => `<span class="${STATUS[s]?.[1] ?? "tag"}">${STATUS[s]?.[0] ?? esc(s)}</span>`;
// Bar: ink for done before the week, orange for done this week (the slide's one orange
// series), grey track for the rest; dashed outline when nothing has started.
function bar(c, notStarted = false) {
  const before = c.total ? (100 * (c.done - c.doneThisWeek)) / c.total : 0;
  const week = c.total ? (100 * c.doneThisWeek) / c.total : 0;
  const track = notStarted ? "irr-track irr-dashed" : "irr-track bar-track";
  return `<div class="${track}"><div class="bar-fill" style="width:${before.toFixed(1)}%"></div><div class="bar-fill accent" style="width:${week.toFixed(1)}%"></div></div>`;
}
const countLine = (c, extra = []) =>
  [`${c.done} / ${c.total} issues done`, c.doneThisWeek ? `+${c.doneThisWeek} this week` : "none this week", ...extra].filter(Boolean).join(" · ");

const slides = [];

// 1. Cover
{
  const c = content.cover ?? {};
  let s = coverTpl;
  s = fillPh(s, "body:20", `<div class="k" style="color:var(--ll-text-onDarkMuted);">${esc((c.kicker ?? `${data.initiative.name} · initiative review · ${shortDate(win.toDay)}`).toUpperCase())}</div>`);
  s = fillPh(s, "ctrTitle:", `<h1 class="h1" style="margin:0;color:var(--ll-text-onDark);">${md(c.title ?? data.initiative.name)}${c.titleAccent ? `<br><span style="color:var(--ll-text-accent);">${md(c.titleAccent)}</span>` : ""}</h1>`);
  s = fillPh(s, "subTitle:1", `<p class="p" style="color:var(--ll-text-onDarkMuted);">${md(c.subtitle ?? data.initiative.description)}</p>`);
  const cells = c.cells ?? [
    ["Prepared for", "Initiative review"],
    ["Owner", data.initiative.owner?.name ?? ""],
    ["Week", weekLabel],
    ["Status", `${data.initiative.status} · to ${shortDate(data.initiative.targetDate)}`],
  ];
  cells.slice(0, 4).forEach(([k, v], i) => {
    s = fillPh(s, `body:1${i}`, `<div class="k" style="color:var(--ll-text-onDarkMuted);">${esc(k.toUpperCase())}</div><div class="h3" style="padding-top:6px;color:var(--ll-text-onDark);">${esc(v)}</div>`);
  });
  slideNo++;
  slides.push(s);
}

// 2. Direction: aim, measures and the dated path
{
  const d = content.direction ?? {};
  const road = d.roadmap ?? [];
  const body = `
<div style="position:absolute;left:64px;top:186px;width:560px;">
  <div class="k">THE AIM</div>
  <p class="lead" style="padding-top:8px;color:var(--ll-text-primary);">${md(d.aim ?? data.initiative.description)}</p>
</div>
<div style="position:absolute;left:672px;top:186px;width:544px;">
  <div class="k">HOW WE MEASURE IT</div>
  <ul class="bul" style="padding-top:4px;">${(d.measures ?? []).map((m) => `<li>${md(m)}</li>`).join("")}</ul>
</div>
${road.length ? `<div class="phase" style="position:absolute;left:64px;top:${d.roadmapTop ?? 400}px;width:1152px;">${road
    .map((r) => `<div class="${r.now ? "now" : ""}"><div class="k">${esc(r.when)}</div><div class="h3" style="padding-top:4px;">${md(r.label)}</div><p class="p" style="padding-top:4px;">${md(r.detail ?? "")}</p></div>`)
    .join("")}</div>` : ""}
${sources(d.sources)}`;
  slides.push(titleSlide("Direction", d.title ?? `Where ${data.initiative.name} is going`, body));
}

// 3. The week at a glance: four numbers and completions per project
{
  const g = content.glance ?? {};
  const all = projects.reduce((s, p) => s + p.counts.doneThisWeek, 0);
  const started = projects.reduce((s, p) => s + p.counts.startedThisWeek, 0);
  const msDone = projects.flatMap((p) => p.milestones.filter((m) => msStatus(p, m) === "done" && m.counts.doneThisWeek > 0)).length;
  const atRisk = projects.flatMap((p) => p.milestones.filter((m) => msStatus(p, m) === "at-risk")).length;
  const stats = g.stats ?? [
    [String(all), "issues completed"],
    [String(started), "issues started"],
    [String((content.decisions ?? []).length), "decisions recorded"],
    [String(atRisk), atRisk === 1 ? "milestone at risk" : "milestones at risk"],
  ];
  void msDone;
  const max = Math.max(1, ...projects.map((p) => p.counts.doneThisWeek));
  const top = projects.reduce((a, p) => (p.counts.doneThisWeek > (a?.counts.doneThisWeek ?? -1) ? p : a), null);
  // Rows start at about 324px (top 300 plus the heading). Seven 30px rows end at 534, so the
  // note fits at 548; more projects get shorter rows and push the note's default down.
  const hrowH = projects.length > 7 ? 26 : 30;
  const rowsEnd = 324 + projects.length * hrowH;
  const noteTop = g.noteTop ?? Math.max(548, rowsEnd + 12);
  if (g.note && noteTop < rowsEnd + 8) warnings.push(`glance: noteTop ${noteTop} overlaps the project rows, which end at about ${rowsEnd}px`);
  if (g.note && noteTop > 560) warnings.push(`glance: the note starts at ${noteTop}px, so keep it to one line or it runs into the sources`);
  const rows = projects
    .map((p) => `<div class="irr-hrow" style="height:${hrowH}px"><div class="irr-hlabel">${esc(p.name)}</div><div class="irr-hbar"><i class="${p === top ? "accent" : ""}" style="width:calc((100% - 48px) * ${(p.counts.doneThisWeek / max).toFixed(3)})"></i><span>${p.counts.doneThisWeek}</span></div></div>`)
    .join("");
  const body = `
${stats.slice(0, 4).map(([v, l], i) => `<div class="stat" style="position:absolute;left:${64 + i * 296}px;top:190px;width:264px;"><span class="v">${esc(v)}</span><div class="l">${esc(l)}</div></div>`).join("")}
<div style="position:absolute;left:64px;top:300px;width:1152px;"><div class="k" style="padding-bottom:8px;">ISSUES COMPLETED THIS WEEK, BY PROJECT</div>${rows}</div>
${g.note ? `<div class="irr-note" style="position:absolute;left:64px;top:${noteTop}px;width:1152px;"><p class="p">${md(g.note)}</p></div>` : ""}
${sources(g.sources ?? [data.initiative.url])}`;
  slides.push(titleSlide("This week", g.title ?? `${all} issues completed across ${projects.filter((p) => p.counts.doneThisWeek).length} projects`, body));
}

// 4. Projects overview
{
  const o = content.overview ?? {};
  // Rows run from 186px to the legend at 576px: seven fit at 54px, more get shorter rows.
  const prowH = Math.min(54, Math.floor(384 / Math.max(1, projects.length)));
  if (prowH < 44) warnings.push(`overview: ${projects.length} projects leave ${prowH}px rows; hide some with content.projects.<name>.hide`);
  const rows = projects
    .map((p) => {
      const ms = p.milestones.filter((m) => m.counts.total);
      const by = (s) => ms.filter((m) => msStatus(p, m) === s).length;
      const summary = [by("done") && `${by("done")} done`, by("in-progress") && `${by("in-progress")} in progress`, by("at-risk") && `${by("at-risk")} at risk`, by("not-started") && `${by("not-started")} not started`].filter(Boolean).join(" · ");
      return `<div class="irr-prow" style="height:${prowH}px">
  <div><a class="h3" href="${esc(p.url)}">${esc(p.name)}</a><div class="micro">${esc(p.lead?.name ?? "")}${p.status?.name ? ` · ${esc(p.status.name)}` : ""}</div></div>
  <div>${bar(p.counts, p.counts.done + p.counts.started === 0)}<div class="micro" style="padding-top:6px;">${esc(countLine(p.counts))}</div></div>
  <div class="micro irr-right">${esc(summary || "no milestones")}</div>
</div>`;
    })
    .join("");
  const body = `<div style="position:absolute;left:64px;top:186px;width:1152px;">${rows}</div>
<div class="micro irr-legend" style="position:absolute;left:64px;top:576px;width:1152px;"><i class="irr-key"></i>done before this week <i class="irr-key accent"></i>done this week <i class="irr-key grey"></i>open</div>
${sources(o.sources ?? [data.initiative.url])}`;
  slides.push(titleSlide("Projects", o.title ?? `${projects.length} projects carry the initiative`, body));
}

// 5. Milestones, one slide per active project (two columns, six rows each)
for (const p of projects) {
  const showAll = p.o.slide === true;
  // Own slide when the project moved (3+ issues done this week) or content.json asks for one.
  if (p.o.slide === false || (!showAll && p.counts.doneThisWeek < 3)) continue;
  const ms = p.milestones.filter((m) => m.counts.total > 0);
  const hidden = p.milestones.length - ms.length;
  const tiles = ms.map((m) => {
    const s = msStatus(p, m);
    const extra = [m.targetDate && `due ${shortDate(m.targetDate)}`].filter(Boolean);
    return `<div class="irr-tile"><div class="irr-tile-top"><span class="irr-name">${esc(m.name)}</span>${tag(s)}</div>${bar(m.counts, s === "not-started")}<div class="micro" style="padding-top:6px;">${esc(countLine(m.counts, extra))}</div></div>`;
  });
  if (p.unmilestoned.total) tiles.push(`<div class="irr-tile"><div class="irr-tile-top"><span class="irr-name">No milestone</span></div>${bar(p.unmilestoned)}<div class="micro" style="padding-top:6px;">${esc(countLine(p.unmilestoned))}</div></div>`);
  for (let i = 0; i < tiles.length; i += 12) {
    const chunk = tiles.slice(i, i + 12);
    const col = (xs) => xs.join("");
    const body = `<div class="irr-cols" style="position:absolute;left:64px;top:186px;width:1152px;"><div>${col(chunk.slice(0, 6))}</div><div>${col(chunk.slice(6, 12))}</div></div>
${sources([{ label: `Linear project · ${p.name}`, url: p.url }, ...(p.o.sources ?? [])].concat(hidden ? [{ label: `${hidden} ${hidden === 1 ? "milestone" : "milestones"} without issues not shown`, url: p.url }] : []))}`;
    slides.push(titleSlide("Milestones", p.o.title ?? `${p.name}: ${p.counts.done} of ${p.counts.total} issues done, ${p.counts.doneThisWeek} this week`, body));
  }
}

// 6. Achieved this week: up to four cards
{
  const a = content.achieved ?? {};
  const cards = (a.cards ?? []).slice(0, 4);
  const w = 560, h = cards.length > 2 ? 212 : 424;
  // A quarter-slide card holds two short points; a half-slide card holds five.
  const maxPoints = cards.length > 2 ? 2 : 5;
  for (const c of cards) {
    if ((c.points ?? []).length > maxPoints) {
      warnings.push(`achieved card "${c.title}": ${c.points.length} points, showing ${maxPoints}`);
      c.points = c.points.slice(0, maxPoints);
    }
  }
  const body = cards
    .map((c, i) => `<div class="card irr-card" style="position:absolute;left:${64 + (i % 2) * (w + 32)}px;top:${186 + Math.floor(i / 2) * (h + 16)}px;width:${w}px;height:${h}px;">
  <div class="k">${esc((c.kicker ?? "").toUpperCase())}</div><div class="h3" style="padding-top:4px;">${md(c.title)}</div>
  <ul class="bul">${(c.points ?? []).map((pt) => `<li>${md(pt)}</li>`).join("")}</ul>
  <div class="micro irr-card-src">${refs(c.sources)}</div></div>`)
    .join("\n");
  slides.push(titleSlide("Achieved", a.title ?? "What landed this week", body));
}

// 7–9. Decisions, open questions, next steps: one table each
function tableSlide(kicker, section, cols) {
  const rows = (section?.rows ?? []).slice(0, 7);
  if (!rows.length) {
    warnings.push(`${kicker}: no rows`);
    return;
  }
  const body = `<div style="position:absolute;left:64px;top:186px;width:1152px;"><table class="irr-table">
<thead><tr>${cols.map((c) => `<th style="width:${c.w}">${esc(c.head)}</th>`).join("")}</tr></thead>
<tbody>${rows
    .map((r) => `<tr>${cols.map((c) => `<td>${c.key === "sources" ? `<span class="micro">${refs(r.sources)}</span>` : c.key === "what" ? `<b>${md(r.what)}</b>${r.detail ? `<div class="irr-detail">${md(r.detail)}</div>` : ""}` : md(r[c.key] ?? "")}</td>`).join("")}</tr>`)
    .join("\n")}</tbody></table></div>`;
  slides.push(titleSlide(kicker, section.title, body));
}
tableSlide("Decisions", content.decisions && { title: content.decisionsTitle ?? "Decisions made this week", rows: content.decisions }, [
  { head: "Decision", key: "what", w: "62%" },
  { head: "Who · when", key: "who", w: "14%" },
  { head: "Source", key: "sources", w: "24%" },
]);
tableSlide("Open questions", content.questions && { title: content.questionsTitle ?? "Open questions", rows: content.questions }, [
  { head: "Question", key: "what", w: "62%" },
  { head: "Who decides", key: "who", w: "14%" },
  { head: "Source", key: "sources", w: "24%" },
]);
tableSlide("Next", content.next && { title: content.nextTitle ?? "Next steps", rows: content.next }, [
  { head: "Next step", key: "what", w: "56%" },
  { head: "Owner", key: "who", w: "12%" },
  { head: "When", key: "when", w: "10%" },
  { head: "Source", key: "sources", w: "22%" },
]);

// 10. Resources: Linear first, then plans and reports
{
  const r = content.resources ?? {};
  // Project links carry no sub-line, so a seven-project initiative still fits one column.
  const linear = [{ label: `Initiative · ${data.initiative.name}`, url: data.initiative.url }, ...projects.map((p) => ({ label: p.name, url: p.url, note: "" }))];
  const groups = [["Linear", linear], ...(r.groups ?? []).map((g) => [g.name, g.links])];
  const width = Math.floor((1152 - 32 * (groups.length - 1)) / groups.length);
  const body = groups
    .map(([name, links], i) => `<div style="position:absolute;left:${64 + i * (width + 32)}px;top:186px;width:${width}px;"><div class="head"><span class="name">${esc(name)}</span></div>
${links.map((l) => `<div class="irr-res"><a href="${esc(l.url)}">${md(l.label)}</a>${l.note === "" ? "" : `<div class="micro">${esc(l.note ?? shortUrl(l.url))}</div>`}</div>`).join("")}</div>`)
    .join("\n");
  slides.push(titleSlide("Resources", r.title ?? "Where to read up", body));
}

// 11. Close
{
  const c = content.close ?? {};
  let s = closeTpl;
  s = fillPh(s, "title:", `<div class="h1" style="text-align:center;color:var(--ll-text-onDark);">${md(c.title ?? "Questions")}</div>`);
  s = fillPh(s, "body:1", `<div class="k" style="color:var(--ll-text-accent);text-align:center;">${esc((c.line1 ?? data.initiative.name).toUpperCase())}</div>`);
  s = fillPh(s, "body:2", `<div class="k" style="text-align:center;color:var(--ll-text-onDarkMuted);">${esc((c.line2 ?? `Generated from Linear · ${data.generatedAt.slice(0, 16).replace("T", " ")} UTC`).toUpperCase())}</div>`);
  slideNo++;
  slides.push(s);
}

// Layout helpers for this template, in the kit's tokens only.
const STYLE = `<style>/* initiative-review-deck */
.deck a{color:inherit;text-decoration:none}
.irr-src a,.irr-card-src a,.irr-table .micro a{border-bottom:var(--ll-stroke-structure) solid var(--ll-surface-hairline)}
.irr-track{position:relative;display:flex;height:6px;margin-top:8px}
.irr-track .bar-fill{height:6px}
.irr-dashed{background:none;outline:var(--ll-stroke-structure) dashed var(--ll-color-grey-700);outline-offset:-1px}
.tag.irr-quiet{color:var(--ll-text-muted);border-color:var(--ll-surface-hairline)}
.irr-cols{display:grid;grid-template-columns:1fr 1fr;column-gap:32px}
.irr-tile{height:66px;border-bottom:var(--ll-stroke-structure) solid var(--ll-surface-hairline);padding-top:8px}
.irr-tile-top{display:flex;justify-content:space-between;align-items:center;gap:12px}
.irr-name{font-family:var(--ll-font-sans);font-weight:600;font-size:var(--ll-type-body);color:var(--ll-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.irr-prow{display:grid;grid-template-columns:300px 1fr 260px;column-gap:32px;align-items:center;height:54px;border-bottom:var(--ll-stroke-structure) solid var(--ll-surface-hairline)}
.irr-prow .h3{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.irr-right{text-align:right}
.irr-legend{display:flex;align-items:center;gap:8px}
.irr-key{display:inline-block;width:16px;height:6px;background:var(--ll-text-primary);margin-left:16px}
.irr-key:first-child{margin-left:0}
.irr-key.accent{background:var(--ll-color-orange-primary)}
.irr-key.grey{background:var(--ll-surface-bar)}
.irr-hrow{display:grid;grid-template-columns:300px 1fr;column-gap:32px;align-items:center;height:30px}
.irr-hlabel{font-size:var(--ll-type-body);color:var(--ll-text-primary)}
.irr-hbar{display:flex;align-items:center;gap:8px}
.irr-hbar i{display:block;height:14px;background:var(--ll-surface-bar);min-width:1px}
.irr-hbar i.accent{background:var(--ll-color-orange-primary)}
.irr-hbar span{font-family:var(--ll-font-sans);font-weight:700;font-size:var(--ll-type-body);color:var(--ll-text-primary)}
.irr-card{display:flex;flex-direction:column}
.irr-card ul.bul{flex:1}
.irr-card-src{padding-top:6px}
.irr-table td{vertical-align:top}
.irr-detail{padding-top:2px}
.irr-res{padding:8px 0;border-bottom:var(--ll-stroke-structure) solid var(--ll-surface-hairline)}
.irr-res a{font-size:var(--ll-type-body);color:var(--ll-text-primary);font-weight:600}
</style>
`;

// Kit 2.3.4 ships its logo sprite inside a <style> comment (after the text "<body>" in a
// CSS comment), so every <use href="#ll-logo-*"> renders nothing. Move the sprite into the
// real <body> until the design system fixes the reference file.
function liftSprite(html) {
  const start = html.search(/<svg aria-hidden="true" style="position:absolute;width:0;height:0[^"]*">\s*<symbol id="ll-logo-/);
  const body = html.match(/<body\s[^>]*class="[^"]*\bdeck\b[^"]*"[^>]*>/);
  if (start < 0 || !body || start > body.index) return html;
  const end = html.indexOf("</svg>", html.lastIndexOf("</symbol>")) + "</svg>".length;
  const sprite = html.slice(start, end);
  const rest = html.slice(0, start) + html.slice(end);
  const at = rest.indexOf(body[0]) + body[0].length;
  warnings.push("moved the kit's logo sprite out of its <style> block (kit bug; report to the design-system owner)");
  return rest.slice(0, at) + sprite + rest.slice(at);
}

fs.writeFileSync(out, liftSprite(head.replace("</head>", `${STYLE}</head>`) + slides.join("\n") + tail));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${out}: ${slides.length} slides`);
for (const w of warnings) console.warn(`warning: ${w}`);
