#!/usr/bin/env node
// Start a video folder: the engine plus a template, at a format.
//   node new.mjs <dir> [--format 1920x1080] [--template <template dir>] [--force]
// The default template is a neutral, unbranded music video (cover, words, list, stat, end card). A brand layer
// (for example lleverage-feature-video) passes its own template, which may carry extra files and folders.
// Engine files are always copied fresh; template files are not overwritten unless --force.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dir = args[0] && !args[0].startsWith("--") ? path.resolve(args[0]) : null;
if (!dir) { console.error("usage: new.mjs <dir> [--format WxH] [--template DIR] [--force]"); process.exit(1); }
const template = path.resolve(opt("--template", path.join(here, "..", "template")));
const size = opt("--format", "1920x1080");
if (!/^\d+x\d+$/.test(size) || size.split("x").some((n) => n % 2)) { console.error(`--format ${size}: expected even WxH, e.g. 1920x1080 or 1080x1350`); process.exit(1); }
if (existsSync(path.join(dir, "index.html")) && !args.includes("--force")) { console.error(`${dir} already has a video; pass --force to replace its template files`); process.exit(1); }

mkdirSync(dir, { recursive: true });
cpSync(template, dir, { recursive: true });
for (const f of ["mv.js", "mv.css", "kinds.js", "kinds.css"]) cpSync(path.join(here, "..", "engine", f), path.join(dir, f));
const index = path.join(dir, "index.html");
writeFileSync(index, readFileSync(index, "utf8").replace(/window\.FORMAT = "[^"]*"/, `window.FORMAT = "${size}"`));
writeFileSync(path.join(dir, "format.json"), JSON.stringify({ size }, null, 1) + "\n");
writeFileSync(path.join(dir, ".gitignore"), "music.mp3\nout/\ncheck/\n*.parts/\n");
console.log(`video folder ${dir} at ${size} from ${template}
next: music.mjs fetch "<title>" ${dir}  →  beats.mjs ${dir}  →  edit content.js / scenes.js  →  check.mjs  →  stills.mjs  →  render.mjs`);
