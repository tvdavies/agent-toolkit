#!/usr/bin/env node
// Render a built report in headless Chrome/Chromium and save review screenshots.
//
//   node render-check.mjs report.html [--out-dir DIR] [--widths 1280,420] [--pdf]
//
// Writes DIR/<name>-<width>-<n>.png tiles (1600px tall) and prints layout checks:
// horizontal overflow, fonts that failed to load, and SVG/text overflowing figures.
// Requires Node 22+ (global WebSocket) and a Chrome/Chromium binary ($CHROME or on PATH).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchChrome, ChromeUnavailable } from "./lib/chrome.mjs";

const args = process.argv.slice(2);
const opts = { widths: [1280, 420], pdf: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out-dir") opts.outDir = args[++i];
  else if (a === "--widths") opts.widths = args[++i].split(",").map(Number);
  else if (a === "--pdf") opts.pdf = true;
  else if (a === "-h" || a === "--help") opts.help = true;
  else if (!opts.file) opts.file = a;
}
if (opts.help || !opts.file) {
  console.log("Usage: render-check.mjs report.html [--out-dir DIR] [--widths 1280,420] [--pdf]");
  process.exit(opts.help ? 0 : 2);
}

const file = path.resolve(opts.file);
const base = path.basename(file).replace(/\.html?$/, "");
const outDir = path.resolve(opts.outDir ?? path.join(path.dirname(file), "render"));
fs.mkdirSync(outDir, { recursive: true });

let browser;
try {
  browser = await launchChrome();
} catch (error) {
  console.error(error instanceof ChromeUnavailable ? `${error.message} Review the HTML in a browser manually instead.` : error.message);
  process.exit(3);
}

const problems = [];
const shots = [];
try {
  const page = await browser.newPage();

  for (const width of opts.widths) {
    await page.setViewport(width, 1000, { mobile: width < 600 });
    await page.goto(pathToFileURL(file).href);
    const info = await page.evaluate(`(() => {
        const out = { height: document.documentElement.scrollHeight, overflowX: document.documentElement.scrollWidth - window.innerWidth, fonts: [], wide: [] };
        for (const f of document.fonts) if (f.status === 'error') out.fonts.push(f.family + ' ' + f.weight + ' ' + f.style);
        const vw = window.innerWidth;
        document.querySelectorAll('.main *').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width && r.right > vw + 1 && !el.closest('.table-wrap') && !el.closest('pre') && !el.closest('figure')) out.wide.push((el.tagName + '.' + (el.className?.baseVal ?? el.className)).slice(0, 60));
        });
        out.wide = [...new Set(out.wide)].slice(0, 8);
        // Chart text drawn outside its SVG's viewBox (clipped or spilling past the figure).
        out.clipped = [];
        document.querySelectorAll('svg.chart').forEach((svg, i) => {
          const vb = svg.viewBox.baseVal;
          const cap = svg.closest('figure')?.querySelector('figcaption')?.firstChild?.textContent?.trim() || 'chart ' + (i + 1);
          svg.querySelectorAll('text').forEach((t) => {
            const b = t.getBBox();
            if (b.x < vb.x - 1 || b.x + b.width > vb.x + vb.width + 1) out.clipped.push(cap.slice(0, 50) + ': "' + t.textContent.slice(0, 30) + '"');
          });
        });
        out.clipped = [...new Set(out.clipped)].slice(0, 8);
        return out;
      })()`);
    if (info.overflowX > 0) problems.push(`${width}px: page scrolls horizontally by ${info.overflowX}px (${info.wide.join(", ") || "unknown element"}).`);
    if (info.clipped.length) problems.push(`${width}px: chart text outside its SVG: ${info.clipped.join("; ")}.`);
    if (info.fonts.length) problems.push(`${width}px: fonts failed to load: ${info.fonts.join(", ")}.`);
    const tile = 1600;
    const tiles = Math.ceil(info.height / tile);
    for (let i = 0; i < tiles; i++) {
      const h = Math.min(tile, info.height - i * tile);
      const out = path.join(outDir, `${base}-${width}-${String(i + 1).padStart(2, "0")}.png`);
      fs.writeFileSync(out, await page.screenshot({ x: 0, y: i * tile, width, height: h }));
      shots.push(out);
    }
    console.log(`${width}px: page height ${info.height}px, ${tiles} tile(s).`);
  }

  if (opts.pdf) {
    await page.clearViewport();
    const out = path.join(outDir, `${base}.pdf`);
    fs.writeFileSync(out, await page.pdf());
    shots.push(out);
  }
} finally {
  browser.close();
}

console.log(shots.map((p) => `  ${p}`).join("\n"));
if (problems.length) {
  console.log("\nProblems:");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("\nNo layout problems detected. Still look at every tile.");
