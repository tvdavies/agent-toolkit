---
name: initiative-review-deck
description: Build the weekly review deck for a Linear initiative as a Lleverage-branded 16:9 PDF - direction, the week in numbers, progress by project and milestone, what landed, decisions, open questions, next steps and resources. Gathers the week from Linear read-only, then renders through the lleverage-presentations skill. Use for "make the initiative review deck", "weekly initiative review", "deck for Friday's review of <initiative>", or a scheduled weekly run for any Linear initiative.
---

# Initiative review deck

One fixed deck, built every week for any Linear initiative, so reviewers learn where to look and the weeks compare. The scripts do the counting and the layout; you write the words.

Depends on the `lleverage-presentations` skill (brand kit, `new.mjs`, `render.mjs`) and the `linear-cli` skill (auth). Both must be installed. Run `lleverage-presentations/scripts/sync.sh` first so the brand kit cache is current.

## The deck

| # | Slide | Comes from |
| --- | --- | --- |
| 1 | Cover: the week's headline and one-line state | `content.cover` |
| 2 | Direction: the aim, how it is measured, the dated path | `content.direction` |
| 3 | The week: four numbers and issues completed per project | `data.json`, `content.glance` |
| 4 | Projects: one bar per project, milestone status summary | `data.json`, `content.overview` |
| 5+ | Milestones: one slide per project with 3+ issues done this week | `data.json`, `content.projects` |
| | Achieved: up to four cards | `content.achieved` |
| | Decisions, open questions, next steps: one table each, up to 7 rows | `content.decisions`, `.questions`, `.next` |
| | Resources: Linear links, then your groups of plans and reports | `data.json`, `content.resources` |
| | Close: next review date | `content.close` |

Bars use ink for issues done before the week, orange for issues done this week (the slide's one orange series) and grey for open. A milestone whose issues have not started gets a dashed track.

## Workflow

Work in a scratch directory, never inside this skill.

1. **Gather** (read-only; Linear is never changed):

   ```sh
   node scripts/gather.mjs --initiative "<initiative name>" --from 2026-10-09 --to 2026-10-16 --out RUN
   ```

   `--to` is exclusive; by default it is the next Friday and `--from` is seven days earlier. It writes `RUN/data.json` (projects, milestones with counts and a derived status, issues, comments, updates, project documents and linked plans) and `RUN/digest.md`, a readable digest of the week.

2. **Research.** Read `digest.md` first. Then open what it points to: initiative and project updates, the linked plan and report documents, and the comments on issues completed or started this week. Decisions and open questions usually live in comments and documents, not in issue titles. If the brief gives Slack threads or other sources the scripts cannot reach, use them and cite them as links.

3. **Write `RUN/content.json`.** The schema, limits and writing rules are in [references/content.md](references/content.md). Every claim cites a Linear issue ID or a link. Each slide title states the finding, not the topic.

4. **Build and render:**

   ```sh
   node scripts/build.mjs RUN
   node <lleverage-presentations>/scripts/render.mjs RUN/deck.html
   ```

   `build.mjs` prints warnings for anything it dropped or worked around; act on each. `render.mjs` writes `RUN/deck.pdf`, PNGs in `RUN/deck-qa/` and a type-size conformance check.

5. **Inspect every PNG.** Look for text running into the footer rule, wrapped titles colliding with the next row, overfull cards and missing logos. Fix by shortening `content.json`, not by changing sizes. Re-render until every page is clean and conformance passes.

6. **Deliver** as the brief says, typically by uploading `deck.pdf` with the `file-upload` skill. The deck holds organisation data: upload it with `?private=1` unless the brief says otherwise.

## Derived milestone status

`gather.mjs` derives a status for each milestone from its issues; override it per milestone in `content.projects.<name>.milestones.<milestone>.status` when the sources say otherwise.

- **done**: Linear marks it done, or every live issue is done.
- **at-risk**: the target date has passed, or it is due within 10 days with under 70% of issues done.
- **in-progress**: some issue has started or is done.
- **not-started**: nothing has started.

## Reading the numbers

Teams that work in small agent-sized slices open and close many issues in the same week, so "issues completed" measures activity, not progress. `data.json` records how many of the week's completions were also created that week; say so on the glance slide when it is most of them, and lean on milestone bars for progress.

## Known issues

- The brand kit's reference layouts (kit 2.3.4) carry the logo sprite inside a `<style>` block, so logos render blank. `build.mjs` moves the sprite into `<body>` and warns; remove the workaround once the kit is fixed.
- No brand face draws arrow glyphs; `build.mjs` writes arrows in Linear names as words.
