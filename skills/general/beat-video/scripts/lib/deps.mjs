// Runtime dependencies for beat-video, kept out of the repository and out of video folders.
// playwright-core and ffmpeg-static live in one cache (BEAT_VIDEO_HOME, default ~/.cache/beat-video);
// setup.mjs installs them. Chrome comes from the machine: playwright-core never downloads a browser.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import path from "node:path";

export const HOME = process.env.BEAT_VIDEO_HOME || path.join(homedir(), ".cache", "beat-video");
export const PACKAGES = ["playwright-core@1.57.0", "ffmpeg-static@5.2.0", "ffprobe-static@3.1.0"];
const req = createRequire(path.join(HOME, "package.json"));

export function load(name) {
  try { return req(name); } catch {
    console.error(`${name} is not installed in ${HOME}. Run: node <beat-video>/scripts/setup.mjs`);
    process.exit(2);
  }
}

const which = (cmd) => { const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };

// Chrome: $CHROME, a system Chromium or Chrome, or any browser already in the Playwright cache.
export function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const c of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) { const p = which(c); if (p) return p; }
  if (platform() === "darwin") for (const p of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]) if (existsSync(p)) return p;
  const cache = path.join(homedir(), platform() === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  if (existsSync(cache)) for (const d of readdirSync(cache).sort().reverse()) {
    for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-headless-shell-linux64/chrome-headless-shell"]) { const p = path.join(cache, d, rel); if (existsSync(p)) return p; }
  }
  return null;
}

// ffmpeg: $FFMPEG, a system ffmpeg with libx264, else the static build from the cache.
export function ffmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const sys = which("ffmpeg");
  if (sys) { try { if (execFileSync(sys, ["-hide_banner", "-encoders"], { encoding: "utf8" }).includes("libx264")) return sys; } catch {} }
  try { return req("ffmpeg-static"); } catch { return null; }
}
export function ffprobe() {
  if (process.env.FFPROBE) return process.env.FFPROBE;
  return which("ffprobe") || (() => { try { return req("ffprobe-static").path; } catch { return null; } })();
}

export async function browser() {
  const { chromium } = load("playwright-core");
  const exe = chrome();
  if (!exe) { console.error("No Chrome or Chromium found. Install one or set CHROME=/path/to/chrome."); process.exit(2); }
  return chromium.launch({ executablePath: exe, args: ["--font-render-hinting=none", "--disable-gpu-vsync", "--autoplay-policy=no-user-gesture-required"] });
}

// The frame size of a video folder: ?w=&h= on the page, from FORMAT (e.g. 1920x1080, 1080x1350) or format.json.
export function format(dir) {
  const file = path.join(dir, "format.json");
  const raw = process.env.FORMAT || (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).size : "1920x1080");
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(raw).trim());
  if (!m) throw new Error(`format ${raw}: expected <width>x<height>`);
  const w = +m[1], h = +m[2];
  if (w % 2 || h % 2) throw new Error(`format ${raw}: H.264 needs even sizes`);
  return { w, h };
}
