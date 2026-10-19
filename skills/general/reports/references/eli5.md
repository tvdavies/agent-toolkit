# ELI5 explainers (`layout: eli5`)

An explainer is a page that makes a newcomer say "oh, I get it" in about two minutes. The
pictures carry the explanation; the words only name what the picture shows. **Simplify the
explanation, not the vocabulary**: the reader should come away able to follow the real
conversation, so the explainer uses the source's own terms (Process, Step, Case, task) and
teaches them, rather than swapping them for stand-ins they would have to translate back. It uses the same
build, palette, fonts, masthead, render check, card and upload as a report, drawn chunkier:
thick ink outlines, rounded panels with a hard shadow, big serif headlines, one petrol element
per picture. The method is adapted from Badr's `eli5` skill (`lleverage-ai/plugins-internal`,
`plugins/product-dev/skills/eli5`), restyled to the unbranded house style.

Unlike Badr's original, which bans jargon from the pictures, this mode keeps the source's
terminology throughout: too much simplification makes the explainer abstract and leaves the
reader unable to map it back to the real thing.

Use it alongside a full report (the report for people who need the evidence, the explainer for
everyone else) or on its own for a feature, system, decision or outside concept.

## Shape

```html
---
layout: eli5
title: One-off processes, explained
eyebrow: Operate & Expand · Explainer
date: 2026-10-16
author: Tom Davies (explainer drawn with Claude)
audience: Anyone new to the Process work
---

<p class="answer">One sentence, at most 15 words, that answers "what is it?"</p>

<section class="panel">
  <h2>A factual headline of at most 10 words</h2>
  <figure class="panel-figure">
    <svg viewBox="0 0 800 380" role="img" aria-label="What the drawing shows">…</svg>
  </figure>
  <p class="caption">Optional, at most 20 words.</p>
  <details class="detail"><summary>Detailed</summary><p>40–90 words of mechanics.</p></details>
</section>

<!-- more panels -->

<p class="recap">The whole idea in a sentence the reader could repeat to someone else.</p>
```

The build numbers panels, hides the contents list and standfirst, adds a script-free "Show all
details" switch, and puts each Detailed note in a side column from 1040 px wide (below the
caption on narrower screens). The default `series` is "Explainer". The answer is used as the
link-preview text, so the card shows it. There is no `.summary` or `.stats` block.

The build warns when the answer, a headline, a panel (figure labels included, Detailed note
excluded) or a Detailed note is outside the limits, when a panel has no inline `<svg>` or no
`aria-label`, and when a headline ends in `?` or `!`. Fix every warning.

## Steps

1. **Read the source first.** Explain from the code, the report, the ticket or the transcript,
   never from a guess. If you also wrote a full report, the explainer must agree with it.
2. **Write the 15-word answer before anything else.** If you cannot, read more.
3. **List the terms the reader needs** from the source, in the order they appear, and give
   each one a panel where it is first drawn and named. Use the source's spelling and
   capitalisation. A simple drawing for a term (a folder for a Case, a box for a Step) is fine;
   an everyday analogy is optional, only supports a term, and never replaces its name.
4. **Storyboard in text.** Per panel: the headline and what the drawing shows. The first panel
   is the simplest true version; each next panel adds one piece until the last shows the whole
   thing. Read only the headlines in order: they must tell the story on their own. Write each
   Detailed note with its panel.
5. **Draw** with the classes below. Big, simple, flat, few shapes. Show change as before and
   after side by side, never as a paragraph. A small generator script (Python or Node) with
   helpers for people, folders, boxes and arrows keeps panels consistent; keep it in the work
   directory, not in the report.
6. **Build, render-check, look.** Look at every desktop tile and the phone tiles. Also check one
   copy with the switch on: `sed 's/class="eli5-all">/class="eli5-all" checked>/'` the built file
   into a scratch copy and render-check that. Every label must be readable at phone width.
7. **Card and upload** exactly as for a report (SKILL.md step 6).

## Rules

- **As many panels as the material needs, and no more.** A small idea is three panels; a system
  with many parts can be ten. Never drop a part that matters to keep the page short; give it its
  own panel later in the build-up.
- **Factual headlines.** "One Case moves from Step to Step", not "Meet your new workflow
  hero". No slogans, puns, teasers, questions or exclamation marks anywhere.
- **Pictures first.** If a panel only works with its caption, redraw it.
- **Keep the source's terminology.** Headlines, captions and figure labels use the real terms
  ("One Case moves from Step to Step", not "One folder moves from desk to desk"). Introduce
  each term in the panel where it is first drawn, in plain words, then keep using it. Leave out
  terms the story doesn't need rather than renaming them. Avoid only acronyms and internal
  shorthand the source itself doesn't define.
- **Detailed notes go one level deeper**: how the term works (fields, rules, what happens
  in what order), not a translation of the panel into real terms.
- **Detailed notes explain the panel's idea only, from the source**: the mechanics, fields,
  rules and why it works that way. No ticket, PR or commit numbers; it is still an explainer,
  not a status report.
- **Concrete over abstract.** "Bob connects Gmail" beats "a stakeholder connects a system".
  A metaphor that needs decoding is abstract too.
  Mark examples as examples.
- **Nothing made up.** Numbers and claims come from the source.
- **One petrol element per panel**: the thing that matters. Everything else is ink, white,
  paper or grey.

## Drawing classes

Use these classes on SVG shapes. Do not put colours, `style` or `<style>` in the SVG.

| Class | Draws |
|---|---|
| `d-ink` | Outline only (lines, arrows, ticks) |
| `d-box` / `d-paper` / `d-soft` | White, paper or grey fill with an ink outline |
| `d-ghost` | Dotted grey outline for something absent, removed or pending |
| `d-accent` | Petrol fill, ink outline: the one thing that matters |
| `d-accent-soft` / `d-accent-line` | Pale petrol fill with petrol outline / thick petrol line |
| `d-good` / `d-warn` / `d-bad` | Pale status fill with matching outline |
| `d-fill-ink` / `d-fill-accent` / `d-fill-good` / `d-fill-bad` / `d-fill-muted` | Solid fill, no outline (dots, eyes, bars) |
| `d-dash` / `d-thin` | Modifiers: dotted stroke / 3 px stroke |
| `d-text` | 28 px sans text for names and short phrases |
| `d-big` | 64 px serif for a single mark or number |
| `d-label` | 20 px uppercase mono label |
| `d-on-accent` / `d-on-dark` / `d-accent-text` | Text colour on petrol / on ink / in petrol |

Draw on an 800 × 380 `viewBox` (or similar landscape size). Text at these sizes stays
readable at phone width; do not go smaller. Keep labels to two or three words.
