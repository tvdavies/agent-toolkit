---
name: beat-video
description: Make a music-synced video from HTML, unbranded and at any size (1920×1080, 4K, 4:5, 1:1, 9:16). Fetches free music (CC BY) with its credit, finds the track's tempo, bars and sections, pins scenes to bars (cover, counters, big words, lists, stats, rapid-fire, tiles, end card, or custom HTML), checks layout automatically and renders to MP4 in parallel with the music mixed in and a cover thumbnail. Use for "make a video set to music", "a recap or release video with a beat", "sync transitions to music", or as the engine behind a branded video skill. Also renders silent videos on a tempo grid.
---

# Beat video

A video is a folder with an `index.html` whose every frame is a function of song time. Scenes are laid end to end on
the track's **bar grid**, so every cut lands on a downbeat and text lands on beats. Chrome renders frames in parallel;
ffmpeg encodes each part once, joins them without re-encoding, mixes in the music and embeds the cover as the thumbnail.

A brand layer builds on this (for Lleverage: `lleverage-feature-video`). On its own it is neutral: override the
`--mv-*` properties in `theme.css`.

## Setup (once per machine)

```bash
B=<this skill>/scripts
node $B/setup.mjs        # installs playwright-core + ffmpeg-static into ~/.cache/beat-video; finds Chrome
```

It never downloads a browser: it uses `$CHROME`, a system Chromium or Chrome, or one already in the Playwright cache.
Exit 1 means something is missing; it says what.

## Steps

1. **Folder.** `node $B/new.mjs <dir> --format 1920x1080` (any even `WxH`; layouts adapt to landscape, square and tall).
2. **Music.** `node $B/music.mjs list` shows curated energetic tracks with tempo, length and shape.
   `node $B/music.mjs fetch "Voxel Revolution" <dir>` downloads `music.mp3` and writes `credit.txt` and `credit.js`;
   the `end` kind shows the credit. Your own track: `music.mjs use <file> <dir> "<credit>"` (you own its licence).
   Never commit audio.
3. **Beats.** `node $B/beats.mjs <dir>` writes `beats.json`/`beats.js` and prints the tempo, the sections (quiet /
   mid / loud runs of bars) and the biggest lifts. Wrong tempo (half or double time)? `--bpm N`. No music:
   `--silent 120 90` makes a 120 BPM grid 90 seconds long.
4. **Plan.** Edit `content.js`: a `PLAN` of scene kinds, each `bars` long, laid end to end from 0 s. Fit it to the
   sections: cover and words over the quiet intro, the main run from the first big lift, `statements` for a breakdown,
   and the `end` card as the track fades (`window.END` = the length you want). Kinds and their options:
   `references/kinds.md`. A scene needing its own HTML is a `custom` item.
5. **Check.** `node $B/check.mjs <dir>` must print `no errors`. It catches page errors, missing files, fonts that fall
   back, gaps or double scenes on the timeline, text outside the frame and overlapping text blocks, sampling every scene.
   Fix the cause; do not mark things `data-qa-ignore` to pass.
6. **Look.** `node $B/stills.mjs <dir> --scenes` (one still per scene near its end, plus `check/sheet.png`) or at given
   times or `--bars`. Look at the sheet; fix and repeat. Preview with sound: open `<dir>/index.html` in a browser and
   click (space pauses, ←/→ move a bar, `?t=60` starts there, `?debug` shows bar and beat).
7. **Render.** `node $B/render.mjs <dir>` → `<dir>/out/<dir>.mp4` and its thumbnail `.png`. A 2-minute 1080p60
   video takes ~9 minutes on 8 workers. Drafts: `DRAFT=1` (30 fps, fast) and `FROM`/`UNTIL` for a section.
8. **Verify** the file: size, fps, length, audio, and the embedded cover (`attached_pic`); look at a few frames.

## Timing rules

- Everything is a function of `t`: no CSS animations, timers or transitions. Helpers in `mv.js`: `show`, `slam`, `pop`,
  `type`, `count`, `camera`, `cursor`, `pulse`; times from `MV.bar(i)` and `MV.b(bar, beat)` (fractions allowed).
- One idea per bar. A caption or point lands on a downbeat; motion inside it lands on beats.
- Reading time comes from bars, not slower motion. If a scene reads too fast, give it more bars.
- The first frame is the cover and the thumbnail. It must be complete at 0 s, never black.
- Transitions are per item: `wipe` (default), `flash` or `cut` (the first item always cuts).

## Files in a video folder

| File | What |
| --- | --- |
| `index.html` | Loads styles, `beats.js`, `credit.js`, the engine, kinds, `content.js`; runs `MV.plan(PLAN); MV.run()` |
| `content.js` | The plan (edit this) |
| `theme.css` | Your colours and faces (`--mv-*`) |
| `mv.js`, `mv.css`, `kinds.js`, `kinds.css` | Engine and kinds, copied fresh by `new.mjs`; do not edit in the folder, change the skill |
| `format.json` | The size; `FORMAT=WxH` overrides it for any script |
| `music.mp3`, `credit.*`, `beats.*` | From steps 2 and 3 |
| `check/`, `out/` | Stills and renders (git-ignored) |
