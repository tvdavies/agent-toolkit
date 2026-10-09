#!/usr/bin/env node
// Render a Lleverage deck or document to PDF, write page images to look at, and run
// the kit's PDF conformance check.
//
//   render.mjs in.html [out.pdf] [--qa DIR] [--dpi N] [--no-check]
//
// The venue comes from <body class="deck|doc">. Writes, next to out.pdf:
//   <name>.final.html   self-contained deliverable: data-icon / data-figure hooks expanded,
//                       relative <img> and <link rel="stylesheet"> inlined, and (decks) every
//                       footer number rewritten to its slide's position, "5 — 12"
//   <name>.pdf          deck 1280×720 px (960×540 pt) per slide, or A4 portrait per sheet
//   DIR/page-NN.png     every page rasterised from the PDF (default DIR: <name>-qa)
//
// Hooks:  <span class="icon s48" data-icon="forklift" data-mode="drawing"></span>
//         <span class="figure s160" data-figure="flow" data-midnight></span>
//
// Page images and the conformance check use PyMuPDF through `uv run --with pymupdf`.
// Without uv the images are screenshots of each page under print media and the
// conformance check is skipped (the run says so). Exits 1 if the check fails.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ChromeUnavailable, launchChrome } from "./lib/chrome.mjs";
import { FILES, figureSvg, iconSvg, requireKit, splitPages } from "./lib/kit.mjs";

const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const qaOption = option("--qa");
const dpi = Number(option("--dpi") ?? 96);
const check = !argv.includes("--no-check");
const [input, outputArg] = argv.filter((a) => !a.startsWith("--"));

// lleverage.css declares @page A4 for documents and Chromium keeps the first @page it
// meets, so a deck rewrites every @page rule to the slide size before printing.
const REWRITE_PAGE_RULES = `(() => { let n = 0;
  const walk = (rules) => { for (const r of rules) {
    if (r instanceof CSSPageRule) { r.style.setProperty("size", "1280px 720px"); r.style.setProperty("margin", "0"); n++; }
    else if (r.cssRules) walk(r.cssRules); } };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch {} }
  return n; })()`;

function attr(attrs, name) {
  return attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function dataUri(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".woff2": "font/woff2" }[ext] ?? "application/octet-stream";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

function isLocal(ref) {
  return !/^(?:[a-z]+:|#|\/\/)/i.test(ref);
}

// Relative paths resolve next to the source first, then in the kit's assets (so
// `logo/lockup-horizontal-dark.svg` works from anywhere).
function resolveRef(ref, baseDir, warnings) {
  const clean = decodeURIComponent(ref.split(/[?#]/)[0]);
  for (const dir of [baseDir, path.join(FILES.logos, ".."), FILES.logos]) {
    const candidate = path.resolve(dir, clean);
    if (fs.existsSync(candidate)) return candidate;
  }
  warnings.push(`not found: ${ref}`);
  return null;
}

function selfContained(html, baseDir, warnings) {
  html = html.replace(/<(span|i|div)(\s[^>]*?\bdata-icon="[^"]+"[^>]*)>\s*<\/\1>/g, (whole, tag, attrs) => {
    try {
      return `<${tag}${attrs}>${iconSvg(attr(attrs, "data-icon"), attr(attrs, "data-mode") ?? "drawing")}</${tag}>`;
    } catch (error) {
      warnings.push(error.message);
      return whole;
    }
  });
  html = html.replace(/<(span|i|div)(\s[^>]*?\bdata-figure="[^"]+"[^>]*)>\s*<\/\1>/g, (whole, tag, attrs) => {
    try {
      return `<${tag}${attrs}>${figureSvg(attr(attrs, "data-figure"), { midnight: /\bdata-midnight\b/.test(attrs) })}</${tag}>`;
    } catch (error) {
      warnings.push(error.message);
      return whole;
    }
  });
  html = html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*>/g, (tag) => {
    const href = attr(tag, "href");
    if (!href || !isLocal(href)) return tag;
    const file = resolveRef(href, baseDir, warnings);
    if (!file) return tag;
    const css = fs.readFileSync(file, "utf8").replace(/url\((['"]?)([^)'"]+)\1\)/g, (whole, _q, ref) => {
      if (!isLocal(ref)) return whole;
      const asset = resolveRef(ref, path.dirname(file), warnings);
      return asset ? `url(${dataUri(asset)})` : whole;
    });
    return `<style>/* ${path.basename(file)} */\n${css}\n</style>`;
  });
  html = html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/g, (whole, before, src, after) => {
    if (!isLocal(src)) return whole;
    const file = resolveRef(src, baseDir, warnings);
    return file ? `${before}${dataUri(file)}${after}` : whole;
  });
  return html;
}

// The layouts page carries its own numbers ("9 — 42"); a deck numbers by position,
// unpadded, as PowerPoint's slide-number field draws it.
function renumberSlides(html) {
  const { head, pages, tail } = splitPages(html, "deck");
  const numbered = pages.map((page, i) => page.replace(/(<div class="ftr-num">)[^<]*(<\/div>)/, `$1${i + 1} — ${pages.length}$2`));
  return head + numbered.join("\n") + tail;
}

// Mistakes the kit documents as easy to make and invisible until print.
function lint(html, venue, warnings) {
  const text = html.replace(/<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>|<script[\s\S]*?<\/script>|<[^>]+>/g, " ");
  const arrows = text.match(/[→←↑↓⟶⇒]/g);
  if (arrows) warnings.push(`${arrows.length} arrow glyph(s) in text: no brand face draws them; write the change in words or use a drawn .process .arrow`);
  if (/class="[^"]*\bmk\b[^"]*\bpin\b/.test(html)) warnings.push('class="mk pin" merges the stencil push-pin and the annotation pin; annotation pins are class="pin" alone');
  if (/data-(?:icon|figure)="[^"]+"[^>]*>\s*<\/(?:span|i|div)>/.test(html)) warnings.push("unexpanded data-icon / data-figure hook left in the output");
  if (venue === "deck" && !/size:\s*1280px 720px/.test(html)) warnings.push("no deck page setup; start decks with new.mjs --deck");
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" }, ...options });
}

const RASTERISE = `import sys, pymupdf
d = pymupdf.open(sys.argv[1])
for i, page in enumerate(d):
    page.get_pixmap(dpi=int(sys.argv[3])).save(f"{sys.argv[2]}/page-{i + 1:02d}.png")
print(len(d))`;

async function main() {
  if (!input) throw new Error("usage: render.mjs in.html [out.pdf] [--qa DIR] [--dpi N] [--no-check]");
  requireKit();
  const source = path.resolve(input);
  const out = path.resolve(outputArg ?? source.replace(/(\.final)?\.html?$/i, "") + ".pdf");
  const stem = out.replace(/\.pdf$/i, "");
  const finalHtml = `${stem}.final.html`;
  if (finalHtml === source) throw new Error(`refusing to overwrite the source ${source}; render the editable file, not the .final.html`);
  const qa = path.resolve(qaOption ?? `${stem}-qa`);

  const raw = fs.readFileSync(source, "utf8");
  const bodyClass = raw.match(/<body[^>]*\bclass="([^"]*)"/)?.[1] ?? "";
  const venue = /\bdeck\b/.test(bodyClass) ? "deck" : /\bdoc\b/.test(bodyClass) ? "doc" : null;
  if (!venue) throw new Error('cannot tell the venue: <body> needs class="deck" or class="doc" (start from new.mjs)');

  const warnings = [];
  let html = selfContained(raw, path.dirname(source), warnings);
  if (venue === "deck") html = renumberSlides(html);
  lint(html, venue, warnings);
  fs.writeFileSync(finalHtml, html);

  let browser;
  let expected;
  try {
    browser = await launchChrome();
  } catch (error) {
    if (error instanceof ChromeUnavailable) throw new Error(`${error.message} The self-contained HTML is at ${finalHtml}; it prints to PDF from any browser.`);
    throw error;
  }
  try {
    const page = await browser.newPage();
    await page.setViewport(1400, 900);
    await page.goto(pathToFileURL(finalHtml).href);
    await page.emulateMedia("print");
    expected = await page.evaluate(`document.querySelectorAll(${JSON.stringify(venue === "deck" ? ".slide" : ".sheet")}).length`);
    let pdf;
    if (venue === "deck") {
      await page.evaluate(REWRITE_PAGE_RULES);
      pdf = await page.pdf({ preferCSSPageSize: false, paperWidth: 1280 / 96, paperHeight: 720 / 96, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
    } else {
      pdf = await page.pdf({ preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 });
    }
    fs.writeFileSync(out, pdf);

    fs.mkdirSync(qa, { recursive: true });
    for (const f of fs.readdirSync(qa)) if (/^page-\d+\.png$/.test(f)) fs.rmSync(path.join(qa, f));
    const uv = run("uv", ["--version"]).status === 0;
    let pages;
    if (uv) {
      const r = run("uv", ["run", "--quiet", "--with", "pymupdf", "python", "-c", RASTERISE, out, qa, String(dpi)]);
      if (r.status !== 0) throw new Error(`rasterising the PDF failed:\n${r.stderr}`);
      pages = Number(r.stdout.trim().split("\n").pop());
    } else {
      // No PyMuPDF: screenshot each page element as it lays out for print.
      const boxes = await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(venue === "deck" ? ".slide" : ".sheet")})].map((el) => { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })`);
      for (const [i, box] of boxes.entries()) fs.writeFileSync(path.join(qa, `page-${String(i + 1).padStart(2, "0")}.png`), await page.screenshot(box));
      pages = (pdf.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
      warnings.push("uv not found: page images are print-media screenshots, not the PDF, and the conformance check was skipped");
    }
    if (pages !== expected) warnings.push(`PDF has ${pages} pages but the HTML has ${expected} ${venue === "deck" ? "slides" : "sheets"}: something overflowed onto an extra page or a page was lost`);
    console.log(`wrote ${out} (${pages} pages, ${venue})`);
    console.log(`wrote ${finalHtml}`);
    console.log(`page images in ${qa}/ — look at every one before delivering`);

    let failed = false;
    if (check && uv) {
      const r = run("uv", ["run", "--quiet", "--with", "pymupdf", "python", FILES.pdfCheck, out, ...(venue === "doc" ? ["--doc"] : [])]);
      const report = (r.stdout + r.stderr).split("\n").filter((line) => !line.includes("`fitz` API is deprecated")).join("\n").trim();
      console.log(`\nconformance check (${path.basename(FILES.pdfCheck)}):\n${report}`);
      failed = r.status !== 0;
    }
    for (const w of warnings) console.error(`WARN ${w}`);
    if (failed) process.exitCode = 1;
  } finally {
    browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
