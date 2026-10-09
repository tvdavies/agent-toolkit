#!/usr/bin/env node
// Automated QA for a video folder. Run before stills and before every render; fix what it reports.
//   node check.mjs <dir>
// Errors (exit 1): page errors or missing files, fonts that fall back, time with no scene or two scenes,
// text pushed outside the frame, text blocks overlapping each other.
// Warnings: scenes that start off the bar grid, text clipped by a container.
// Layout checks sample every scene at a quarter, half and just before its end. Elements inside [data-crop]
// (a camera stage that deliberately crops the UI) are only checked against the stage, and [data-qa-ignore]
// opts an element out.
import path from "node:path";
import { openVideo } from "./lib/page.mjs";

const dir = path.resolve(process.argv[2] || ".");
const { browser, page, errors } = await openVideo(dir);
const issues = errors.map((e) => ({ level: "error", t: "-", msg: `page: ${e}` }));

const meta = await page.evaluate(() => ({ end: window.DURATION, scenes: window.SCENES, bars: window.BEATS.bars }));
// Coverage: exactly one scene on screen at every moment.
for (let t = 0; t < meta.end; t += 0.05) {
  const on = meta.scenes.filter((s) => t >= s.from && t < s.to);
  if (on.length !== 1) { issues.push({ level: "error", t: t.toFixed(2), msg: on.length ? `two scenes at once: ${on.map((s) => s.id).join(", ")}` : "no scene on screen (black frame)" }); t += 0.5; }
}
const first = meta.scenes.find((s) => s.from <= 0 && s.to > 0);
issues.push({ level: "info", t: "0", msg: `frame 0 (the thumbnail) is #${first ? first.id : "nothing"}` });
for (const s of meta.scenes) if (s.from > 0.5 && !meta.bars.some((b) => Math.abs(b - s.from) < 0.03)) issues.push({ level: "warn", t: s.from.toFixed(2), msg: `#${s.id} starts off the bar grid` });

const layout = () => {
  const out = [], frame = document.querySelector(".mv-frame").getBoundingClientRect();
  const visible = (el) => { if (!el.getClientRects().length) return 0; let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.visibility === "hidden" || cs.display === "none") return 0; o *= +cs.opacity; } return o; };
  const name = (el) => { const parts = []; for (let e = el; e && e.nodeType === 1 && parts.length < 3 && !e.classList.contains("scene"); e = e.parentElement) parts.unshift(e.id ? "#" + e.id : e.tagName.toLowerCase() + (e.classList[0] ? "." + e.classList[0] : "")); return parts.join(" > "); };
  const scene = [...document.querySelectorAll(".scene")].find((s) => s.style.display !== "none");
  if (!scene) return out;
  const texts = [...scene.querySelectorAll("*")].filter((el) => !el.closest("[data-qa-ignore]") && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && visible(el) > 0.5);
  // Fonts: the first family of every visible text must be loaded, not a fallback.
  const loaded = new Set([...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/["']/g, "")));
  const generic = new Set(["serif", "sans-serif", "monospace", "system-ui", "ui-sans-serif", "ui-monospace", "ui-serif", "cursive", "-apple-system"]);
  for (const el of texts) {
    const fam = getComputedStyle(el).fontFamily.split(",")[0].trim().replace(/["']/g, "");
    if (!generic.has(fam) && !loaded.has(fam) && !document.fonts.check(`16px "${fam}"`)) out.push(["error", `font "${fam}" is not loaded (falls back): ${name(el)}`]);
  }
  const rect = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  for (const el of texts) {
    const r = rect(el), crop = el.closest("[data-crop]");
    const box = crop ? rect(crop) : { l: frame.left, t: frame.top, r: frame.right, b: frame.bottom };
    if (!crop && (r.l < box.l - 2 || r.r > box.r + 2 || r.t < box.t - 2 || r.b > box.b + 2)) out.push(["error", `text outside the frame: ${name(el)}`]);
    const cs = getComputedStyle(el);
    if (!crop && cs.textOverflow !== "ellipsis" && (el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== "visible")) out.push(["warn", `text clipped horizontally: ${name(el)}`]);
  }
  // Overlaps between text blocks outside the stages, and between those and a stage.
  const outside = texts.filter((el) => !el.closest("[data-crop]"));
  const blocks = [...outside, ...[...scene.querySelectorAll("[data-crop]")].filter((el) => visible(el) > 0.5)];
  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
    const a = blocks[i], b = blocks[j];
    if (a.contains(b) || b.contains(a)) continue;
    const p = rect(a), q = rect(b);
    const w = Math.min(p.r, q.r) - Math.max(p.l, q.l), h = Math.min(p.b, q.b) - Math.max(p.t, q.t);
    if (w > 3 && h > 3) out.push(["error", `overlap: ${name(a)} and ${name(b)}`]);
  }
  return out;
};
for (const s of meta.scenes) {
  const seen = new Set();
  for (const f of [0.25, 0.5, 0.97]) {
    const t = +(s.from + (s.to - s.from) * f).toFixed(2);
    await page.evaluate((t) => window.seek(t), t);
    for (const [level, msg] of await page.evaluate(layout)) if (!seen.has(msg)) { seen.add(msg); issues.push({ level, t, msg: `#${s.id}: ${msg}` }); }
  }
}
await browser.close();
const order = { error: 0, warn: 1, info: 2 };
issues.sort((a, b) => order[a.level] - order[b.level]);
for (const i of issues) console.log(`${i.level.toUpperCase().padEnd(5)} ${String(i.t).padStart(7)}s  ${i.msg}`);
const n = issues.filter((i) => i.level === "error").length;
console.log(n ? `\n${n} error(s)` : "\nno errors");
process.exit(n ? 1 : 0);
