---
name: hill-climb
description: Improve something in a loop against a score until it hits a target. Works for UI (one screen or a whole app), performance, payload or token size, eval pass rates and code quality. Frames the goal, scorer, categories and target, records a baseline, then iterates and keeps only changes that raise the score. Use when the user says "hill climb" or "climb", or asks to keep iterating until a benchmark, eval or council score reaches a target.
metadata:
  author: tvd
  version: 1.0.0
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
Budget:     <max rounds, default 8>
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
same diff base. Score the anchors in the same round as the candidate.

Never edit the scorer, the eval set or the guards to raise the score. If the
scorer has a real bug, fix it, take a new baseline and say so.

## 3. Baseline

Before changing anything, score the starting point and the anchors. Start a
log at `$(git rev-parse --git-dir)/hill-climb.md`, outside the diff and
separate for each worktree. Add the card, then one line per round:
change, scores, kept or reverted. Long climbs survive context compaction by
rereading this log.

## 4. Climb

Each round:

1. Aim at the weakest category, or at the fixes judges agree on. Make the
   smallest change that could move it.
2. Run the guards. Fix or revert anything that fails.
3. Score.
4. If the score improved by more than the noise, commit; this is the new
   best. Otherwise discard this round's changes, going back to the best
   commit, and try a different idea.
5. Log the round.

For judged climbs:

- Start a new council every round, and never tell members the target.
- To save cost, run single-member council rounds with one fast member until
  it reaches the target, then bring in the rest. Only a full-panel round counts as reaching the
  target.
- Judges' scores for the anchors will drift too. Track the gap between the
  candidate and the anchors, not just the raw number.

Stay in scope. Every change must serve the goal. Log unrelated suggestions as
follow-ups.

With two goals, such as "pass every eval, then cut tokens by two-thirds",
climb the first, make it a guard, then climb the second.

## 5. Stop

- **Done:** the target is met, measured over repeat runs or by a full-panel
  round.
- **Plateau:** three rounds in a row without a kept change. Stop and report
  the best result and what is holding it back.
- **Budget spent:** stop. Running out of budget does not count as reaching
  the target.
- **Split judges:** if members disagree after two rounds, show both sides
  briefly and let the user decide.

Do not move the target mid-climb. To aim higher, start a new climb from the
best commit.

## 6. Report

Include:

- the climb card
- a table of scores by round, with the anchors
- before and after evidence: numbers, or screenshots for UI
- diff size
- what changed, and the suggestions you declined
- time and cost, if known

If a PR is in play, put the table in its description. Push or open a PR only
if the user asked.
