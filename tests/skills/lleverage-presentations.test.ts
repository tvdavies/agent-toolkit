import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The real brand kit is private, so these run against a minimal stand-in laid out like
// the cached delta-agent checkout.
const root = path.resolve(import.meta.dir, "../..");
const scripts = path.join(root, "skills/lleverage/lleverage-presentations/scripts");
const { splitPages, pageName } = await import(path.join(scripts, "lib/kit.mjs"));

const slide = (layout: string, n: number) =>
  `<div class="stage"><section class="slide" data-layout="${layout}"><div class="hdr"></div><div class="ftr-num">${n} — 42</div></section></div>`;
const deck = `<html><head><style>@page{size:A4}</style></head><body class="deck"><div class="rail">\n${slide("Cover — dark", 1)}\n${slide("Title only", 38)}\n${slide("Close — dark", 42)}\n</div></body></html>`;
const sheet = (label: string) => `<section class="sheet" data-screen-label="${label}"><section class="inner"></section></section>`;
const doc = `<html><head></head><body class="doc">${sheet("01 Cover")}${sheet("03 Content")}</body></html>`;

function fakeKit() {
  const home = mkdtempSync(path.join(tmpdir(), "llp-test-"));
  const kit = path.join(home, "delta-agent/plugins/delta/skills/lleverage-presentations");
  mkdirSync(path.join(kit, "system"), { recursive: true });
  mkdirSync(path.join(kit, "reference"), { recursive: true });
  writeFileSync(path.join(kit, "system/SYSTEM-VERSION.json"), JSON.stringify({ version: "0.0.0", generated: "2026-10-09", tokensDigest: "test" }));
  writeFileSync(path.join(kit, "reference/Lleverage deck layouts.html"), deck);
  writeFileSync(path.join(kit, "reference/Lleverage document template.html"), doc);
  return home;
}

function newDeliverable(home: string, ...args: string[]) {
  return spawnSync("node", [path.join(scripts, "new.mjs"), ...args], { encoding: "utf8", env: { ...process.env, LLEVERAGE_PRESENTATIONS_HOME: home } });
}

describe("lleverage-presentations", () => {
  test("splits reference pages by layout and sheet, keeping head and tail intact", () => {
    const d = splitPages(deck, "deck");
    expect(d.pages.map(pageName)).toEqual(["Cover — dark", "Title only", "Close — dark"]);
    expect(d.head + d.pages.join("\n") + d.tail).toBe(deck);
    const s = splitPages(doc, "doc");
    expect(s.pages.map(pageName)).toEqual(["01 Cover", "03 Content"]);
    expect(s.tail).toBe("</body></html>");
  });

  test("new.mjs builds a deck from named layouts, adds the slide page setup and refuses to overwrite", () => {
    const home = fakeKit();
    const out = path.join(home, "q4.html");
    const first = newDeliverable(home, "--deck", out, "Cover — dark", "title only", "Title only", "Close — dark");
    expect(first.status, first.stderr).toBe(0);
    const html = readFileSync(out, "utf8");
    expect(splitPages(html, "deck").pages.map(pageName)).toEqual(["Cover — dark", "Title only", "Title only", "Close — dark"]);
    expect(html).toContain("@page{size:1280px 720px;margin:0}");

    const again = newDeliverable(home, "--deck", out);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("--force");

    const unknown = newDeliverable(home, "--deck", path.join(home, "x.html"), "Waterfall");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("no layout 'Waterfall'");
  });
});
