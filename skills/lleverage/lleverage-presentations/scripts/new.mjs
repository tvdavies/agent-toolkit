#!/usr/bin/env node
// Start a deliverable from the kit's reference pages, so it carries the brand fonts,
// stylesheet and logo sprite exactly as the design system generated them.
//
//   new.mjs --deck out.html ["<layout>" ...]   slides on the named layouts, in order (repeats allowed)
//                                              default: "Cover — dark" "Agenda" "Title only" "Close — dark"
//   new.mjs --doc  out.html ["<sheet>" ...]    document pages by label; default: all four
//   --force                                    overwrite an existing file
//
// Layout names come from `brand.mjs layouts`; a unique substring also matches.

import fs from "node:fs";
import { FILES, pageName, requireKit, splitPages } from "./lib/kit.mjs";

// Prints one slide per 1280×720 page and undoes the reference page's screen preview
// (grey rail, gaps, scaled-down stages). render.mjs also sets the paper size, because
// lleverage.css declares @page A4 for documents.
const DECK_PRINT_CSS = `<style>/* lleverage-presentations: print one slide per page */
@page{size:1280px 720px;margin:0}
@media print{
  body.deck{background:none;margin:0}
  .rail{display:block;gap:0;padding:0}
  .stage{width:1280px;height:720px;overflow:hidden;break-after:page}
  .stage:last-child{break-after:auto}
  .stage>.slide,.slide{transform:none}
}
</style>
`;

const args = process.argv.slice(2);
const venue = args.includes("--deck") ? "deck" : args.includes("--doc") ? "doc" : null;
const force = args.includes("--force");
const [out, ...names] = args.filter((a) => !a.startsWith("--"));

try {
  if (!venue || !out) throw new Error('usage: new.mjs --deck|--doc out.html ["<layout or sheet>" ...] [--force]');
  if (fs.existsSync(out) && !force) throw new Error(`${out} exists; pass --force to overwrite it`);
  requireKit();
  const source = fs.readFileSync(venue === "deck" ? FILES.deckLayouts : FILES.documentTemplate, "utf8");
  const { head, pages, tail } = splitPages(source, venue);
  const wanted = names.length ? names : venue === "deck" ? ["Cover — dark", "Agenda", "Title only", "Close — dark"] : pages.map(pageName);
  const chosen = wanted.map((name) => {
    const page = pages.find((p) => pageName(p) === name) ?? pages.find((p) => pageName(p).toLowerCase().includes(name.toLowerCase()));
    if (!page) throw new Error(`no ${venue === "deck" ? "layout" : "sheet"} '${name}'; run: brand.mjs ${venue === "deck" ? "layouts" : "sheets"}`);
    return page;
  });
  const html = (venue === "deck" ? head.replace("</head>", `${DECK_PRINT_CSS}</head>`) : head) + chosen.join("\n") + tail;
  fs.writeFileSync(out, html);
  console.log(`wrote ${out}: ${chosen.length} ${venue === "deck" ? "slides" : "pages"} (${chosen.map(pageName).join(" · ")})`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
