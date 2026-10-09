// Paths into the cached brand kit (see ../sync.sh) and the helpers every script shares.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = process.env.LLEVERAGE_PRESENTATIONS_HOME ?? path.join(os.homedir(), ".cache", "lleverage-presentations");
export const KIT = path.join(HOME, "delta-agent", "plugins", "delta", "skills", "lleverage-presentations");
export const VOICE = path.join(HOME, "delta-agent", "plugins", "delta", "skills", "lleverage-content-voice");

export const FILES = {
  version: path.join(KIT, "system", "SYSTEM-VERSION.json"),
  tokens: path.join(KIT, "system", "brand.tokens.json"),
  css: path.join(KIT, "system", "lleverage.css"),
  theme: path.join(KIT, "system", "ppt-theme.json"),
  exemplarsIndex: path.join(KIT, "system", "exemplars-index.json"),
  icons: path.join(KIT, "system", "assets", "icons", "icons.json"),
  figures: path.join(KIT, "system", "assets", "figures", "figures.json"),
  deckLayouts: path.join(KIT, "reference", "Lleverage deck layouts.html"),
  documentTemplate: path.join(KIT, "reference", "Lleverage document template.html"),
  componentPages: path.join(KIT, "reference", "Lleverage component pages.html"),
  exemplars: path.join(KIT, "reference", "Lleverage exemplars.html"),
  readMe: path.join(KIT, "reference", "READ ME FIRST.md"),
  assetsReadMe: path.join(KIT, "reference", "READ ME - assets.md"),
  brand: path.join(KIT, "references", "brand.md"),
  pdfCheck: path.join(KIT, "reference", "pdf-conformance-check.py"),
  logos: path.join(KIT, "assets", "logo"),
  voiceSkill: path.join(VOICE, "SKILL.md"),
  voiceContext: path.join(VOICE, "references", "brand-context.md"),
};

export function requireKit() {
  if (!fs.existsSync(FILES.version)) {
    const sync = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "sync.sh");
    throw new Error(`No brand kit at ${KIT}. Run ${path.resolve(sync)} first.`);
  }
  return JSON.parse(fs.readFileSync(FILES.version, "utf8"));
}

const cache = new Map();
function json(file) {
  if (!cache.has(file)) cache.set(file, JSON.parse(fs.readFileSync(file, "utf8")));
  return cache.get(file);
}

// Icon modes as the design system names them, plus the friendlier -on-midnight spellings.
const ICON_MODES = {
  drawing: "drawing", compact: "compact", stencil: "stencil",
  drawingDark: "drawingDark", compactDark: "compactDark", stencilDark: "stencilDark",
  "drawing-on-midnight": "drawingDark", "compact-on-midnight": "compactDark", "stencil-on-midnight": "stencilDark",
};

export function iconNames() {
  return Object.values(json(FILES.icons).icons).map((v) => v.slug).sort();
}

export function figureNames() {
  return Object.values(json(FILES.figures).figures).map((v) => v.slug).sort();
}

export function iconSvg(name, mode = "drawing") {
  const data = json(FILES.icons);
  const key = ICON_MODES[mode];
  if (!key) throw new Error(`unknown icon mode '${mode}'; use drawing, compact, stencil or one of them with -on-midnight`);
  const icon = Object.values(data.icons).find((v) => v.slug === name.toLowerCase());
  if (!icon) throw new Error(`unknown icon '${name}'; run: brand.mjs list`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${data.viewBox}">${icon.body[key]}</svg>`;
}

export function figureSvg(name, { midnight = false } = {}) {
  const figure = Object.values(json(FILES.figures).figures).find((v) => v.slug === name.toLowerCase());
  if (!figure) throw new Error(`unknown figure '${name}'; run: brand.mjs list`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${figure.viewBox}">${midnight ? figure.bodyDark : figure.body}</svg>`;
}

// Splits a reference page into the part before its first page, each page, and the tail.
// Deck pages are `<div class="stage"><section class="slide" data-layout=…>…</section></div>`;
// document pages are `<section class="sheet" data-screen-label=…>…</section>`.
// A page ends at the last closing tag before the next page starts (or before </body>),
// so pages may nest their own <section> elements.
export function splitPages(html, venue) {
  const open = venue === "deck" ? '<div class="stage">' : '<section class="sheet';
  const close = venue === "deck" ? "</section></div>" : "</section>";
  const starts = [];
  for (let at = html.indexOf(open); at >= 0; at = html.indexOf(open, at + open.length)) starts.push(at);
  if (!starts.length) throw new Error(`no ${venue} pages found`);
  const bodyEnd = html.lastIndexOf("</body>") >= 0 ? html.lastIndexOf("</body>") : html.length;
  let end = 0;
  const pages = starts.map((start, i) => {
    const limit = starts[i + 1] ?? bodyEnd;
    const last = html.lastIndexOf(close, limit - close.length);
    if (last < start) throw new Error(`unterminated ${venue} page at offset ${start}`);
    end = last + close.length;
    return html.slice(start, end);
  });
  return { head: html.slice(0, starts[0]), pages, tail: html.slice(end) };
}

export function pageName(page) {
  return page.match(/data-layout="([^"]+)"/)?.[1] ?? page.match(/data-screen-label="([^"]+)"/)?.[1] ?? "";
}
