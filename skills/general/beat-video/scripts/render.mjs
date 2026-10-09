#!/usr/bin/env node
// Render a video folder to MP4: frames in parallel pages, encoded once per part, joined without re-encoding,
// then the music mixed in (faded at the end) and the cover embedded as the thumbnail.
//   node render.mjs <dir> [out.mp4]            default <dir>/out/<folder>.mp4
// Env: FPS (60), WORKERS (cores/2, max 8), CRF (16), FROM/UNTIL (seconds, partial render), FADE (3 s),
//      POSTER (second for the thumbnail, default 0: the cover), DRAFT=1 (30 fps, CRF 24, fast preset).
// Writes <out>.png beside the video (the thumbnail). A 2-minute 1080p60 video takes about 9 minutes on 8 workers.
import { spawn } from "node:child_process";
import { cpus, tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { browser, ffmpeg } from "./lib/deps.mjs";
import { openVideo } from "./lib/page.mjs";

const dir = path.resolve(process.argv[2] || ".");
const out = path.resolve(process.argv[3] || path.join(dir, "out", path.basename(dir) + ".mp4"));
const draft = process.env.DRAFT === "1";
const FPS = Number(process.env.FPS) || (draft ? 30 : 60), CRF = process.env.CRF || (draft ? "24" : "16"), PRESET = draft ? "veryfast" : "medium";
const WORKERS = Number(process.env.WORKERS) || Math.max(1, Math.min(8, Math.floor(cpus().length / 2)));
const FF = ffmpeg();
const audio = path.join(dir, "music.mp3");
mkdirSync(path.dirname(out), { recursive: true });

const run = (args) => new Promise((ok, fail) => spawn(FF, ["-y", "-loglevel", "error", ...args], { stdio: "inherit" }).on("close", (c) => (c ? fail(new Error("ffmpeg failed: " + args.join(" "))) : ok())));
const b = await browser();
const probe = await openVideo(dir, { b });
const END = await probe.page.evaluate(() => window.DURATION);
const { w, h } = probe;
const poster = await (async () => { await probe.page.evaluate((t) => window.seek(t), Number(process.env.POSTER) || 0); return probe.page.screenshot({ type: "png" }); })();
await probe.page.close();
if (probe.errors.length) console.warn("page errors:\n  " + probe.errors.join("\n  "));

const FROM = Number(process.env.FROM) || 0, UNTIL = Math.min(Number(process.env.UNTIL) || END, END);
const f0 = Math.round(FROM * FPS), f1 = Math.round(UNTIL * FPS), total = f1 - f0;
// Parts live in a temporary directory with a safe name: the concat list never has to quote a user's path.
const tmp = mkdtempSync(path.join(tmpdir(), "beat-video-"));
console.log(`${w}x${h} @ ${FPS} fps, ${(total / FPS).toFixed(1)}s, ${total} frames on ${WORKERS} workers`);

let done = 0, last = Date.now();
const started = Date.now();
async function worker(i, a, z) {
  const { page } = await openVideo(dir, { b });
  const file = path.join(tmp, `part-${String(i).padStart(2, "0")}.mp4`);
  const ff = spawn(FF, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", CRF, "-preset", PRESET, "-r", String(FPS), file], { stdio: ["pipe", "inherit", "inherit"] });
  for (let f = a; f < z; f++) {
    let shot;
    for (let attempt = 0; !shot; attempt++) {
      try { await page.evaluate((t) => window.seek(t), f / FPS); shot = await page.screenshot({ type: "jpeg", quality: 95, timeout: 15000 }); }
      catch (e) { if (attempt >= 3) throw e; console.warn(`frame ${f} retry: ${e.message.split("\n")[0]}`); }
    }
    if (!ff.stdin.write(shot)) await new Promise((r) => ff.stdin.once("drain", r));
    done++;
    if (Date.now() - last > 20000) { last = Date.now(); const rate = done / ((Date.now() - started) / 1000); console.log(`${done}/${total} frames, ~${Math.round((total - done) / rate)}s left`); }
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  await page.close();
  return file;
}
const per = Math.ceil(total / WORKERS);
const parts = (await Promise.all(Array.from({ length: WORKERS }, (_, i) => [f0 + i * per, Math.min(f1, f0 + (i + 1) * per)])
  .filter(([a, z]) => z > a).map(([a, z], i) => worker(i, a, z))));
await b.close();

const list = path.join(tmp, "list.txt");
// Part names are ours (part-NN.mp4) and relative to the list, so no path needs quoting.
writeFileSync(list, parts.map((f) => `file '${path.basename(f)}'`).join("\n"));
const thumb = out.replace(/\.mp4$/, ".png");
writeFileSync(thumb, poster);
const dur = total / FPS, fade = Number(process.env.FADE ?? 3);
const joined = path.join(tmp, "joined.mp4");
if (existsSync(audio)) {
  const af = [`atrim=${FROM}:${FROM + dur}`, "asetpts=PTS-STARTPTS"];
  if (UNTIL >= END - 0.01 && fade > 0) af.push(`afade=t=out:st=${Math.max(0, dur - fade)}:d=${fade}`);
  await run(["-f", "concat", "-safe", "0", "-i", list, "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", af.join(","), "-c:a", "aac", "-b:a", "256k", "-shortest", joined]);
} else await run(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
// The cover as embedded artwork: players and Slack use it as the preview.
await run(["-i", joined, "-i", thumb, "-map", "0", "-map", "1", "-c", "copy", "-c:v:1", "png", "-disposition:v:1", "attached_pic", "-movflags", "+faststart", out]);
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${out} (${dur.toFixed(1)}s, ${w}x${h}@${FPS}) and ${thumb} in ${Math.round((Date.now() - started) / 1000)}s`);
