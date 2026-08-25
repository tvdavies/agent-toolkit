#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
export AGENT_TOOLS_DIR="${AGENT_TOOLS_DIR:-$DEFAULT_REPO_DIR}"

exec node --input-type=module - "$@" <<'NODE'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
let groupsArg = "general,personal,lleverage";
let dryRun = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "--groups") groupsArg = args[++i] ?? "";
  else if (arg?.startsWith("--groups=")) groupsArg = arg.slice("--groups=".length);
  else if (arg === "-h" || arg === "--help") {
    console.log("Usage: install-skills.sh [--groups general,personal,lleverage] [--dry-run]");
    process.exit(0);
  } else {
    console.error(`Unknown option: ${arg}`);
    process.exit(2);
  }
}

const validGroups = new Set(["general", "personal", "lleverage"]);
const groups = [...new Set(groupsArg.split(",").map((value) => value.trim()).filter(Boolean))];
if (groups.length === 0 || groups.some((group) => !validGroups.has(group))) {
  console.error(`Invalid groups: ${groupsArg}. Choose from general,personal,lleverage.`);
  process.exit(2);
}

const repo = fs.realpathSync(process.env.AGENT_TOOLS_DIR);
const skillsRoot = path.join(repo, "skills");
const home = os.homedir();
const agentsDir = path.join(home, ".agents", "skills");
const claudePath = path.join(home, ".claude", "skills");
const statePath = path.join(home, ".local", "state", "agent-toolkit", "skill-links.json");
const desired = [];
const names = new Map();
const selectedGroups = new Set(groups);

// Validate the complete source inventory before changing anything, even when only
// a subset is selected, so a latent cross-group duplicate cannot be installed later.
for (const group of ["general", "personal", "lleverage"]) {
  const groupDir = path.join(skillsRoot, group);
  if (!fs.existsSync(groupDir)) throw new Error(`Missing skill group: ${groupDir}`);
  for (const entry of fs.readdirSync(groupDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const previous = names.get(entry.name);
    if (previous) throw new Error(`Duplicate skill name '${entry.name}' in groups '${previous}' and '${group}'.`);
    names.set(entry.name, group);
    if (selectedGroups.has(group)) desired.push({ name: entry.name, target: path.join(groupDir, entry.name) });
  }
}

const logAction = (message) => console.log(dryRun ? `[dry-run] ${message}` : message);
const mutate = (message, action) => {
  logAction(message);
  if (!dryRun) action();
};
const lexists = (value) => {
  try { fs.lstatSync(value); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
};
const readLinkAbsolute = (link) => path.resolve(path.dirname(link), fs.readlinkSync(link));
const isInsideToolkit = (target) => {
  const relative = path.relative(repo, path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const ensureDirectory = (directory) => {
  if (!lexists(directory)) mutate(`create directory ${directory}`, () => fs.mkdirSync(directory, { recursive: true }));
  else if (!fs.statSync(directory).isDirectory()) throw new Error(`${directory} is not a directory.`);
};

const agentsKind = !lexists(agentsDir)
  ? "absent"
  : fs.lstatSync(agentsDir).isSymbolicLink()
    ? (readLinkAbsolute(agentsDir) === skillsRoot ? "legacy" : "external-link")
    : fs.lstatSync(agentsDir).isDirectory() ? "directory" : "other";
if (agentsKind === "external-link") throw new Error(`${agentsDir} is a symlink owned elsewhere (${readLinkAbsolute(agentsDir)}); refusing to replace it.`);
if (agentsKind === "other") throw new Error(`${agentsDir} exists and is not a directory or managed symlink; refusing to overwrite it.`);

let claudeDir;
const claudeKind = !lexists(claudePath)
  ? "absent"
  : fs.lstatSync(claudePath).isSymbolicLink()
    ? (readLinkAbsolute(claudePath) === skillsRoot ? "legacy" : readLinkAbsolute(claudePath) === agentsDir ? "managed" : "external-link")
    : fs.lstatSync(claudePath).isDirectory() ? "directory" : "other";
if (claudeKind === "external-link") throw new Error(`${claudePath} is a symlink owned elsewhere (${readLinkAbsolute(claudePath)}); refusing to replace it.`);
if (claudeKind === "other") throw new Error(`${claudePath} exists and is not a directory or managed symlink; refusing to overwrite it.`);
if (claudeKind === "directory") claudeDir = claudePath;

let previousLinks = [];
if (fs.existsSync(statePath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (Array.isArray(parsed.links)) previousLinks = parsed.links.filter((link) => typeof link?.path === "string" && typeof link?.target === "string");
  } catch (error) {
    throw new Error(`Cannot read managed skill state ${statePath}: ${error.message}`);
  }
}

const destinations = [agentsDir, ...(claudeDir ? [claudeDir] : [])];
const nextLinks = desired.flatMap(({ name, target }) => destinations.map((directory) => ({ path: path.join(directory, name), target })));
const desiredPaths = new Set(nextLinks.map((link) => link.path));

// Refuse every unmanaged conflict before making any filesystem change.
for (const link of nextLinks) {
  if (!lexists(link.path)) continue;
  const stat = fs.lstatSync(link.path);
  if (!stat.isSymbolicLink()) throw new Error(`${link.path} exists and is not a symlink; refusing to overwrite unmanaged content.`);
  const currentTarget = readLinkAbsolute(link.path);
  if (currentTarget !== link.target && !isInsideToolkit(currentTarget)) {
    throw new Error(`${link.path} points outside this toolkit (${currentTarget}); refusing to overwrite it.`);
  }
}

if (agentsKind === "legacy") mutate(`remove legacy whole-directory link ${agentsDir} -> ${skillsRoot}`, () => fs.unlinkSync(agentsDir));
ensureDirectory(agentsDir);
if (claudeKind === "absent") {
  ensureDirectory(path.dirname(claudePath));
  mutate(`link ${claudePath} -> ${agentsDir}`, () => fs.symlinkSync(agentsDir, claudePath));
} else if (claudeKind === "legacy") {
  mutate(`replace legacy whole-directory link ${claudePath} -> ${skillsRoot}`, () => fs.unlinkSync(claudePath));
  mutate(`link ${claudePath} -> ${agentsDir}`, () => fs.symlinkSync(agentsDir, claudePath));
}

for (const old of previousLinks) {
  if (desiredPaths.has(old.path) || !lexists(old.path) || !fs.lstatSync(old.path).isSymbolicLink()) continue;
  const currentTarget = readLinkAbsolute(old.path);
  if (isInsideToolkit(currentTarget)) mutate(`remove stale managed link ${old.path} -> ${currentTarget}`, () => fs.unlinkSync(old.path));
  else console.warn(`warning: stale managed path now points outside this toolkit; preserving ${old.path}`);
}

for (const link of nextLinks) {
  if (lexists(link.path)) {
    const currentTarget = readLinkAbsolute(link.path);
    if (currentTarget === link.target) continue;
    mutate(`replace toolkit link ${link.path} -> ${currentTarget}`, () => fs.unlinkSync(link.path));
  }
  mutate(`link ${link.path} -> ${link.target}`, () => fs.symlinkSync(link.target, link.path));
}

const state = `${JSON.stringify({ version: 1, repo, groups, links: nextLinks }, null, 2)}\n`;
if (dryRun) logAction(`write managed state ${statePath}`);
else {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, state, "utf8");
  fs.renameSync(temporary, statePath);
}

const settingsPath = path.join(home, ".pi", "agent", "settings.json");
if (fs.existsSync(settingsPath)) {
  const settings = fs.readFileSync(settingsPath, "utf8");
  if (settings.includes("~/.claude/skills") || settings.includes(`${home}/.claude/skills`)) {
    console.warn(`warning: ${settingsPath} explicitly lists ~/.claude/skills; Pi already discovers ~/.agents/skills. Remove that entry manually to avoid duplicate discovery.`);
  }
}

console.log(`${dryRun ? "Would install" : "Installed"} ${desired.length} skills from groups: ${groups.join(", ")}.`);
NODE
