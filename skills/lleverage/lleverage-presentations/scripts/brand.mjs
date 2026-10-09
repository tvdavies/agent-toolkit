#!/usr/bin/env node
// Look things up in the cached brand kit without reading 400 KB reference pages whole.
//
//   brand.mjs info                         kit version and the path of every file the skill reads
//   brand.mjs layouts                      the 40 deck layouts, in reference order
//   brand.mjs show "<layout>"              one layout's slide as HTML (copy it, change only data-ph boxes)
//   brand.mjs sheets                       the document template's pages
//   brand.mjs show-sheet "<label>"         one document page as HTML
//   brand.mjs list                         every icon and figure name
//   brand.mjs icon <name> [mode]           icon SVG; modes drawing (default) · compact · stencil, each also -on-midnight
//   brand.mjs figure <name> [--midnight]   isometric figure SVG

import fs from "node:fs";
import { FILES, figureNames, figureSvg, iconNames, iconSvg, pageName, requireKit, splitPages } from "./lib/kit.mjs";

const [command, ...args] = process.argv.slice(2);

function pages(venue) {
  const file = venue === "deck" ? FILES.deckLayouts : FILES.documentTemplate;
  return splitPages(fs.readFileSync(file, "utf8"), venue).pages;
}

function find(venue, name) {
  const all = pages(venue);
  const match = all.find((p) => pageName(p) === name) ?? all.find((p) => pageName(p).toLowerCase().includes(name.toLowerCase()));
  if (!match) throw new Error(`no ${venue === "deck" ? "layout" : "sheet"} '${name}'; run: brand.mjs ${venue === "deck" ? "layouts" : "sheets"}`);
  return match;
}

try {
  const version = requireKit();
  switch (command) {
    case "info":
      console.log(`kit ${version.version} (generated ${version.generated}, tokens ${version.tokensDigest})`);
      for (const [key, file] of Object.entries(FILES)) console.log(`${key.padEnd(17)} ${file}${fs.existsSync(file) ? "" : "  (missing)"}`);
      break;
    case "layouts":
      [...new Set(pages("deck").map(pageName))].forEach((name) => console.log(name));
      break;
    case "sheets":
      pages("doc").forEach((page) => console.log(pageName(page)));
      break;
    case "show":
      if (!args[0]) throw new Error('usage: brand.mjs show "<layout>"');
      console.log(find("deck", args[0]));
      break;
    case "show-sheet":
      if (!args[0]) throw new Error('usage: brand.mjs show-sheet "<label>"');
      console.log(find("doc", args[0]));
      break;
    case "list":
      console.log(`icons: ${iconNames().join(", ")}`);
      console.log(`figures: ${figureNames().join(", ")}`);
      break;
    case "icon":
      if (!args[0]) throw new Error("usage: brand.mjs icon <name> [mode]");
      console.log(iconSvg(args[0], args[1] ?? "drawing"));
      break;
    case "figure":
      if (!args[0]) throw new Error("usage: brand.mjs figure <name> [--midnight]");
      console.log(figureSvg(args[0], { midnight: args.includes("--midnight") }));
      break;
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 13).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      process.exit(command ? 2 : 0);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
