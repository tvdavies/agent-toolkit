#!/usr/bin/env node
// Start a Lleverage video folder: beat-video's engine and kinds, the Lleverage template and UI library, the brand
// kit and the icons it needs.
//   node new.mjs <dir> [--format 1920x1080] [--force]
// Then: music → beats → facts/flags → plan in content.js and chapters.js → icons.mjs again → check → stills → render.
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = path.resolve(here, "..");
const beatVideo = path.resolve(skill, "../../general/beat-video/scripts");
const args = process.argv.slice(2);
const dir = args[0] && !args[0].startsWith("--") ? path.resolve(args[0]) : null;
if (!dir) { console.error("usage: new.mjs <dir> [--format WxH] [--force]"); process.exit(1); }
const step = (script, ...a) => { const r = spawnSync("node", [script, ...a], { stdio: "inherit" }); if (r.status) process.exit(r.status); };

step(path.join(beatVideo, "new.mjs"), dir, "--template", path.join(skill, "template"), ...args.slice(1));
for (const f of readdirSync(path.join(skill, "ui"))) cpSync(path.join(skill, "ui", f), path.join(dir, f));
// Generated from private or licensed sources: never commit these.
appendFileSync(path.join(dir, ".gitignore"), "brand/\nbrand.css\nbrand.js\nicons.js\nintegrations/\nfacts.json\n");
step(path.join(here, "brand.mjs"), dir);
step(path.join(here, "icons.mjs"), dir);
console.log(`
ready: ${dir}
  music   node ${path.join(beatVideo, "music.mjs")} fetch "Voxel Revolution" ${dir}
  beats   node ${path.join(beatVideo, "beats.mjs")} ${dir}
  facts   node ${path.join(here, "facts.mjs")} ${dir} --author "<name>" --since <date>
  flags   node ${path.join(here, "flags.mjs")} <term> ...
  icons   node ${path.join(here, "icons.mjs")} ${dir}       (after editing chapters)
  check   node ${path.join(beatVideo, "check.mjs")} ${dir}
  stills  node ${path.join(beatVideo, "stills.mjs")} ${dir} --scenes
  render  node ${path.join(beatVideo, "render.mjs")} ${dir}`);
