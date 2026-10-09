#!/usr/bin/env node
// Free music for a video, with its credit line.
//   node music.mjs list                       curated energetic tracks (Kevin MacLeod, CC BY 4.0)
//   node music.mjs fetch "<title>" <dir>       download to <dir>/music.mp3 and write <dir>/credit.txt
//   node music.mjs use <file.mp3> <dir> "<credit>"   use your own track (you are responsible for its licence)
// Incompetech tracks are free to use, including commercially, with the credit in credit.txt shown in the video
// (the end card) or its description. Never commit the audio; fetch it into the video folder.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Tempo is measured with beats.mjs; length in seconds. "shape" is what the loudness per bar shows.
const TRACKS = [
  ["Voxel Revolution", 122, 130, "Electronic. Quiet intro 0–15s, drums at 15s, peak 46s, breakdown 60–78s, second build to 123s. The default for a 2-minute recap."],
  ["Raving Energy", 122, 268, "Driving dance. Steady energy all the way; good for long montages, little contrast."],
  ["Rhinoceros", 126, 204, "Rock-electronic. Lifts at 30s and 46s; strong for a 60–90s cut."],
  ["Pixelland", 115, 234, "Chiptune, light. Dips around 66–83s; friendly rather than punchy."],
  ["Funk Game Loop", 105, 57, "Funk loop, 56s. Short teasers and single-feature clips."],
  ["Electrodoodle", 80, 166, "Playful electronic at half-time feel; a calm explainer."],
];
const url = (t) => `https://incompetech.com/music/royalty-free/mp3-royaltyfree/${encodeURIComponent(t)}.mp3`;
const credit = (t) => `Music: “${t}” by Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 4.0\nhttps://creativecommons.org/licenses/by/4.0/`;

// credit.txt for descriptions; credit.js so the end card can show it (window.CREDIT, one line per entry).
function writeCredit(dir, text) {
  writeFileSync(path.join(dir, "credit.txt"), text + "\n");
  writeFileSync(path.join(dir, "credit.js"), "window.CREDIT = " + JSON.stringify(text.split("\n").filter((l) => !l.startsWith("http"))) + ";\n");
}
const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === "list" || !cmd) {
  for (const [t, bpm, len, shape] of TRACKS) console.log(`${t.padEnd(18)} ${String(bpm).padStart(3)} BPM  ${String(len).padStart(3)}s  ${shape}`);
  console.log("\nAny other incompetech title works with fetch too (exact title as on incompetech.com).");
} else if (cmd === "fetch" && a && b) {
  mkdirSync(b, { recursive: true });
  const res = await fetch(url(a), { headers: { "user-agent": "Mozilla/5.0 beat-video" } });
  if (!res.ok) { console.error(`${a}: HTTP ${res.status} from ${url(a)}. Check the exact title on incompetech.com.`); process.exit(1); }
  writeFileSync(path.join(b, "music.mp3"), Buffer.from(await res.arrayBuffer()));
  writeCredit(b, credit(a));
  console.log(`wrote ${path.join(b, "music.mp3")}, credit.txt and credit.js\n${credit(a)}`);
} else if (cmd === "use" && a && b && c) {
  mkdirSync(b, { recursive: true });
  copyFileSync(a, path.join(b, "music.mp3"));
  writeCredit(b, c);
  console.log(`using ${a}; credit: ${c}`);
} else {
  console.error('usage: music.mjs list | fetch "<title>" <dir> | use <file> <dir> "<credit>"');
  process.exit(1);
}
