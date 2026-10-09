#!/usr/bin/env node
// Stills at song times, and a contact sheet to look at them together.
//   node stills.mjs <dir> 0 15.5 47 ...       → <dir>/check/still-<t>.png and <dir>/check/sheet.png
//   node stills.mjs <dir> --scenes            one still per scene, near its end (when its result shows)
//   node stills.mjs <dir> --bars 7 11 15      at the start of those bars (+0.6s, after the cut)
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ffmpeg } from "./lib/deps.mjs";
import { openVideo } from "./lib/page.mjs";

const [dirArg, ...rest] = process.argv.slice(2);
const dir = path.resolve(dirArg || ".");
const { browser, page, w, h, errors } = await openVideo(dir);
let times;
if (rest[0] === "--scenes") times = (await page.evaluate(() => window.SCENES)).map((s) => +(Math.max(s.from + 0.6, s.to - 0.25)).toFixed(2));
else if (rest[0] === "--bars") times = await page.evaluate((bars) => bars.map((i) => +(MV.bar(i) + 0.6).toFixed(2)), rest.slice(1).map(Number));
else times = rest.map(Number);
const outDir = path.join(dir, "check");
mkdirSync(outDir, { recursive: true });
const files = [];
for (const t of times) {
  await page.evaluate((t) => window.seek(t), t);
  const f = path.join(outDir, `still-${t}.png`);
  await page.screenshot({ path: f });
  files.push(f);
}
await browser.close();
if (errors.length) console.log("PAGE ERRORS:\n  " + errors.join("\n  "));
console.log(times.map((t, i) => `${t}s → ${path.relative(process.cwd(), files[i])}`).join("\n"));
if (files.length > 1) {
  // 3 per row at a third of the size: small enough to read in one image, large enough to judge UI text.
  const cols = Math.min(3, files.length), rows = Math.ceil(files.length / cols), tw = Math.round(w / 3 / 2) * 2, th = Math.round(h / 3 / 2) * 2;
  const n = cols * rows, pad = n - files.length;
  const inputs = [...files.flatMap((f) => ["-i", f]), ...Array.from({ length: pad }, () => ["-f", "lavfi", "-i", `color=c=black:s=${w}x${h}`]).flat()];
  const scale = Array.from({ length: n }, (_, i) => `[${i}:v]scale=${tw}:${th}[v${i}]`).join(";");
  const layout = Array.from({ length: n }, (_, i) => `${(i % cols) * tw}_${Math.floor(i / cols) * th}`).join("|");
  const sheet = path.join(outDir, "sheet.png");
  const r = spawnSync(ffmpeg(), ["-y", "-loglevel", "error", ...inputs, "-filter_complex", `${scale};${Array.from({ length: n }, (_, i) => `[v${i}]`).join("")}xstack=inputs=${n}:layout=${layout}`, "-frames:v", "1", sheet]);
  console.log(r.status ? r.stderr.toString() : `sheet → ${path.relative(process.cwd(), sheet)} (left to right, top to bottom)`);
}
