#!/usr/bin/env node
// Render the share-card image (link preview for Slack and similar) for a report.
//
//   node card.mjs report.src.html [-o report.card.png] [--html card.html]
//
// The card is a 1200×630 PNG in the house style: report type, date, eyebrow, title and up to
// four headline figures from the report's .stats block (or its bottom line when there are none).
// Upload the PNG, then rebuild the report with --card-image <url> so the page references it.
// Requires headless Chrome/Chromium (same as render-check.mjs).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFrontMatter, shareInfo, inlineCss, esc, BuildError, CARD_WIDTH, CARD_HEIGHT } from "./build-report.mjs";

const CARD_CSS = `
html, body { margin: 0; padding: 0; width: ${CARD_WIDTH}px; height: ${CARD_HEIGHT}px; overflow: hidden; background: var(--paper); }
.share { box-sizing: border-box; width: ${CARD_WIDTH}px; height: ${CARD_HEIGHT}px; padding: 50px 72px 54px; display: flex; flex-direction: column; border-top: 10px solid var(--accent); }
.share-top { display: flex; justify-content: space-between; align-items: center; font: 500 20px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--ink); }
.share-type { display: flex; align-items: center; gap: 16px; }
.share-type::before { content: ""; width: 30px; height: 3px; background: var(--accent); }
.share-date { color: var(--muted); font-weight: 400; }
.share-eyebrow { margin-top: 46px; font: 500 19px/1.2 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.share-title { margin: 16px 0 0; font-family: var(--serif); font-weight: 500; line-height: 1.08; letter-spacing: -.01em; color: var(--ink); max-width: 1040px;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.share-title.l1 { font-size: 66px; } .share-title.l2 { font-size: 58px; } .share-title.l3 { font-size: 50px; } .share-title.l4 { font-size: 44px; }
.share-figs { margin-top: auto; display: grid; gap: 28px; border-top: 1px solid var(--line-strong); padding-top: 26px; }
.share-v { font: 500 54px/1 var(--serif); color: var(--ink); white-space: nowrap; }
.share-v.bad { color: var(--bad); } .share-v.warn { color: var(--warn); } .share-v.good { color: var(--good); } .share-v.accent { color: var(--accent); }
.share-l { margin-top: 10px; font: 400 18px/1.3 var(--sans); color: var(--text); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.share-line { margin-top: auto; border-top: 1px solid var(--line-strong); padding-top: 24px; font: 400 26px/1.4 var(--serif); color: var(--text);
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
`;

// Longer titles get a smaller size so most fit in three lines without clamping.
const titleSize = (title) => (title.length <= 55 ? "l1" : title.length <= 85 ? "l2" : title.length <= 120 ? "l3" : "l4");

export function cardHtml(srcPath, { fonts = true } = {}) {
  const { fm, body } = parseFrontMatter(fs.readFileSync(srcPath, "utf8"));
  const info = shareInfo(fm, body);
  const figures = info.stats.length
    ? `<div class="share-figs" style="grid-template-columns:repeat(${info.stats.length},1fr)">${info.stats
        .map((s) => `<div><div class="share-v ${esc(s.tone)}">${esc(s.value)}</div><div class="share-l">${esc(s.label)}</div></div>`)
        .join("")}</div>`
    : info.description ? `<p class="share-line">${esc(info.description)}</p>` : "";
  const html = `<!doctype html><html lang="${esc(fm.lang ?? "en-GB")}"><head><meta charset="utf-8"><style>${inlineCss(fonts)}${CARD_CSS}</style></head><body>
<div class="share">
<div class="share-top"><span class="share-type">${esc(info.siteName)}</span><span class="share-date">${esc(info.date)}</span></div>
${info.eyebrow ? `<div class="share-eyebrow">${esc(info.eyebrow)}</div>` : ""}
<h1 class="share-title ${titleSize(info.title)}">${esc(info.title)}</h1>
${figures}
</div></body></html>`;
  return { html, info };
}

async function main() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o" || a === "--out") opts.out = args[++i];
    else if (a === "--html") opts.html = args[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (!opts.src) opts.src = a;
  }
  if (opts.help || !opts.src) {
    console.log("Usage: card.mjs <report.src.html> [-o report.card.png] [--html card.html]");
    process.exit(opts.help ? 0 : 2);
  }
  const out = path.resolve(opts.out ?? opts.src.replace(/(\.src)?\.html?$/, "") + ".card.png");

  let card;
  try {
    card = cardHtml(opts.src);
  } catch (error) {
    if (error instanceof BuildError) { console.error(`error: ${error.message}`); process.exit(1); }
    throw error;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-card-"));
  const htmlPath = opts.html ? path.resolve(opts.html) : path.join(tmpDir, "card.html");
  fs.writeFileSync(htmlPath, card.html);

  const { launchChrome, ChromeUnavailable } = await import("./lib/chrome.mjs");
  let browser;
  try {
    browser = await launchChrome();
  } catch (error) {
    console.error(error instanceof ChromeUnavailable ? `${error.message} The report can still be shared without a card image.` : error.message);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(3);
  }
  const problems = [];
  try {
    const page = await browser.newPage();
    await page.setViewport(CARD_WIDTH, CARD_HEIGHT);
    await page.goto(pathToFileURL(htmlPath).href);
    const check = await page.evaluate(`(() => {
      const clamped = [...document.querySelectorAll('.share-title, .share-l, .share-line')].filter((el) => el.scrollHeight - el.clientHeight > parseFloat(getComputedStyle(el).fontSize) * 0.5).map((el) => el.className.split(' ')[0]);
      const fig = document.querySelector('.share-figs, .share-line');
      const title = document.querySelector('.share-title').getBoundingClientRect();
      const figTop = fig ? fig.getBoundingClientRect().top : ${CARD_HEIGHT};
      const wideValues = [...document.querySelectorAll('.share-v')].filter((el) => el.scrollWidth > el.parentElement.clientWidth + 1).map((el) => el.textContent);
      return { clamped, crowded: title.bottom > figTop - 24, wideValues, fonts: [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family) };
    })()`);
    if (check.clamped.includes("share-title")) problems.push("The title is cut off after three lines. Shorten the title.");
    if (check.clamped.length && !check.clamped.includes("share-title")) problems.push(`Text is cut off in: ${[...new Set(check.clamped)].join(", ")}. Shorten the stat labels or the bottom line.`);
    if (check.crowded) problems.push("The title runs into the figures. Shorten the title or the eyebrow.");
    if (check.wideValues.length) problems.push(`Stat values too wide for their column: ${check.wideValues.join(", ")}.`);
    if (check.fonts.length) problems.push(`Fonts failed to load: ${check.fonts.join(", ")}.`);
    fs.writeFileSync(out, await page.screenshot({ x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT }));
  } finally {
    browser.close();
    if (!opts.html) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  const kb = Math.round(fs.statSync(out).size / 1024);
  console.log(`Card ${out} (${kb} KB, ${CARD_WIDTH}×${CARD_HEIGHT}): ${card.info.stats.length} figure(s)${card.info.stats.length ? "" : ", bottom line shown instead"}.`);
  if (problems.length) {
    console.log("\nProblems:");
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log("Look at the PNG, upload it, then rebuild the report with --card-image <url>.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
