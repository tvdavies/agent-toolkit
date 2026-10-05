#!/usr/bin/env node
// Build a self-contained house-style report from a source file (front matter + HTML body fragment).
//
//   node build-report.mjs report.src.html [-o report.html] [--card-image https://…/card.png] [--no-fonts]
//
// The output is one HTML file: CSS, fonts, charts and diagrams are inlined; there is no JavaScript.
// The <head> also carries Open Graph / Twitter Card tags so shared links unfurl as a card in Slack.
// Pass --card-image with the uploaded URL of the PNG from card.mjs to give that card an image.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderChart, ChartError } from "./charts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, "../assets");

export class BuildError extends Error {}

// Share-card image size. card.mjs renders at exactly this size.
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

function parseArgs(argv) {
  const opts = { fonts: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") opts.out = argv[++i];
    else if (a === "--no-fonts") opts.fonts = false;
    else if (a === "--card-image") opts.cardImage = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("-")) throw new BuildError(`Unknown option ${a}`);
    else if (!opts.src) opts.src = a;
    else throw new BuildError(`Unexpected argument ${a}`);
  }
  return opts;
}

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const stripTags = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
export const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const slugify = (s) => decode(stripTags(s)).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";

// ---------- Front matter ----------

const KNOWN_META = ["date", "author", "audience", "data", "status", "classification"];
const META_LABELS = { date: "Date", author: "Author", audience: "Audience", data: "Data", status: "Status", classification: "Classification" };

export function parseFrontMatter(text) {
  const m = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) throw new BuildError("Source must start with a front-matter block delimited by --- lines (title is required).");
  const fm = { extra: [] };
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z][\w -]*?)\s*:\s*(.*)$/);
    if (!kv) throw new BuildError(`Cannot parse front-matter line: ${raw}`);
    const key = kv[1].trim().toLowerCase().replace(/\s+/g, "_");
    let value = kv[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (key.startsWith("meta_")) fm.extra.push([kv[1].trim().slice(5).replace(/_/g, " "), value]);
    else fm[key] = value;
  }
  if (!fm.title) throw new BuildError("Front matter needs a title.");
  return { fm, body: text.slice(m[0].length) };
}

export function formatDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return value;
  const d = new Date(`${value}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}

// ---------- Body transforms ----------

function renderCharts(body, warnings, counts) {
  return body.replace(/<script\b([^>]*\bdata-chart\b[^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, json) => {
    let spec;
    try {
      spec = JSON.parse(json);
    } catch (error) {
      throw new BuildError(`Chart JSON is invalid (${error.message}) near: ${json.trim().slice(0, 120)}`);
    }
    try {
      counts.charts++;
      return renderChart(spec);
    } catch (error) {
      if (error instanceof ChartError) throw new BuildError(`Chart ${counts.charts} (${spec.type ?? "?"}): ${error.message}`);
      throw error;
    }
  });
}

const DOT_DEFAULTS = [
  'graph [fontname="IBM Plex Sans", fontsize=11, bgcolor="transparent", pad="0.15", nodesep="0.35", ranksep="0.45", color="#c9c4b8", fontcolor="#6c6b65"]',
  'node [fontname="IBM Plex Sans", fontsize=11, shape=box, style="filled", fillcolor="#ffffff", color="#c9c4b8", fontcolor="#17212b", penwidth=1, margin="0.16,0.08", height=0.36]',
  'edge [fontname="IBM Plex Mono", fontsize=9, color="#8a877f", fontcolor="#6c6b65", arrowsize=0.6, penwidth=1]',
].join("\n");

function renderDiagrams(body, counts) {
  return body.replace(/<script\b([^>]*\bdata-diagram\b[^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, source) => {
    counts.diagrams++;
    const brace = source.indexOf("{");
    if (brace < 0) throw new BuildError(`Diagram ${counts.diagrams}: not a Graphviz graph.`);
    const withDefaults = `${source.slice(0, brace + 1)}\n${DOT_DEFAULTS}\n${source.slice(brace + 1)}`;
    const result = spawnSync("dot", ["-Tsvg"], { input: withDefaults, encoding: "utf8" });
    if (result.error?.code === "ENOENT") throw new BuildError("Graphviz `dot` is not installed. Use the HTML .flow/.steps diagram components instead, or install graphviz.");
    if (result.status !== 0) throw new BuildError(`Diagram ${counts.diagrams}: dot failed: ${result.stderr.trim()}`);
    return result.stdout
      .replace(/<\?xml[\s\S]*?\?>/, "")
      .replace(/<!DOCTYPE[\s\S]*?>/, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<svg\b/, '<svg role="img"')
      .replace(/<title>[^<]*<\/title>/g, "")
      .trim();
  });
}

function inlineImages(body, srcDir, warnings) {
  const types = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
  return body.replace(/<img\b([^>]*?)\bsrc="([^"]+)"([^>]*)>/gi, (match, pre, src, post) => {
    if (/^data:/.test(src)) return match;
    if (/^[a-z]+:\/\//i.test(src)) throw new BuildError(`External image ${src}: download it next to the source and reference it by relative path.`);
    const file = path.resolve(srcDir, src);
    const type = types[path.extname(file).toLowerCase()];
    if (!type) throw new BuildError(`Unsupported image type: ${src}`);
    if (!fs.existsSync(file)) throw new BuildError(`Image not found: ${src}`);
    if (!/\balt=/.test(pre + post)) warnings.push(`Image ${src} has no alt text.`);
    return `<img${pre}src="data:${type};base64,${fs.readFileSync(file).toString("base64")}"${post}>`;
  });
}

function wrapTables(body) {
  return body.replace(/(<div class="table-wrap[^"]*">\s*)?(<table\b[\s\S]*?<\/table>)/gi, (match, wrapped, table) => (wrapped ? match : `<div class="table-wrap">${table}</div>`));
}

function numberHeadings(body, toc) {
  const used = new Set();
  const uniqueId = (base) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
  for (const m of body.matchAll(/\bid="([^"]+)"/g)) used.add(m[1]);
  let h2n = 0;
  let h3n = 0;
  let current = null;
  return body.replace(/<(h2|h3)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (match, tag, attrs, inner) => {
    const unnumbered = /\bclass="[^"]*\bunnumbered\b/.test(attrs);
    const explicit = attrs.match(/\bdata-n="([^"]*)"/)?.[1];
    let id = attrs.match(/\bid="([^"]+)"/)?.[1];
    let newAttrs = attrs;
    if (!id) {
      id = uniqueId(slugify(inner));
      newAttrs += ` id="${id}"`;
    }
    if (tag.toLowerCase() === "h2") {
      h3n = 0;
      if (unnumbered) {
        current = null;
        toc.push({ id, n: "", text: stripTags(inner) });
        return `<h2${newAttrs}>${inner}</h2>`;
      }
      const label = explicit ?? String(++h2n).padStart(2, "0");
      current = explicit ?? String(h2n);
      toc.push({ id, n: label, text: stripTags(inner) });
      return `<h2${newAttrs}><span class="h-n">${esc(label)}</span>${inner}</h2>`;
    }
    if (unnumbered || current == null) return `<h3${newAttrs}>${inner}</h3>`;
    const label = explicit ?? `${current}.${++h3n}`;
    return `<h3${newAttrs}><span class="h-n">${esc(label)}</span>${inner}</h3>`;
  });
}

function numberFigures(body, warnings, counts) {
  let f = 0;
  body = body.replace(/<figure\b([^>]*)>([\s\S]*?)<\/figure>/gi, (match, attrs, inner) => {
    if (!/<figcaption\b/i.test(inner)) {
      warnings.push(`A figure has no <figcaption>; every chart or diagram needs a caption that states its point.`);
      return match;
    }
    f++;
    let newAttrs = attrs;
    if (!/\bid="/.test(attrs)) newAttrs += ` id="fig-${f}"`;
    if (!/\bclass="/.test(attrs)) newAttrs += ' class="figure"';
    const newInner = inner.replace(/<figcaption\b([^>]*)>/i, `<figcaption$1><span class="f-n">Figure ${f}</span>`);
    return `<figure${newAttrs}>${newInner}</figure>`;
  });
  let t = 0;
  body = body.replace(/<caption\b([^>]*)>/gi, (_, attrs) => `<caption${attrs}><span class="t-n">Table ${++t}</span>`);
  counts.figures = f;
  counts.tables = t;
  return body;
}

function validate(body, warnings) {
  const leftoverScript = body.match(/<script\b[^>]*>/i);
  if (leftoverScript) throw new BuildError(`Scripts are not allowed in reports (found ${leftoverScript[0]}). Use data-chart or data-diagram blocks.`);
  if (/<link\b|<style\b|@import/i.test(body)) throw new BuildError("Do not add <link>, <style> or @import to the body: the house stylesheet is applied by the build. Use the documented component classes.");
  if (/\sstyle="(?![^"]*--v:)[^"]*"/i.test(body)) warnings.push("Inline style attributes found. Prefer component classes so reports stay consistent.");
  const external = body.match(/\b(?:src|href)="(?:https?:)?\/\/[^"]*\.(?:css|js|woff2?|ttf)"/i);
  if (external) throw new BuildError(`External asset reference ${external[0]}: reports must be self-contained.`);
  if (!/class="summary/.test(body)) warnings.push('No <section class="summary"> found. Reports should open with the bottom line and key findings.');
  if (/<h1\b/i.test(body)) warnings.push("The body contains an <h1>. The title comes from front matter; use <h2> for sections.");
}

// ---------- Share card (link previews) ----------

const plain = (html) => decode(stripTags(html ?? ""));

function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const sentence = cut.lastIndexOf(". ");
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:\s]+$/, "")}…`;
}

// What a link preview shows. Everything comes from content already in the report, so an
// anonymised report gives an anonymised card.
export function shareInfo(fm, rawBody) {
  const bottomLine = rawBody.match(/<p\b[^>]*class="[^"]*\bbottom-line\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  const description = truncate(plain(fm.card_description ?? bottomLine ?? fm.standfirst ?? ""), 240);
  const stats = [];
  for (const m of rawBody.matchAll(/<div\b[^>]*class="stat(?:\s+([^"]*))?"[^>]*>([\s\S]*?)<\/div>/gi)) {
    const value = m[2].match(/class="stat-value"[^>]*>([\s\S]*?)<\/span>/i)?.[1];
    const label = m[2].match(/class="stat-label"[^>]*>([\s\S]*?)<\/span>/i)?.[1];
    if (value == null || label == null) continue;
    const tone = (m[1] ?? "").split(/\s+/).find((c) => ["bad", "warn", "good", "accent"].includes(c)) ?? "";
    stats.push({ value: plain(value), label: plain(label), tone });
  }
  const text = plain(rawBody.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<svg\b[\s\S]*?<\/svg>/gi, " "));
  const words = text.split(/\s+/).filter(Boolean).length;
  return {
    title: plain(fm.title),
    eyebrow: plain(fm.eyebrow ?? ""),
    siteName: fm.series ?? "Technical report",
    date: formatDate(fm.date) ?? "",
    isoDate: /^\d{4}-\d{2}-\d{2}$/.test(fm.date ?? "") ? fm.date : null,
    description,
    stats: stats.slice(0, 4),
    readingTime: `${Math.max(1, Math.round(words / 230))} min read`,
  };
}

function validateCardImage(url) {
  if (url == null) return null;
  if (!/^https:\/\/[^\s"<>]+$/i.test(url)) throw new BuildError(`--card-image must be an absolute https URL (got ${url}). Upload the card PNG first and pass the URL it returns.`);
  if (!/\.(png|jpe?g)(\?[^\s]*)?$/i.test(url)) throw new BuildError(`--card-image must point to a PNG or JPEG (got ${url}).`);
  if (/[?&]private=1\b/.test(url)) throw new BuildError("--card-image cannot be a private upload: Slack's crawler cannot fetch it.");
  return url;
}

function shareMeta(info, cardImage, lang) {
  const tags = [
    ["property", "og:type", "article"],
    ["property", "og:site_name", info.siteName],
    ["property", "og:title", info.title],
    info.description && ["property", "og:description", info.description],
    ["property", "og:locale", (lang ?? "en-GB").replace("-", "_")],
    info.isoDate && ["property", "article:published_time", info.isoDate],
    ...(cardImage
      ? [["property", "og:image", cardImage], ["property", "og:image:type", /\.png/i.test(cardImage) ? "image/png" : "image/jpeg"],
         ["property", "og:image:width", String(CARD_WIDTH)], ["property", "og:image:height", String(CARD_HEIGHT)],
         ["property", "og:image:alt", `${info.siteName}: ${info.title}`]]
      : []),
    ["name", "twitter:card", cardImage ? "summary_large_image" : "summary"],
    // Slack shows up to two label/data pairs as fields on the card.
    info.date && ["name", "twitter:label1", "Date"], info.date && ["name", "twitter:data1", info.date],
    ["name", "twitter:label2", "Reading time"], ["name", "twitter:data2", info.readingTime],
  ].filter(Boolean);
  return tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${esc(value)}">`).join("\n");
}

// ---------- Assembly ----------

export function inlineCss(fonts) {
  let css = fs.readFileSync(path.join(ASSETS, "report.css"), "utf8");
  css = css.replace(/url\("fonts\/([^"]+)"\)/g, (_, file) => {
    if (!fonts) return 'url("")';
    const data = fs.readFileSync(path.join(ASSETS, "fonts", file)).toString("base64");
    return `url(data:font/woff2;base64,${data})`;
  });
  if (!fonts) css = css.replace(/@font-face\s*{[^}]*}\s*/g, "");
  return css;
}

function assemble({ fm, body, toc, css, share }) {
  const date = formatDate(fm.date);
  const meta = [];
  for (const key of KNOWN_META) if (fm[key]) meta.push([META_LABELS[key], key === "date" ? date : fm[key]]);
  meta.push(...fm.extra);
  const series = fm.series ?? "Technical report";
  const showToc = fm.toc !== "false" && toc.filter((t) => t.n || t.id).length >= 3;
  const tocHtml = showToc
    ? `<nav class="toc" aria-label="Contents"><div class="toc-inner"><div class="toc-label">Contents</div><ol>${toc
        .map((t) => `<li><a href="#${esc(t.id)}"><span class="toc-n">${esc(t.n)}</span><span>${esc(t.text)}</span></a></li>`)
        .join("")}</ol></div></nav>`
    : "";
  const mastMeta = [fm.ref, date].filter(Boolean).map(esc).join(" &nbsp;/&nbsp; ");
  return `<!doctype html>
<html lang="${esc(fm.lang ?? "en-GB")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(stripTags(fm.title))}</title>
${fm.standfirst ? `<meta name="description" content="${esc(stripTags(fm.standfirst))}">` : ""}
${share}
<meta name="generator" content="reports skill build">
<style>
${css}
</style>
</head>
<body>
<header class="masthead"><div class="masthead-inner"><span class="masthead-series">${esc(series)}</span><span class="masthead-meta">${mastMeta}</span></div></header>
<div class="page${showToc ? "" : " no-toc"}">
${tocHtml}
<main class="main">
<header class="title-block">
${fm.eyebrow ? `<div class="eyebrow">${esc(fm.eyebrow)}</div>` : ""}
<h1>${fm.title}</h1>
${fm.standfirst ? `<p class="standfirst">${fm.standfirst}</p>` : ""}
${meta.length ? `<dl class="meta">${meta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>` : ""}
</header>
${body.trim()}
<footer class="report-footer"><span>${esc(series)}${fm.ref ? ` &nbsp;/&nbsp; ${esc(fm.ref)}` : ""}</span><span>${esc(date ?? "")}</span></footer>
</main>
</div>
</body>
</html>
`;
}

export function buildReport(srcPath, { fonts = true, cardImage } = {}) {
  const text = fs.readFileSync(srcPath, "utf8");
  const { fm, body: rawBody } = parseFrontMatter(text);
  const warnings = [];
  const counts = { charts: 0, diagrams: 0, figures: 0, tables: 0 };
  const toc = [];
  const info = shareInfo(fm, rawBody);
  const share = shareMeta(info, validateCardImage(cardImage), fm.lang);
  let body = renderCharts(rawBody, warnings, counts);
  body = renderDiagrams(body, counts);
  validate(body, warnings);
  body = inlineImages(body, path.dirname(path.resolve(srcPath)), warnings);
  body = wrapTables(body);
  body = numberHeadings(body, toc);
  body = numberFigures(body, warnings, counts);
  const html = assemble({ fm, body, toc, css: inlineCss(fonts), share });
  return { html, warnings, counts, sections: toc.filter((t) => t.n).length, share: { ...info, image: cardImage ?? null } };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (opts.help || !opts.src) {
    console.log("Usage: build-report.mjs <report.src.html> [-o report.html] [--card-image https://…/card.png] [--no-fonts]");
    process.exit(opts.help ? 0 : 2);
  }
  const out = opts.out ?? opts.src.replace(/\.src\.html$/, ".html").replace(/(\.html)?$/, (m) => (m ? m : ".html"));
  if (path.resolve(out) === path.resolve(opts.src)) {
    console.error("Output would overwrite the source. Name the source *.src.html or pass -o.");
    process.exit(2);
  }
  try {
    const { html, warnings, counts, sections, share } = buildReport(opts.src, opts);
    fs.writeFileSync(out, html);
    for (const w of warnings) console.warn(`warning: ${w}`);
    const kb = Math.round(Buffer.byteLength(html) / 1024);
    console.log(`Built ${out} (${kb} KB): ${sections} sections, ${counts.figures} figures (${counts.charts} charts, ${counts.diagrams} graphviz), ${counts.tables} captioned tables.`);
    console.log(share.image ? `Share card: image ${share.image}` : "Share card: no image yet (render it with card.mjs, upload it, then rebuild with --card-image <url>).");
  } catch (error) {
    if (error instanceof BuildError) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
