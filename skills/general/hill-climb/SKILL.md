---
name: hill-climb
description: Improve something in a loop against a score until it hits a target. Works for UI (one screen or a whole app), performance, payload or token size, eval pass rates and code quality. Frames the goal, scorer, categories and target, records a baseline, then iterates and keeps only changes that raise the score. Use when the user says "hill climb" or "climb", or asks to keep iterating until a benchmark, eval or council score reaches a target.
metadata:
  author: tvd
  version: 2.0.0
---

# Hill climb

Turn the problem into a score, then make the score go up. Keep a change only
if it raises the score without breaking anything else.

## 1. Frame the climb

Read the request and the code, then write the climb card:

```
Goal:       <one sentence: the outcome the user wants>
Scope:      <paths, screens or flows in scope; what is out>
Scorer:     measured (a command prints the score) | judged (council);
            say whether higher or lower is better
Categories: <3-7, each with how it is scored>
Target:     <e.g. every member >= 9 in every category, or p95 <= 120 ms>
Guards:     <what must not regress: tests, types, other screens, behaviour>
Anchors:    <baseline, plus references to score against>
Budget:     <max rounds or hours: default 8 measured, 30 judged>
Holdout:    <judged only: 2-3 screens or cases no judge sees until the end>
```

Prefer a measured scorer. Use a judged one only when no program can score
the goal, as with look and feel or readability. For default categories and
anchors by problem type, see [references/categories.md](references/categories.md).

Post the card and start. Ask first only when the goal or scope is unclear or
a needed anchor is missing, such as reference screenshots the user should
supply.

## 2. Isolate, then build the scorer

Move to a dedicated branch or worktree first (see the `worktrees` skill).
Commit the starting state there, including any uncommitted work the climb
builds on. That commit is the baseline and the first best commit. Run all
scoring and logging from this checkout.

**Measured:** find or write one command that prints the score. Fix its
inputs, warm it up and take the median of several runs. Run it twice on the
baseline. If the noise is bigger than the gain you hope for, fix the scorer
before climbing.

**Judged:** use the `council` skill. Fix the evidence so every round sees the
same things: the same screens, states, themes, viewports and data, or the
same diff base. Score the anchors in the same round as the candidate. For UI,
capture whole pages, not just the first viewport, and cover every primary
route and its states.

Anchors calibrate the judges; they are not the goal unless the user makes
parity the goal. When the goal is an absolute bar ("the best UX we can
make"), say in the brief what 9 and 10 mean in words and score the frozen
baseline as the control instead of a competitor. When anchors are used, use
the same kind of surface (a competitor's signed-in app, not its marketing
page), and replace an anchor the candidate beats early: it stops pulling.

Measure a judge's noise before trusting it: score the baseline twice with
each judge. If a category moves by 0.5 or more between the two, use the mean
of two samples per judge in every round.

Never edit the scorer, the eval set or the guards to raise the score. If the
scorer has a real bug, fix it, take a new baseline and say so.

## 3. Baseline

Before changing anything, score the starting point and the anchors. Start a
log at `$(git rev-parse --git-dir)/hill-climb.md`, outside the diff and
separate for each worktree. Add the card, then each round's change, scores,
kept or reverted, and the ledger. Long climbs survive context compaction by
rereading this log.

For judged climbs, keep a **ledger** of every finding: an id, the finding,
and fixed, declined (with why) or disputed (with evidence). Judges get the
ledger each round, never the scores.

## 4. Climb

Each round:

1. Choose the change.
   - **Measured:** aim at the weakest category. Make the smallest change that
     could move it.
   - **Judged:** start with your own pass, as the senior practitioner the goal
     needs (a designer for UI): what would you change? Then take every judge
     finding you agree with, and update the ledger. Make it all as one batch,
     sized to the gap: a system change such as a type scale, a density pass or
     a layout rework is fine when the score is stuck. Don't wait for a judge to
     ask for what you can see is wrong.
2. Run the guards. Fix or revert anything that fails.
3. Score.
4. Keep or revert.
   - **Measured:** if the score improved by more than the noise, commit; this
     is the new best. Otherwise go back to the best commit and try another idea.
   - **Judged:** commit unless a category falls by more than the noise across
     judges. Then re-score once before reverting; revert only what caused the
     fall. A round that scores flat but fixes ledger items is kept: judges
     move in 0.5 steps, and small fixes add up over rounds.
5. Log the round and **post it to the user**: a table with a row per category
   and a column per judge for the candidate, the minimum across judges, the
   change since the best round, and each judge's anchor scores. Add a line on
   what changed and the ledger counts (fixed, declined, disputed).

For judged climbs:

- Start a new council every round, and never tell members the target or the
  earlier scores.
- Run the full panel every round for UI and other taste-heavy goals; single
  judges stick. Elsewhere, a single fast member may run until it reaches the
  target, then the rest join. Only a full-panel round counts as reaching the
  target.
- Judges' scores for the anchors will drift too. Track the gap between the
  candidate and the anchors, not just the raw number. Each round, also score
  a frozen control (the baseline) blind: if its score rises, the judges are
  inflating.

Stay in scope. Every change must serve the goal. Log unrelated suggestions as
follow-ups.

With two goals, such as "pass every eval, then cut tokens by two-thirds",
climb the first, make it a guard, then climb the second.

## 5. Stop

- **Done:** the target is met, measured over repeat runs or by a full-panel
  round.
- **Plateau:** three rounds in a row without a kept change (measured), or
  (judged) three rounds where every judge's lowest category stays flat and no
  ledger item resolves. Before stopping a judged climb, change approach once:
  your own design pass, a bigger batch or a stronger anchor. Then stop and
  report the best result and what is holding it back.
- **Budget spent:** stop. Running out of budget does not count as reaching
  the target.
- **Split judges:** if members disagree after two rounds, show both sides
  briefly and let the user decide.

Do not move the target mid-climb. To aim higher, start a new climb from the
best commit.

At the end of a judged climb, show the holdout screens to the judges. A
holdout that scores well below the climbed screens means the climb fitted the
evidence, not the product.

## 6. Report

Include:

- the climb card
- the per-round tables, and a trajectory table: a row per round, each
  judge's lowest category, the candidate's overall and the anchors'
- before and after evidence: numbers, or screenshots for UI
- diff size
- what changed, and the suggestions you declined
- time and cost, if known

If a PR is in play, put the table in its description. Push or open a PR only
if the user asked.
