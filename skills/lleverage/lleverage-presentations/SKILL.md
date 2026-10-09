---
name: lleverage-presentations
description: Build Lleverage-branded presentations and documents as PDFs from a local setup, in the design system's house style (paper, midnight, one orange element, Abhaya Libre / Public Sans / Roboto Mono). Decks are 16:9 slides; documents are A4 proposals, technical responses, one-pagers, reports and business updates. Use for "make a deck/slides/presentation", "turn this into a Lleverage PDF", "put this in our house style", a QBR or quarterly business update, or any branded Lleverage deliverable. PDF only; not for PowerPoint files, emails or Slack messages.
---

# Lleverage presentations (PDF)

Every deliverable is **composed in HTML against the brand kit and printed to PDF** with headless Chrome. Two venues share one stylesheet:

- **Deck**: 16:9, `<body class="deck">`, one `<section class="slide">` per slide at 1280×720 design units (960×540 pt in the PDF). Pitches, reviews, board and business updates.
- **Document**: A4 portrait, `<body class="doc">`, one `<section class="sheet">` per page. Proposals, technical responses, one-pagers, reports.

"deck / slides / presentation" means a deck; "document / proposal / report / one-pager" means a document. If it is genuinely unclear, ask once.

This is the local, PDF-only counterpart of the `lleverage-presentations` skill in delta-agent (also published on the platform by Lennard). PowerPoint export is deliberately left out.

## The brand kit is private and cached locally

No brand material lives in this repository. `scripts/sync.sh` keeps a sparse checkout of the canonical skill in `lleverage-ai/delta-agent` under `~/.cache/lleverage-presentations/` (override with `LLEVERAGE_PRESENTATIONS_HOME`). Run it at the start of every job; it needs GitHub access to `lleverage-ai`.

```bash
S=<this skill>/scripts
$S/sync.sh            # clone or update; prints the kit version and checks it against the design system
node $S/brand.mjs info  # the path of every kit file below
```

If sync warns that the design system has moved past the kit, say so before composing: the copy is stale. Never edit anything in the cache. If a token or kit file looks wrong, report it to the design-system owner (`lleverage-ai/lleverage-design-system`); changes go there and flow down.

## Read before composing

These are the rules. This file only covers the local workflow, so where they disagree, they win.

1. **Voice**: the `voiceSkill` file (`lleverage-content-voice/SKILL.md`) and its `voiceContext`. Every word goes through it: titles, kickers, body, captions, cover and close. Before delivering, run its self-check on every title: if a competitor could say the same sentence, rewrite it.
2. **Brand identity**: `brand` (`references/brand.md`). Colour roles, faces, heads, callouts, charts, logo, icons, figures, imagery.
3. **The design owner's notes**: `readMe` and `assetsReadMe`.
4. **For a value**, such as a weight, size, colour or radius, look it up in `componentPages` (28 pages of rules; page 28 is the short version) or `tokens`. Never guess one and never type a raw hex.
5. **Slide patterns**: `exemplarsIndex` first, then open the two or three exemplars in `exemplars` whose `argument` and `evidence` fit the slide.

The reference pages are 300–450 KB. Pull out what you need with `brand.mjs` rather than reading them whole.

## Workflow: decks

1. **Plan.** Load the voice. For each slide, write down what it argues, stated as a finding ("Every order is touched twice before it is booked"), and how to show it.
2. **Start the file from the layouts.** Frames are fixed and everything between them is yours:
   ```bash
   node $S/brand.mjs layouts                  # the 40 layouts
   node $S/new.mjs --deck q4.html "Cover — dark" "Agenda" "Section divider — dark" "Title only" "Big stat" "Title only" "Close — dark"
   ```
   The cover, agenda, section dividers and close sit on their layouts. Compose every other slide on *Title only* (or *Title only — dark*); the other layouts and the exemplars are ideas, not a menu. `new.mjs` copies each chosen slide with the kit's fonts, stylesheet, logo sprite and the deck page setup, so the file is self-contained from the start.
3. **Edit the slides.** On a layout slide, change only what is inside its `data-ph` boxes. Never move, resize or delete a `data-ph` box or a `data-frame` element, and never draw your own header, cover, close or footer. On a *Title only* slide keep the header, rule, kicker and footer and compose inside the content band from the stylesheet's classes (`node $S/brand.mjs show "<layout>"` prints any layout to borrow from). Update every kicker (`/ SECTION · NN`, slash in bold orange). Render numbers the footers by position.
4. **Fill the content band.** Its height is `grid.contentBottom − grid.contentTop` in the tokens. A top-anchored stack that uses a third of it reads as bland. Anchor a closing element at the foot and give each slide a second register (a mono spec line, a strip on a rule, a caption under a diagram). At ~100 px the drawing icons carry texture a card cannot.
5. **Render and check** (below).

## Workflow: documents

1. Load the voice. `node $S/brand.mjs sheets` lists the template's pages (cover, contents, content, closing).
2. `node $S/new.mjs --doc proposal.html` copies all four; name sheets to pick or repeat them (`new.mjs --doc proposal.html "01 Cover" "03 Content" "03 Content" "04 Closing"`).
3. Compose one `<section class="sheet">` per A4 page. Keep prose tight; cards, tables and stats carry the detail. Update the running heads and the `NN / NN` footers yourself; documents are not renumbered. Remove every `.doc-note` and "to confirm" from a client-facing version.
4. Render and check.

## Icons, figures, logos and images

- Icons and figures come only from the kit. Never redraw or recolour one. `node $S/brand.mjs list` names them. In the HTML use a hook and render expands it:
  ```html
  <span class="icon s48" data-icon="forklift" data-mode="drawing"></span>   <!-- compact at 24 px and below; -on-midnight on dark -->
  <span class="figure s160" data-figure="flow"></span>                        <!-- add data-midnight on a dark surface -->
  ```
- Logos are already in the slide and page chrome. For one elsewhere, `<img src="logo/lockup-horizontal-dark.svg">` resolves from the kit (`-light` on midnight and orange).
- Photos and screenshots: relative `<img src>` paths are inlined at render. Until a real image exists, use the sand image hold with a mono label.

## Render and check

```bash
node $S/render.mjs q4.html            # writes q4.pdf, q4.final.html and q4-qa/page-NN.png
```

`render.mjs` picks the venue from `<body class>`. It expands the hooks, inlines images, numbers deck footers `5 — 12`, prints with headless Chrome (`$CHROME` or `chromium` on PATH), rasterises every PDF page and runs the kit's own `pdf-conformance-check.py` (page geometry, and every text size against the named styles and floors), using PyMuPDF via `uv`. It exits 1 if the check fails, and warns about:

- arrow glyphs in text (no brand face draws `→ ↑ ↓`; write "41 to 4" or a signed change, and draw flows with `.process .arrow`)
- a page count that differs from the slide or sheet count (something overflowed)
- `class="mk pin"`, unexpanded hooks and a missing deck page setup

Then **look at every page image**. Check:

- **Text**: nothing clipped or overflowing a card, cell or the content band; titles hold in the title zone; floors respected.
- **Colour**: one orange element per surface (the kicker slash is chrome); at most one midnight plate per slide and one or two dark surfaces per document; sand only as image hold, section break or draft note; no red or green, and paper text on dark, not white.
- **Geometry**: only the token stroke tiers; radius per role; dashed only for projected or exception paths; chrome untouched.
- **Icons and figures**: the right mode for the size and surface, and at most one icon per card.
- **Copy**: passes the voice self-check; British English (or native, informal Dutch for a Dutch client); sentence case; no leftover template copy (search for the template's sample phrases before delivering).

Typefaces cannot be checked from the PDF, because Chrome subsets all three faces into one unnamed font. Check them in the HTML. Fix, re-render and look again.

## Rules that bite in the HTML

- **Type inside an SVG is in design units, not points.** A bare `font-size="8"` lands at 6 pt, under the mono floor. Multiply every in-SVG size by 4/3 (micro `10.67`, body `16`, value `32`).
- **Two classes are called `pin`.** `.mk.pin` is a stencil push-pin and `.pin` is a numbered screenshot annotation. Annotation pins are `class="pin"` alone.
- **Hatch is an SVG `<pattern>`**, not a CSS gradient, which collapses into a wedge when Chrome prints. A hatched process step's label sits on the hatch in bold, with no plate behind it.
- **Chart bars stack and do not overlay.** Leave room above the plot for value labels.
- **Five process steps** is the limit at full width. A sixth means a second diagram.
- **Tables**: hairlines only, with no bands, vertical rules or cell radius. Past about six rows, use zebra.

## Delivering

Keep the editable `.html` next to the outputs so the deliverable can be regenerated. Hand over the `.pdf` first, plus the `.final.html` when someone wants a file that opens offline in a browser. To share by link, use the `file-upload` skill. When producing alternates, put a version in the filename.

If Chrome cannot start, say so plainly and deliver the `.final.html`, which prints to PDF from any browser. Never fake a PDF with another tool.
