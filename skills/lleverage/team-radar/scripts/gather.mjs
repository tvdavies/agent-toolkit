#!/usr/bin/env node
// Usage: gather.mjs [--since ISO] [--until ISO] [--state FILE] [--out DIR] [--org lleverage-ai]
//                   [--repos a,b] [--exclude-repos REGEX] [--teams LLE] [--open-days 21]
//                   [--me tvdavies] [--me-linear "Tom Davies"] [--skip github,branches,linear]
//                   [--print-window] [--now ISO] [--render DIR]
//
// Collects one review window of Lleverage team activity, read-only, into DIR:
//   data.json   everything gathered, untruncated
//   digest.md   the same, compact, for the analysis to read
// GitHub: the org's repos pushed in the window, their PRs updated in the window (draft,
// open, merged, closed) with bodies, files and linked Linear IDs, other open PRs (for
// overlaps), and branches with new commits that have never had a PR, compared with the
// default branch. Linear (--teams, default LLE): issues with human activity in the
// window (created, retitled, re-described, reassigned, re-prioritised, re-projected,
// commented, cancelled or blocked; plain status moves are left out because the PRs
// show them) plus the issues PRs link to, from any team.
// Meetings (Drive) and Slack are read by the agent through Sal's host tools, not here.
//
// The window defaults to the last recorded run in --state (findings.mjs --record writes
// it), else the previous working day (Monday reaches back to Friday). --print-window
// prints the window as JSON and exits. --render DIR rewrites DIR/digest.md from an
// existing DIR/data.json without fetching anything. Nothing here writes anywhere but DIR.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { computeWindow, fileAreas, linearIds } from "./lib.mjs";
import { renderDigest } from "./digest.mjs";

const run = promisify(execFile);
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(name);
if (flag("--help") || flag("-h")) {
  const src = fs.readFileSync(new URL(import.meta.url), "utf8");
  console.log(src.split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}

if (opt("--render")) {
  const dir = opt("--render");
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "digest.md"), renderDigest(saved, { meLinear: opt("--me-linear", "Tom Davies"), openDays: Number(opt("--open-days", "21")) }));
  console.log(JSON.stringify({ out: dir, window: saved.window, gaps: saved.gaps }));
  process.exit(saved.gaps?.length ? 4 : 0);
}

const statePath = opt("--state", path.join(os.homedir(), ".local/state/team-radar/state.json"));
let state = {};
try {
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
} catch {}
const window = computeWindow({ now: opt("--now", opt("--until", new Date().toISOString())), since: opt("--since"), lastRun: state.lastRun });
if (flag("--print-window")) {
  console.log(JSON.stringify(window));
  process.exit(0);
}

const ORG = opt("--org", "lleverage-ai");
const ME_GH = opt("--me", "tvdavies").toLowerCase();
const ME_LINEAR = opt("--me-linear", "Tom Davies");
const EXCLUDE = new RegExp(opt("--exclude-repos", "-brain$|^\\.github$"));
const OPEN_DAYS = Number(opt("--open-days", "21"));
const skip = new Set(opt("--skip", "").split(",").filter(Boolean));
const outDir = opt("--out", `team-radar-${window.until.slice(0, 10)}`);
fs.mkdirSync(outDir, { recursive: true });
const gaps = [];
const inWindow = (iso) => !!iso && iso >= window.since && iso <= window.until;

async function cmd(bin, args, { tries = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const { stdout } = await run(bin, args, { maxBuffer: 256 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      if (attempt >= tries) throw new Error(`${bin} ${args.slice(0, 3).join(" ")}: ${String(error.stderr || error.message).trim().slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }
}
const ghJson = async (args) => JSON.parse(await cmd("gh", args));
const ghLines = async (args) => (await cmd("gh", args)).split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// ---------- Linear ----------
async function gql(query, variables = {}) {
  const args = ["api", "query", query, "-o", "json", "--compact", "-q"];
  for (const [k, v] of Object.entries(variables)) if (v !== undefined && v !== null) args.push("-v", `${k}=${v}`);
  const body = JSON.parse(await cmd("linear-cli", args));
  if (body.error || body.errors) throw new Error(`Linear query failed: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  return body.data;
}

const ISSUE_FIELDS = `identifier title url priority priorityLabel createdAt updatedAt
  team{key} state{name type} assignee{name} creator{name} project{name} cycle{number} description
  labels{nodes{name}}
  history(first:40){nodes{createdAt actor{name} botActor{name} fromState{name} toState{name} fromTitle toTitle
    updatedDescription fromAssignee{name} toAssignee{name} fromPriority toPriority fromProject{name} toProject{name}}}
  comments(first:25, filter:{createdAt:{gte:$from}}){nodes{createdAt body url user{name} botActor{name}}}
  attachments(first:15){nodes{url title sourceType}}
  relations(first:15){nodes{type relatedIssue{identifier}}}`;

function issueActivity(issue) {
  const human = (h) => !h.botActor && h.actor?.name;
  const events = [];
  if (inWindow(issue.createdAt)) events.push({ at: issue.createdAt, who: issue.creator?.name, what: "created" });
  for (const h of issue.history?.nodes ?? []) {
    if (!inWindow(h.createdAt) || !human(h)) continue;
    const who = h.actor.name;
    if (h.toState) events.push({ at: h.createdAt, who, what: `moved ${h.fromState?.name ?? "?"} → ${h.toState.name}` });
    if (h.toTitle && h.fromTitle) events.push({ at: h.createdAt, who, what: `retitled from "${h.fromTitle}"` });
    if (h.updatedDescription) events.push({ at: h.createdAt, who, what: "edited description" });
    if (h.toAssignee || h.fromAssignee) events.push({ at: h.createdAt, who, what: `assignee ${h.fromAssignee?.name ?? "none"} → ${h.toAssignee?.name ?? "none"}` });
    if (h.toPriority != null && h.fromPriority != null && h.toPriority !== h.fromPriority) events.push({ at: h.createdAt, who, what: `priority ${h.fromPriority} → ${h.toPriority}` });
    if (h.toProject || h.fromProject) events.push({ at: h.createdAt, who, what: `project ${h.fromProject?.name ?? "none"} → ${h.toProject?.name ?? "none"}` });
  }
  const comments = (issue.comments?.nodes ?? []).filter(
    (c) => inWindow(c.createdAt) && !c.botActor && c.user?.name && !/^This comment thread is synced to a corresponding thread in Slack/.test(c.body ?? ""),
  );
  // Status and project moves alone are noise (PR merges and bulk re-filing), except a
  // cancel, duplicate or block.
  const telling = (e) => (!e.what.startsWith("moved ") && !e.what.startsWith("project ")) || /→ .*(cancel|duplicate|block|won't|wont)/i.test(e.what);
  if (!events.some(telling) && comments.length === 0) return { events: [], comments: [] };
  // Collapse repeated "edited description" by the same person.
  const seen = new Set();
  const deduped = events.filter((e) => {
    const k = `${e.who}|${e.what}`;
    if (e.what === "edited description" && seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { events: deduped.sort((a, b) => a.at.localeCompare(b.at)), comments };
}

function slimIssue(issue) {
  const { history, comments: _c, ...rest } = issue;
  return {
    ...rest,
    labels: (issue.labels?.nodes ?? []).map((l) => l.name),
    attachments: (issue.attachments?.nodes ?? []).map((a) => ({ url: a.url, title: a.title, source: a.sourceType })),
    relations: (issue.relations?.nodes ?? []).map((r) => ({ type: r.type, issue: r.relatedIssue?.identifier })),
  };
}

async function gatherLinear(teamKeysWanted) {
  const teams = (await gql(`query{teams{nodes{key name}}}`)).teams.nodes;
  const keys = teams.map((t) => t.key);
  const filterTeams = teamKeysWanted === "all" ? null : String(teamKeysWanted || "LLE").split(",").map((s) => s.trim().toUpperCase()).filter((k) => /^[A-Z]{2,6}$/.test(k));
  const teamFilter = filterTeams ? `, team:{key:{in:[${filterTeams.map((k) => `"${k}"`).join(",")}]}}` : "";
  const issues = [];
  let after;
  do {
    const d = await gql(
      `query($from:DateTimeOrDuration!,$to:DateTimeOrDuration!,$after:String){ issues(first:50, after:$after,
         filter:{updatedAt:{gte:$from, lte:$to}${teamFilter}}){ pageInfo{hasNextPage endCursor} nodes{ ${ISSUE_FIELDS} } } }`,
      { from: window.since, to: window.until, after },
    );
    issues.push(...d.issues.nodes);
    after = d.issues.pageInfo.hasNextPage ? d.issues.pageInfo.endCursor : undefined;
  } while (after);
  const active = [];
  for (const issue of issues) {
    if (filterTeams && !filterTeams.includes(issue.team.key)) continue;
    const activity = issueActivity(issue);
    if (activity.events.length === 0 && activity.comments.length === 0) continue;
    active.push({ ...slimIssue(issue), activity });
  }
  return { teams, keys, teamsScanned: filterTeams ?? ["all teams"], issues: active };
}

// Linked issues need no history or comments: they are there for scope checks.
const LINKED_FIELDS = `identifier title url priority priorityLabel createdAt updatedAt team{key} state{name type}
  assignee{name} creator{name} project{name} cycle{number} description labels{nodes{name}}
  attachments(first:15){nodes{url title sourceType}} relations(first:15){nodes{type relatedIssue{identifier}}}`;

async function fetchIssues(ids) {
  const one = async (id) => {
    try {
      const d = await gql(`query{ i0: issue(id:"${id}"){ ${LINKED_FIELDS} } }`);
      return d.i0 ? [slimIssue(d.i0)] : [];
    } catch {
      return [];
    }
  };
  const chunks = [];
  for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
  const results = await pool(chunks, 3, async (chunk) => {
    try {
      const d = await gql(`query{ ${chunk.map((id, n) => `i${n}: issue(id:"${id}"){ ${LINKED_FIELDS} }`).join("\n")} }`);
      return Object.values(d).filter(Boolean).map(slimIssue);
    } catch {
      // One unknown ID fails the whole batch; fall back to one at a time.
      return (await pool(chunk, 4, one)).flat();
    }
  });
  return results.flat();
}

// ---------- GitHub ----------
const PR_FIELDS = "number,title,url,author,state,isDraft,createdAt,updatedAt,mergedAt,closedAt,headRefName,baseRefName,body,additions,deletions,changedFiles,files,labels,reviewDecision";
const BRANCH_NOISE = /^(gh-readonly-queue\/|dependabot\/|renovate\/|release-please|changeset-release\/)|-screenshots$/;

function slimPr(repo, pr, teamKeys) {
  const files = (pr.files ?? []).map((f) => f.path);
  return {
    repo,
    ref: `${repo}#${pr.number}`,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    author: pr.author?.login ?? "unknown",
    authorName: pr.author?.name || pr.author?.login,
    bot: !!pr.author?.is_bot || /\[bot\]$|^app\//.test(pr.author?.login ?? ""),
    self: (pr.author?.login ?? "").toLowerCase() === ME_GH,
    state: pr.isDraft && pr.state === "OPEN" ? "DRAFT" : pr.state,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    head: pr.headRefName,
    base: pr.baseRefName,
    body: pr.body ?? "",
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    files,
    areas: fileAreas(files),
    labels: (pr.labels ?? []).map((l) => l.name),
    reviewDecision: pr.reviewDecision,
    linear: linearIds(`${pr.title}\n${pr.headRefName}\n${pr.body ?? ""}`, teamKeys),
  };
}

async function branchesWithoutPr(repo, defaultBranch) {
  const [owner, name] = repo.split("/");
  const nodes = [];
  let after = null;
  do {
    const q = `query($owner:String!,$name:String!,$after:String){ repository(owner:$owner,name:$name){ refs(refPrefix:"refs/heads/", first:100, after:$after){
      pageInfo{hasNextPage endCursor} nodes{ name target{ ... on Commit { committedDate messageHeadline author{ name user{login} } } }
      associatedPullRequests(first:1){ totalCount } } } } }`;
    const args = ["api", "graphql", "-f", `query=${q}`, "-f", `owner=${owner}`, "-f", `name=${name}`];
    if (after) args.push("-f", `after=${after}`);
    const d = await ghJson(args);
    const refs = d.data.repository.refs;
    nodes.push(...refs.nodes);
    after = refs.pageInfo.hasNextPage ? refs.pageInfo.endCursor : null;
  } while (after);
  const fresh = nodes.filter((n) => n.name !== defaultBranch && !BRANCH_NOISE.test(n.name) && inWindow(n.target?.committedDate) && n.associatedPullRequests.totalCount === 0);
  return pool(fresh, 4, async (n) => {
    const author = n.target.author?.user?.login ?? n.target.author?.name ?? "unknown";
    const branch = { repo, ref: `${repo}:${n.name}`, name: n.name, url: `https://github.com/${repo}/tree/${encodeURI(n.name)}`, author, self: author.toLowerCase() === ME_GH, committedAt: n.target.committedDate, headline: n.target.messageHeadline };
    try {
      const c = await ghJson(["api", `repos/${repo}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(n.name)}`, "--jq",
        "{ahead: .ahead_by, behind: .behind_by, files: [.files[]?.filename], commits: [.commits[-5:][]?.commit.message | split(\"\\n\")[0]]}"]);
      return { ...branch, ...c, areas: fileAreas(c.files) };
    } catch (error) {
      return { ...branch, compareError: String(error.message).slice(0, 200) };
    }
  });
}

async function gatherGithub(teamKeys) {
  const all = await ghLines(["api", `orgs/${ORG}/repos?per_page=100&sort=pushed`, "--paginate", "--jq", ".[] | {name: .full_name, archived, pushed_at, default_branch}"]);
  const wanted = opt("--repos") ? new Set(opt("--repos").split(",").map((r) => (r.includes("/") ? r : `${ORG}/${r}`))) : null;
  const repos = all.filter((r) => (wanted ? wanted.has(r.name) : !r.archived && r.pushed_at >= window.since && !EXCLUDE.test(r.name.split("/")[1])));
  const openSince = new Date(new Date(window.until).getTime() - OPEN_DAYS * 864e5).toISOString();
  const perRepo = await pool(repos, 3, async (r) => {
    const result = { repo: r.name, defaultBranch: r.default_branch, prs: [], openPrs: [], branches: [] };
    try {
      const updated = await ghJson(["pr", "list", "-R", r.name, "--state", "all", "--search", `updated:>=${window.since.replace(/\.\d+Z$/, "Z")}`, "--limit", "400", "--json", PR_FIELDS]);
      result.prs = updated.map((p) => slimPr(r.name, p, teamKeys)).filter((p) => !p.bot && p.updatedAt <= window.until);
      const open = await ghJson(["pr", "list", "-R", r.name, "--state", "open", "--limit", "400", "--json", "number,title,url,author,isDraft,state,createdAt,updatedAt,headRefName,baseRefName,additions,deletions,changedFiles,files"]);
      const inSet = new Set(result.prs.map((p) => p.number));
      result.openPrs = open
        .filter((p) => !inSet.has(p.number) && p.updatedAt >= openSince)
        .map((p) => slimPr(r.name, { ...p, body: "" }, teamKeys))
        .filter((p) => !p.bot);
    } catch (error) {
      gaps.push(`GitHub PRs for ${r.name}: ${error.message}`);
    }
    if (!skip.has("branches")) {
      try {
        result.branches = (await branchesWithoutPr(r.name, r.default_branch)).filter((b) => !/\[bot\]$/.test(b.author));
      } catch (error) {
        gaps.push(`GitHub branches for ${r.name}: ${error.message}`);
      }
    }
    return result;
  });
  return { repos: perRepo, scanned: repos.map((r) => r.name) };
}

// ---------- Main ----------
const data = { generatedAt: new Date().toISOString(), window, org: ORG, gaps, github: null, linear: null };
let teamKeys = ["LLE", "FDE", "CC", "DES", "LLEV", "LEG", "EDU", "CRB", "AGE", "ERYS"];
if (!skip.has("linear")) {
  try {
    data.linear = await gatherLinear(opt("--teams"));
    teamKeys = data.linear.keys;
  } catch (error) {
    gaps.push(`Linear: ${error.message}`);
  }
}
if (!skip.has("github")) {
  try {
    data.github = await gatherGithub(teamKeys);
  } catch (error) {
    gaps.push(`GitHub: ${error.message}`);
  }
}
if (data.linear && data.github) {
  const active = new Set(data.linear.issues.map((i) => i.identifier));
  const linked = [...new Set(data.github.repos.flatMap((r) => r.prs.filter((p) => !p.self && p.state !== "CLOSED").flatMap((p) => p.linear)))].filter((id) => !active.has(id));
  try {
    data.linear.linked = await fetchIssues(linked);
  } catch (error) {
    data.linear.linked = [];
    gaps.push(`Linear linked issues: ${error.message}`);
  }
} else if (data.linear) data.linear.linked = [];

fs.writeFileSync(path.join(outDir, "data.json"), JSON.stringify(data, null, 1));
fs.writeFileSync(path.join(outDir, "digest.md"), renderDigest(data, { meLinear: ME_LINEAR, openDays: OPEN_DAYS }));
const prCount = data.github?.repos.reduce((n, r) => n + r.prs.length, 0) ?? 0;
const branchCount = data.github?.repos.reduce((n, r) => n + r.branches.length, 0) ?? 0;
console.log(JSON.stringify({
  out: outDir,
  window,
  repos: data.github?.scanned.length ?? 0,
  prs: prCount,
  branches: branchCount,
  linearIssues: data.linear?.issues.length ?? 0,
  gaps,
}));
process.exit(gaps.length ? 4 : 0);
