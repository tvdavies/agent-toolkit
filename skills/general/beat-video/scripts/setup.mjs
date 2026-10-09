#!/usr/bin/env node
// Install or check beat-video's runtime: playwright-core, ffmpeg-static and ffprobe-static in the cache,
// plus a Chrome or Chromium from the machine. Safe to run every time; it only installs what is missing.
//   node setup.mjs           install if needed, then report
//   node setup.mjs --check   report only
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOME, PACKAGES, chrome, ffmpeg, ffprobe } from "./lib/deps.mjs";

const check = process.argv.includes("--check");
const missing = PACKAGES.filter((p) => !existsSync(path.join(HOME, "node_modules", p.replace(/@[^@/]+$/, ""), "package.json")));
if (missing.length && !check) {
  mkdirSync(HOME, { recursive: true });
  if (!existsSync(path.join(HOME, "package.json"))) writeFileSync(path.join(HOME, "package.json"), JSON.stringify({ name: "beat-video-runtime", private: true }) + "\n");
  console.log(`installing ${missing.join(" ")} into ${HOME}`);
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--prefix", HOME, ...missing], { stdio: "inherit", env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } });
  if (r.status) process.exit(r.status);
}
const rows = [["runtime", HOME], ["chrome", chrome() || "MISSING: install Chromium or Chrome, or set CHROME"], ["ffmpeg", ffmpeg() || "MISSING"], ["ffprobe", ffprobe() || "MISSING"]];
for (const [k, v] of rows) console.log(`${k.padEnd(8)} ${v}`);
process.exit(rows.some(([, v]) => String(v).startsWith("MISSING")) ? 1 : 0);
