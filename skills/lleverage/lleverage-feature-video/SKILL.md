---
name: lleverage-feature-video
description: Make a Lleverage feature or "week in review" video set to music, at any size (1080p landscape by default; 4:5, 1:1, 9:16 and 4K too), from what someone actually merged. Pulls their PRs from main, checks feature flags (app flags, service env defaults and the production overlays), rebuilds product screens from the app's real components with a component library, and lays chapters on the music's bar grid in the Lleverage brand. Use for "make a demo video of what I shipped", "a music video of this week's features", "a feature video for the business review", "a video of the new X". Builds on beat-video; not for customer-facing marketing copy or the #change-log portrait clips.
---

# Lleverage feature video

A music-synced video of real Lleverage work: chapters of rebuilt product UI under a camera, typographic scenes
between them, cut on the downbeats of a free track. It is `beat-video` (engine, music, beats, check, render) plus:

- **brand**: the design-system kit, fetched from the private cache of `lleverage-presentations` (never committed here);
- **ui/**: the product UI as HTML builders (`components.js`, `app.css`) and the `chapter` kind (`chapter.js`);
- **facts and flags**: merged PRs per author from main, and every place a feature can be gated;
- **template/**: the 2–9 October 2026 week video (Tom Davies) as the worked example.

This repository is public. Brand files, Font Awesome Pro paths, integration logos and music are fetched or generated
into the video folder at run time and git-ignored there. Never add them to the skill.

## Setup

```bash
L=<this skill>/scripts; B=<this skill>/../../general/beat-video/scripts
node $B/setup.mjs                                   # Chrome, ffmpeg, playwright-core
<this skill>/../lleverage-presentations/scripts/sync.sh   # the private brand kit, into ~/.cache
```

Needs a lleverage checkout with `node_modules` (icons, facts, flags; `LLEVERAGE_REPO`, default
`~/dev/lleverage-ai/lleverage`) and, for flags, the infrastructure checkout (`LLEVERAGE_INFRA_REPO`).

## Steps

1. **Facts.** `node $L/facts.mjs <dir> --author "<git name>" --since <date> [--others]` lists their merged PRs (one per
   squash commit) and counts per day into `facts.json`. Read the titles and group them into 4–7 user-visible stories
   plus an "under the hood" set and a rapid-fire list of small fixes. Every claim in the video traces to a PR.
2. **Flags.** For each story, `node $L/flags.mjs <term> ...` (a word from the feature or its env variable). It searches
   the app's feature flags, service env defaults (`apps/*/src/env.ts`) and the production and staging overlays on
   origin. A feature is shown as live only if it is on in production for everyone or has no flag. Otherwise leave it
   out or say "behind a flag" on screen. Work merged today may not be deployed yet; say so or check the deploy.
3. **Folder.** `node $L/new.mjs <dir> [--format 1920x1080]`: engine, kinds, the template, `ui/`, brand and icons.
4. **Music and beats.** `node $B/music.mjs fetch "Voxel Revolution" <dir>` then `node $B/beats.mjs <dir>` (see
   beat-video for choosing a track and reading the sections).
5. **Screens.** For each product chapter, get the real UI: labels, classes, icons and sizes from
   `apps/app/src/components`. Start with `references/components.md` (already mapped, with exact copy). For anything
   new, have a read-only agent (sol-scout) write a short visual spec with file paths, then add a builder to
   `ui/components.js` in the skill, not only in your folder, so the next video has it.
6. **Plan.** `content.js` holds the `PLAN`; product chapters live in `chapters.js` (`CHAPTERS.steer({ n: 1 })` etc.).
   Copy the closest chapter and change its app, camera and timing. Times are `c.b(bar, beat)` from the chapter's own
   first bar; camera scales are for the landscape stage and are fitted to every other format automatically.
   Data is illustrative (Dutch and German supplier names, SAP-style PO numbers like 4500012877, euro amounts), never a
   real customer.
7. **Icons.** `node $L/icons.mjs <dir>` after editing: it finds every `fa(...)`, quoted `"faName"`, `lu(...)` and
   `UI.integration("slug")`, and generates `icons.js` and `integrations/` from your checkout.
8. **Check, look, render.** `node $B/check.mjs <dir>` (must be clean), `node $B/stills.mjs <dir> --scenes` (look at the
   sheet), a `DRAFT=1` render of a section if motion matters, then `node $B/render.mjs <dir>`.
9. **Hand over.** Upload with the `file-upload` skill if a link is wanted (it is public). State what was not verified
   (flags you could not resolve, work not yet deployed).

## Rules

- Product UI inside a stage is rebuilt from the code: real labels, icons and sizes. Never a lookalike or invented
  screen. If a part of the real UI is unknown, leave it out and let the caption carry it (for example, sub-agent cards
  show the task, not the role, so the role goes in the caption).
- Everything around the product follows the design system: paper and midnight, orange as the one accent, Abhaya Libre
  display, Public Sans, Roboto Mono; the logo from the kit.
- Captions say what happens on screen in British English. No value claims or slogans; "voice call", never "phone
  call"; never "coworker".
- A flagged feature is never shown as generally available.
- The music credit is on the end card (the `end` kind does this from `credit.js`).
- `check.mjs` must be clean at the format you render; check each format you deliver.

## Lessons from the first video

- Rebuilt UI reads at 1080p only when zoomed in: chat chapters at camera scale 1.3–1.6 on the chat column, the canvas
  at 1.25–1.35. Full-app establishing shots are too small to read.
- Steering, sub-agent and files chapters each need four bars: one point per bar with the matching UI change on its
  downbeat. Three bars is the minimum for a two-beat interaction (click, dialog, result).
- The rapid-fire run at the track's peak (16 items, two beats each) carries the long tail of small fixes.
- Measure cursor targets after the camera moves: pass elements to `MV.cursor`, not coordinates.
