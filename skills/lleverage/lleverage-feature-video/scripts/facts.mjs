#!/usr/bin/env node
// What someone shipped: merged PRs on main for an author and window, from the lleverage checkout (squash merges,
// so one commit is one PR). Writes <dir>/facts.json and prints the list to plan chapters from.
//   node facts.mjs <dir> --author "Tom Davies" --since 2026-10-02T12:00 [--until 2026-10-09] [--others]
// --others adds a per-author count for everyone else (for "what the team shipped" or a credits card).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appRepo } from "./lib/repo.mjs";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const dir = path.resolve(args[0] && !args[0].startsWith("--") ? args[0] : ".");
const author = opt("--author"), since = opt("--since"), until = opt("--until");
if (!author || !since) { console.error('usage: facts.mjs <dir> --author "Name" --since <date> [--until <date>] [--others]'); process.exit(1); }
const repo = appRepo();
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });
try { git("fetch", "--quiet", "origin", "main"); } catch { console.warn("git fetch failed; using the local origin/main"); }
const range = ["--since", since, ...(until ? ["--until", until] : [])];
const log = (extra) => git("log", "origin/main", ...range, "--format=%H%x09%ad%x09%an%x09%s", "--date=format-local:%Y-%m-%d %a", ...extra).trim().split("\n").filter(Boolean)
  .map((l) => { const [sha, date, name, subject] = l.split("\t"); return { sha: sha.slice(0, 10), date: date.slice(0, 10), day: date.slice(11), author: name, subject }; });
const mine = log(["--author", author]).map((c) => ({ ...c, pr: Number((c.subject.match(/\(#(\d+)\)\s*$/) || [])[1]) || null, issues: [...new Set(c.subject.match(/LLE-\d+/g) || [])],
  title: c.subject.replace(/\s*\(#\d+\)\s*$/, "").replace(/^(LLE-\d+[,:]?\s*)+/, "").replace(/\s*\((LLE-\d+(, )?)+\)$/, "") }));
const byDay = {};
for (const c of [...mine].reverse()) byDay[c.date] = { day: c.day, n: (byDay[c.date]?.n || 0) + 1 };
const facts = { author, since, until: until || null, total: mine.length, days: Object.entries(byDay).map(([date, v]) => ({ date, ...v })), prs: mine };
if (args.includes("--others")) {
  const counts = {}; for (const c of log([])) if (c.author !== author) counts[c.author] = (counts[c.author] || 0) + 1;
  facts.others = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
}
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "facts.json"), JSON.stringify(facts, null, 1));
console.log(`${author}: ${mine.length} PRs merged to main since ${since}${until ? " until " + until : ""}`);
console.log("per day: " + facts.days.map((d) => `${d.day} ${d.date.slice(5)} ${d.n}`).join(" · "));
if (facts.others) console.log("others: " + facts.others.map((o) => `${o.name} ${o.n}`).join(", "));
console.log("");
for (const c of mine) console.log(`${c.date} #${c.pr ?? "?"} ${c.title}`);
