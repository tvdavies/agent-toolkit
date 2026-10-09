#!/usr/bin/env node
// The beat grid of a track, for pinning scenes to bars.
//   node beats.mjs <dir>                     analyse <dir>/music.mp3 → <dir>/beats.json and beats.js
//   node beats.mjs <dir> --bpm 122           force the tempo (half/double-time mistakes)
//   node beats.mjs <dir> --silent 120 90     no audio: a 120 BPM grid, 90 seconds long
// Tempo: autocorrelation of a spectral-flux onset envelope (80–160 BPM). Phase: the kick band (low-passed energy),
// which stays on the beat when hi-hats or off-beat bass dominate the full band. Downbeat: the strongest kick of four.
// Sections: loudness per bar, grouped into runs (quiet / mid / loud) with the biggest lifts marked.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ffmpeg } from "./lib/deps.mjs";

const args = process.argv.slice(2);
const dir = args[0];
if (!dir) { console.error("usage: beats.mjs <dir> [--bpm N] [--silent BPM SECONDS]"); process.exit(1); }
const opt = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : undefined; };

function write(grid) {
  writeFileSync(path.join(dir, "beats.json"), JSON.stringify(grid, null, 1));
  writeFileSync(path.join(dir, "beats.js"), "window.BEATS = " + JSON.stringify(grid) + ";\n");
}

if (args.includes("--silent")) {
  const bpm = Number(opt("--silent")), dur = Number(args[args.indexOf("--silent") + 2]);
  const period = 60 / bpm, beats = [];
  for (let t = 0.5; t < dur; t += period) beats.push(+t.toFixed(4));
  const bars = beats.filter((_, i) => i % 4 === 0);
  write({ file: null, dur, bpm, period, beats, downbeatIndex: 0, bars, loud: bars.map(() => 1), sections: [] });
  console.log(`silent grid: ${bpm} BPM, ${bars.length} bars of ${(4 * period).toFixed(3)}s`);
  process.exit(0);
}

const file = path.join(dir, "music.mp3");
if (!existsSync(file)) { console.error(`${file} not found; run music.mjs fetch first`); process.exit(1); }
const SR = 22050, HOP = 256, WIN = 1024, fps = SR / HOP;
const pcm = spawnSync(ffmpeg(), ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 30 }).stdout;
const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
const dur = x.length / SR, frames = Math.floor((x.length - WIN) / HOP);
const flux = new Float32Array(frames), kick = new Float32Array(frames), rms = new Float32Array(frames);
let prev = [0, 0, 0], prevK = 0;
for (let f = 0; f < frames; f++) {
  const o = f * HOP; let lp = 0, p1 = x[o], p2 = x[o], e = [0, 0, 0], s = 0;
  for (let i = 0; i < WIN; i++) { const v = x[o + i]; s += v * v; lp += 0.02 * (v - lp); e[0] += lp * lp; const d = v - p1; e[1] += d * d; const dd = d - (p1 - p2); e[2] += dd * dd; p2 = p1; p1 = v; }
  const l = e.map((q) => Math.log1p(1000 * q));
  flux[f] = l.reduce((a, q, i) => a + Math.max(0, q - prev[i]), 0); prev = l;
  kick[f] = Math.max(0, l[0] - prevK); prevK = l[0];
  rms[f] = Math.sqrt(s / WIN);
}
const mean = flux.reduce((a, b) => a + b, 0) / frames;
for (let i = 0; i < frames; i++) flux[i] = Math.max(0, flux[i] - mean);

let bpm = Number(opt("--bpm"));
if (!bpm) {
  let best = -1;
  for (let cand = 80; cand <= 160; cand += 0.05) {
    const lag = (60 / cand) * fps; let s = 0;
    for (let i = 0; i + 4 * lag < frames; i++) s += flux[i] * (flux[Math.round(i + lag)] + 0.5 * flux[Math.round(i + 2 * lag)] + 0.25 * flux[Math.round(i + 4 * lag)]);
    if (s > best) { best = s; bpm = cand; }
  }
}
const period = 60 / bpm;
const at = (env, t) => { const f = Math.round(t * fps); return (env[f] || 0) + 0.5 * ((env[f - 1] || 0) + (env[f + 1] || 0)); };
let phase = 0, bestP = -1;
for (let off = 0; off < period; off += 0.002) { let s = 0; for (let t = off; t < dur; t += period) s += at(kick, t); if (s > bestP) { bestP = s; phase = off; } }
const beats = []; for (let t = phase; t < dur; t += period) beats.push(+t.toFixed(4));
const acc = [0, 0, 0, 0]; beats.forEach((t, i) => (acc[i % 4] += at(kick, t)));
const downbeatIndex = acc.indexOf(Math.max(...acc));
const bars = []; for (let i = downbeatIndex; i < beats.length; i += 4) bars.push(beats[i]);
const loud = bars.map((t, i) => { const a = Math.round(t * fps), z = Math.round((bars[i + 1] ?? dur) * fps); let s = 0; for (let f = a; f < z; f++) s += rms[f] || 0; return +(s / Math.max(1, z - a)).toFixed(3); });

// Sections: runs of bars at a similar level, relative to the median of the bars with sound.
const audible = loud.filter((l) => l > 0.02).sort((a, b) => a - b), med = audible[Math.floor(audible.length / 2)] || 1;
const level = (l) => (l < 0.02 ? "silent" : l < med * 0.82 ? "quiet" : l > med * 1.1 ? "loud" : "mid");
const sections = [];
loud.forEach((l, i) => { const lv = level(l); const last = sections[sections.length - 1]; if (last && last.level === lv) last.to = i + 1; else sections.push({ level: lv, from: i, to: i + 1 }); });
// Merge one-bar blips into their neighbours, then note the biggest lifts (good places for a drop or a new chapter).
for (let i = 1; i < sections.length; i++) {
  if (sections[i].to - sections[i].from !== 1) continue;
  const prevS = sections[i - 1], next = sections[i + 1];
  if (next && next.level === prevS.level) { prevS.to = next.to; sections.splice(i, 2); } else { prevS.to = sections[i].to; sections.splice(i, 1); }
  i--;
}
const lifts = loud.map((l, i) => [i, i ? l - loud[i - 1] : 0]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([i]) => i).sort((a, b) => a - b);

write({ file: path.basename(file), dur, bpm, period, beats, downbeatIndex, bars, loud, sections, lifts });
console.log(`${bpm.toFixed(2)} BPM · beat ${period.toFixed(4)}s · bar ${(4 * period).toFixed(3)}s · first downbeat ${bars[0].toFixed(3)}s · ${bars.length} bars · ${dur.toFixed(1)}s`);
console.log("sections (bar numbers are what scenes use):");
for (const s of sections) console.log(`  bars ${String(s.from).padStart(3)}–${String(s.to).padEnd(3)} ${s.level.padEnd(6)} ${bars[s.from].toFixed(1)}s–${(bars[s.to] ?? dur).toFixed(1)}s`);
console.log(`biggest lifts at bars ${lifts.join(", ")} (${lifts.map((i) => bars[i].toFixed(1) + "s").join(", ")})`);
