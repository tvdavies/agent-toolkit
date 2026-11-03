// Renders data.json (from gather.mjs) as digest.md: hints first, then a one-line
// index of every work item. Full bodies, files, descriptions and comments stay in
// data.json; show.mjs prints them for the items the analysis wants to look at.

import { linearIds, overlaps, similarTitles } from "./lib.mjs";

export const clip = (s, n) => {
  const t = String(s ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[image]")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
    .replace(/\r/g, "")
    .trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
export const oneLine = (s, n) => clip(String(s ?? "").replace(/\s+/g, " "), n);
export const linearUrl = (id) => `https://linear.app/lleverage/issue/${id}`;
const short = (iso) => (iso ?? "").slice(5, 16).replace("T", " ");
const ORDER = { DRAFT: 0, OPEN: 1, MERGED: 2, CLOSED: 3 };
const BROAD_FILES = 100;

export function renderDigest(data, { meLinear = "Tom Davies", openDays = 21 } = {}) {
  const L = [];
  const { github, linear } = data;
  const keys = linear?.keys ?? ["LLE"];
  const prs = github ? github.repos.flatMap((r) => r.prs) : [];
  const open = github ? github.repos.flatMap((r) => r.openPrs) : [];
  const branches = github ? github.repos.flatMap((r) => r.branches) : [];
  const issues = linear?.issues ?? [];

  L.push(`# Team radar digest`, "");
  L.push(`Window: ${data.window.since} → ${data.window.until} (${data.window.basis}).`);
  L.push(`Counts: ${prs.filter((p) => !p.self).length} PRs by others and ${prs.filter((p) => p.self).length} by Tom updated, ${branches.length} new branches without a PR, ${issues.length} Linear issues with human activity (${linear?.teamsScanned?.join(", ") ?? "Linear skipped"}).`);
  L.push(`One line per item. Details: scripts/show.mjs --data <dir>/data.json <PR URL | owner/repo#N | LLE-123 | branch URL>.`);
  L.push(`(Tom) marks Tom's own work: it matters only where it meets someone else's.`, "");

  L.push("## Not reached", "");
  L.push(data.gaps.length ? data.gaps.map((g) => `- ${g}`).join("\n") : "Nothing: every GitHub and Linear source answered.");
  L.push("");

  if (github) {
    // A PR at GitHub's 100-file cap is usually a branch carrying unrelated commits (a
    // staging twin cut from main, an un-rebased stack): its file list says nothing.
    const broad = [...prs, ...open].filter((p) => p.state !== "CLOSED" && p.state !== "MERGED" && (p.files?.length ?? 0) >= BROAD_FILES);
    const items = [
      ...[...prs, ...open].filter((p) => !broad.includes(p)).map((p) => ({ ref: p.url, author: p.author, state: p.state, self: p.self, files: p.files })),
      ...branches.map((b) => ({ ref: b.url, author: b.author, state: "BRANCH", self: b.self, files: b.files ?? [] })),
    ];
    const ov = overlaps(items).slice(0, 30);
    L.push(`## Hint: unshipped work touching the same files as someone else's`, "");
    L.push("Mechanical pairs: different people, at least one side not merged. Most are harmless; look hardest at schema, migration, API and auth areas.", "");
    if (ov.length === 0) L.push("None.");
    for (const o of ov) {
      const shown = o.files.slice(0, 4).join(", ") + (o.files.length > 4 ? ` …+${o.files.length - 4}` : "");
      L.push(`- ${o.items.map((i) => `${i.ref} (${i.author}, ${i.state})`).join(" ⇄ ")}${o.areas.length ? ` [${o.areas.join(", ")}]` : ""}: ${shown}`);
    }
    if (broad.length) L.push("", `Left out (${BROAD_FILES}+ files, too broad to compare): ${broad.map((p) => `${p.ref} (${p.author})`).join(", ")}`);
    L.push("");
  }

  const titled = [
    ...prs.filter((p) => p.state !== "CLOSED").map((p) => ({ ref: p.url, author: p.author, title: p.title, self: p.self })),
    ...branches.map((b) => ({ ref: b.url, author: b.author, title: b.name.replace(/[-_/]+/g, " "), self: b.self })),
    ...issues
      .filter((i) => i.activity.events.some((e) => e.what === "created"))
      .map((i) => ({ ref: i.identifier, author: i.assignee?.name ?? i.creator?.name ?? "none", title: i.title, self: (i.assignee?.name ?? i.creator?.name) === meLinear })),
  ];
  // A PR and the ticket it names are the same work, whoever's account opened them.
  const linked = new Set(prs.flatMap((p) => p.linear.map((id) => `${p.url} ${id}`)));
  const sim = similarTitles(titled)
    .filter((s) => !s.items.some((a) => s.items.some((b) => linked.has(`${a.ref} ${b.ref}`))))
    .filter((s) => !s.items.every((i) => titled.find((t) => t.ref === i.ref)?.self))
    .slice(0, 20);
  L.push(`## Hint: similar titles from different people (possible duplicate work)`, "");
  L.push(sim.length ? sim.map((s) => `- ${s.score}: ${s.items.map((i) => `${i.ref} (${i.author}) "${oneLine(i.title, 80)}"`).join(" ⇄ ")}`).join("\n") : "None.");
  L.push("");

  if (github) {
    const noTicket = prs.filter((p) => !p.self && p.linear.length === 0 && p.state !== "CLOSED");
    L.push(`## Hint: others' PRs with no Linear ID in title, branch or body`, "");
    if (noTicket.length === 0) L.push("None.");
    // One person's run of unticketed PRs in one repo (content, marketing sites) is one line.
    const groups = new Map();
    for (const p of noTicket) groups.set(`${p.repo} ${p.author}`, [...(groups.get(`${p.repo} ${p.author}`) ?? []), p]);
    for (const list of groups.values()) {
      const shown = list.length > 4 ? list.slice(0, 2) : list;
      for (const p of shown) L.push(`- ${p.url} (${p.author}, ${p.state}) "${oneLine(p.title, 100)}"`);
      if (shown.length < list.length) L.push(`- …and ${list.length - shown.length} more by ${list[0].author} in ${list[0].repo}`);
    }
    L.push("");

    L.push(`## PRs by others updated in the window`, "");
    L.push(`Repos pushed in the window: ${github.scanned.join(", ") || "none"}.`, "");
    for (const r of github.repos) {
      const list = r.prs.filter((p) => !p.self);
      if (list.length === 0) continue;
      L.push(`### ${r.repo}`, "");
      for (const p of list.sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.updatedAt.localeCompare(a.updatedAt))) {
        const when = p.mergedAt ? `merged ${short(p.mergedAt)}` : `upd ${short(p.updatedAt)}`;
        L.push(`- ${p.state} ${p.url} ${p.author} "${oneLine(p.title, 120)}" ${when} +${p.additions}/-${p.deletions} ${p.linear.join(" ") || "no-ticket"}${p.areas.length ? ` [${p.areas.join(",")}]` : ""}`);
      }
      L.push("");
    }

    const mine = prs.filter((p) => p.self);
    L.push(`## Tom's PRs updated in the window (for conflicts only)`, "");
    const byRepo = new Map();
    for (const p of mine) byRepo.set(p.repo, [...(byRepo.get(p.repo) ?? []), p]);
    for (const [repo, list] of byRepo) {
      const othersHere = [...prs, ...open, ...branches].some((x) => x.repo === repo && !x.self);
      if (!othersHere) {
        L.push(`- ${repo}: ${list.length} PRs, nobody else active there, not listed`);
        continue;
      }
      for (const p of list) L.push(`- ${p.state} ${p.url} "${oneLine(p.title, 100)}" ${p.linear.join(" ")}${p.areas.length ? ` [${p.areas.join(",")}]` : ""}`);
    }
    L.push("");

    const openOthers = open.filter((p) => !p.self);
    if (openOthers.length) {
      L.push(`## Others' open PRs not updated in the window (last ${openDays} days)`, "");
      for (const p of openOthers) L.push(`- ${p.state} ${p.url} ${p.author} "${oneLine(p.title, 100)}" upd ${p.updatedAt.slice(0, 10)} ${p.linear.join(" ")}`);
      L.push("");
    }

    L.push(`## Branches with new commits that have never had a PR`, "");
    const branchOthers = branches.filter((b) => !b.self);
    if (branchOthers.length === 0) L.push("None from others.");
    for (const b of branchOthers) {
      const ids = linearIds(b.name, keys);
      L.push(`- ${b.url} ${b.author} last commit ${short(b.committedAt)} "${oneLine(b.headline, 90)}"${b.ahead != null ? ` ${b.ahead} ahead/${b.behind} behind, ${b.files?.length ?? 0} files` : ""} ${ids.join(" ") || "no-ticket"}${b.areas?.length ? ` [${b.areas.join(",")}]` : ""}`);
    }
    const branchMine = branches.filter((b) => b.self);
    if (branchMine.length) L.push(`- Tom: ${branchMine.length} branches without a PR, not listed`);
    L.push("");
  }

  if (linear) {
    L.push(`## Linear issues with human activity in the window`, "");
    L.push("Plain status moves are left out; PR merges show those. Comments are clipped; show.mjs has them whole.", "");
    for (const i of issues) {
      const mine = i.assignee?.name === meLinear ? " (Tom)" : "";
      const ev = [...new Set(i.activity.events.map((e) => `${String(e.who ?? "someone").replace(/@lleverage\.ai$/, "")} ${e.what}`))];
      const prLinks = i.attachments.filter((a) => /github\.com\/.+\/pull\//.test(a.url)).map((a) => a.url.replace("https://github.com/", "").replace("/pull/", "#"));
      L.push(`- ${i.identifier} [${i.state.name}${i.priority ? `, ${i.priorityLabel}` : ""}] ${i.assignee?.name?.replace(/@lleverage\.ai$/, "") ?? "unassigned"}${mine} "${oneLine(i.title, 110)}"${i.project ? ` {${i.project.name}}` : ""}${prLinks.length ? ` PRs ${prLinks.join(" ")}` : ""}`);
      if (ev.length && !mine) L.push(`  ${oneLine(ev.join("; "), 260)}`);
      if (!mine) for (const c of i.activity.comments.slice(-3)) L.push(`  › ${c.user.name.replace(/@lleverage\.ai$/, "")}: ${oneLine(c.body, 200)}`);
    }
    L.push("");
    if (linear.linked?.length) {
      L.push(`## Issues linked from others' PRs, not otherwise active (for scope checks)`, "");
      for (const i of linear.linked) L.push(`- ${i.identifier} [${i.state.name}] ${i.assignee?.name ?? "unassigned"} "${oneLine(i.title, 110)}"`);
      L.push("");
    }
  }
  return L.join("\n");
}
