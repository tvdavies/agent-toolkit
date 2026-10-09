import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Browser rendering is not exercised here (it needs Chrome and ffmpeg); these cover the scripts' file contracts
// and that the public repository never carries brand, licensed or audio files.
const root = path.resolve(import.meta.dir, "../..");
const beat = path.join(root, "skills/general/beat-video");
const ll = path.join(root, "skills/lleverage/lleverage-feature-video");
const run = (script: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync("node", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

describe("beat-video", () => {
  test("beats.mjs --silent writes a bar grid four beats apart", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bv-"));
    const r = run(path.join(beat, "scripts/beats.mjs"), [dir, "--silent", "120", "20"]);
    expect(r.status, r.stderr).toBe(0);
    const grid = JSON.parse(readFileSync(path.join(dir, "beats.json"), "utf8"));
    expect(grid.period).toBeCloseTo(0.5);
    expect(grid.bars[1] - grid.bars[0]).toBeCloseTo(2);
    expect(readFileSync(path.join(dir, "beats.js"), "utf8")).toStartWith("window.BEATS = ");
  });

  test("new.mjs copies the engine, sets the format and refuses to overwrite", () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "bv-")), "video");
    const r = run(path.join(beat, "scripts/new.mjs"), [dir, "--format", "1080x1350"]);
    expect(r.status, r.stderr).toBe(0);
    for (const f of ["index.html", "content.js", "theme.css", "mv.js", "mv.css", "kinds.js", "kinds.css", "format.json", ".gitignore", "credit.js"]) expect(readdirSync(dir)).toContain(f);
    expect(readFileSync(path.join(dir, "index.html"), "utf8")).toContain('window.FORMAT = "1080x1350"');
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toContain("music.mp3");
    const again = run(path.join(beat, "scripts/new.mjs"), [dir]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("--force");
    expect(run(path.join(beat, "scripts/new.mjs"), [dir + "2", "--format", "1081x1350"]).status).toBe(1);
  });
});

describe("lleverage-feature-video", () => {
  test("brand.mjs derives brand.css and logos from the cached kit", () => {
    const home = mkdtempSync(path.join(tmpdir(), "llfv-"));
    const kit = path.join(home, "delta-agent/plugins/delta/skills/lleverage-presentations");
    mkdirSync(path.join(kit, "system/fonts"), { recursive: true });
    mkdirSync(path.join(kit, "assets/logo"), { recursive: true });
    writeFileSync(path.join(kit, "system/SYSTEM-VERSION.json"), JSON.stringify({ version: "9.9.9", tokensDigest: "abc" }));
    writeFileSync(path.join(kit, "system/lleverage.css"), "/* x */\n:root{\n  --ll-color-paper: #F9F7F0;\n}\n.slide{}");
    writeFileSync(path.join(kit, "system/fonts/public-sans.woff2"), "");
    writeFileSync(path.join(kit, "assets/logo/logo-full-dark.svg"), "<svg/>");
    const dir = mkdtempSync(path.join(tmpdir(), "llfv-video-"));
    const r = run(path.join(ll, "scripts/brand.mjs"), [dir], { LLEVERAGE_PRESENTATIONS_HOME: home });
    expect(r.status, r.stderr).toBe(0);
    const css = readFileSync(path.join(dir, "brand.css"), "utf8");
    expect(css).toContain("--ll-color-paper: #F9F7F0;");
    expect(css).toContain("font-family:'Public Sans'");
    expect(css).not.toContain("Abhaya");
    expect(css).not.toContain(".slide");
    expect(readFileSync(path.join(dir, "brand.js"), "utf8")).toContain("logo-full-");
    expect(readdirSync(path.join(dir, "brand/logo"))).toEqual(["logo-full-dark.svg"]);
  });

  test("brand.mjs explains how to fetch a missing kit", () => {
    const r = run(path.join(ll, "scripts/brand.mjs"), [mkdtempSync(path.join(tmpdir(), "llfv-"))], { LLEVERAGE_PRESENTATIONS_HOME: path.join(tmpdir(), "nope") });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("sync.sh");
  });

  test("the skills vendor no fonts, logos, audio, images or Font Awesome Pro paths", () => {
    const files = [beat, ll].flatMap((d) => readdirSync(d, { recursive: true }).map((f) => path.join(d, String(f))));
    expect(files.filter((f) => /\.(woff2?|ttf|otf|mp3|wav|m4a|png|jpe?g|svg|gif)$/i.test(f))).toEqual([]);
    for (const f of files.filter((x) => /\.(js|mjs|css|html)$/.test(x))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/"fa[A-Z][A-Za-z]+":\s*\[\d+,\s*\d+/);
    }
  });
});
