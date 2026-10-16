# content.json

`build.mjs` reads `RUN/content.json` beside `RUN/data.json`. Every key is optional: a missing section falls back to Linear data or is left out with a warning. The words are yours; the numbers come from `data.json`.

## Writing rules

- **Titles state the finding**, not the topic: "Wait groups landed; the inbox has a week to make M2", not "Durable Handoffs milestones". One line where possible, two at most.
- **Every claim has a source.** A source ("ref") is an issue ID such as `"LLE-123"` (linked to the issue), a URL, or `{ "label": "...", "url": "..." }`. Plain text without a link is flagged as `unlinked source`.
- **Short.** Card points under about 90 characters; table details one line. If a page overflows, cut words; never shrink type.
- `**bold**` is the only inline markup. Arrows in text are written as words.
- British English, plain words, names as people use them.

## Schema

```jsonc
{
  "weekLabel": "9 – 15 Oct",                 // default: from data.window
  "cover": {
    "kicker": "Initiative · initiative review · 16 October 2026",
    "title": "The week's headline.",         // keep to one line at 128px: ~30 characters
    "titleAccent": "The open risk, in orange.",
    "subtitle": "One or two sentences of state.",
    "cells": [["Prepared for", "..."], ["Owners", "..."], ["Week", "..."], ["Status", "..."]]  // up to 4
  },
  "direction": {
    "title": "...",
    "aim": "The initiative's aim in two to four lines.",
    "measures": ["**KPI one**", "**KPI two**", "A note on baselines"],
    "roadmap": [ { "when": "12 Oct · done", "label": "Short name", "detail": "One sentence.", "now": true } ],  // up to 5; "now" marks the current one in orange
    "roadmapTop": 400,                       // px; raise if measures run long
    "sources": [ref, ...]
  },
  "glance": {
    "title": "...",
    "stats": [["139", "issues completed"], ...],   // default: completed, started, decisions, milestones at risk
    "note": "How to read the numbers.",
    "noteTop": 548,
    "sources": [ref, ...]
  },
  "overview": { "title": "...", "sources": [ref, ...] },
  "projects": {
    "<project name>": {
      "order": 1,                            // slide order; default by issues done this week
      "hide": false,                         // drop from every slide
      "slide": true,                         // force (true) or suppress (false) its milestone slide
      "title": "Finding for its milestone slide",
      "milestones": { "<milestone name>": { "status": "at-risk" } },  // done | in-progress | at-risk | not-started
      "sources": [ref, ...]
    }
  },
  "achieved": {
    "title": "...",
    "cards": [ { "kicker": "Project", "title": "What landed", "points": ["...", "..."], "sources": [ref, ...] } ]
    // up to 4 cards; 2 points each with 3-4 cards, up to 5 with 1-2 cards
  },
  "decisionsTitle": "...",
  "decisions": [ { "what": "The decision.", "detail": "Why or what it rules out.", "who": "Name · 12 Oct", "sources": [ref] } ],
  "questionsTitle": "...",
  "questions": [ { "what": "The question?", "detail": "Context.", "who": "Who decides", "sources": [ref] } ],
  "nextTitle": "...",
  "next": [ { "what": "The step.", "who": "Owner", "when": "23 Oct", "sources": [ref] } ],
  // tables hold up to 7 rows each
  "resources": {
    "title": "...",
    "groups": [ { "name": "Plans and decisions", "links": [ { "label": "...", "url": "...", "note": "Author · date · where" } ] } ]
    // up to 2 groups beside the generated Linear column; about 6 links each
  },
  "close": { "title": "Next review: Friday 23 October", "line1": "...", "line2": "..." }
}
```

## Where the content usually is

- **Decisions**: issue comments ("we decided", "going with"), project documents and plan revisions, closed spike issues, project updates.
- **Open questions**: unanswered questions in comments, "open questions" sections of plans, issues in triage or unassigned.
- **Next steps**: milestones due soon, issues started this week, the next section of the plan.
- **Achieved**: completed issues grouped by what a person can now do, not by ticket.
