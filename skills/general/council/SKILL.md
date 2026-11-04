---
name: council
description: Convene a read-only panel of strong models from different providers to score or review work, one round per call. Use when the user says "council" or asks for multi-model review or scores, and when the hill-climb skill needs judged scores.
metadata:
  author: tvd
  version: 2.0.0
---

# Council

A panel of strong models from different providers that scores or reviews
work. One call is one round. The council never edits anything.

To iterate until the council is satisfied, use the `hill-climb` skill with
the council as its judge.

## Panel

Use the members the user names. Otherwise take the latest flagship from each
of three providers, for example Claude Opus, GPT Sol and Gemini Pro. Resolve
real model IDs at run time. Do not hardcode them.

- **T3 Code**, including Claude Code or Codex running inside T3 Code (the
  `t3-code` tools are present): call `orchestrator_capabilities` once, then
  start one `delegate_task` per member in parallel (`role: "review"`, high
  reasoning effort). Each member is then a child thread the user can watch.
  Every round gets new delegates so no member remembers earlier rounds.
- **Elsewhere** (plain Claude Code, Codex, Pi, headless hosts such as sal):
  use the harness's native subagents pinned to each member's model. In Claude
  Code, for example, the `sol-reviewer` agent runs GPT Sol.

If a member is unreachable, say so and continue with the rest. Never swap in
a different model without saying so. A single-member round is fine when the
caller asks for one, as in hill-climb's staged rounds. A full panel needs at
least two providers. If fewer are reachable, report that and stop.

## Brief

Give every member the same self-contained brief. Delegates have no history.

- **What to judge:** the request, repo path, base and diff, screenshot paths
  or a URL, and any check results.
- **Categories:** each with a one-line meaning. Score each from 0 to 10 in
  0.5 steps, then give an overall score.
- **Anchors**, when available: the baseline and reference examples (other
  products, the previous best). Score them with the same rubric. Scores mean
  more side by side than in isolation. Judge against what is shown: don't
  name unseen products as the bar, which pins the scale.
- **What the scale means:** a 9 is work a demanding senior practitioner
  would ship with nits only; a 10 has nothing left worth changing. For every
  category under 9, ask what would make it a 10.
- **The ledger**, from round 2: earlier findings with fixed, declined (and
  why) or disputed (and the evidence), without scores. Ask members to mark
  each id resolved or still open, so declined items aren't raised blind.
- **Neutral labels:** in comparisons, call candidates A, B, C rather than
  "new" and "old".
- **Leave out the target score and earlier rounds' scores.**
- **Read-only:** no edits, commits, pushes, PR comments or subagents.

Ask for this reply:

```
SCORES
<candidate> <category>: <score> - <one-line reason>
<candidate> overall: <score>
FIXES (biggest impact first, up to 3 per category under 9)
F1 [category] <file or screen>: <problem>. Fix: <suggestion>
LEDGER
<id>: resolved | still open: <why>
```

## Collect

- Never invent a score. Write `no score` when a member gives none.
- Summarise as a table (a row per category, a column per member, then the
  minimum across members and the anchors' scores), then agreed findings,
  disagreements and recommended next steps. Treat a finding from two or more
  members as strong. Check every finding yourself before acting on it.
- Count each full pass as a round. If the work ends in a PR, put a rounds
  table in the PR description by editing it, not by posting a comment:

```markdown
## Council review

| Member | Round 1 | Round 2 |
| --- | --- | --- |
| Claude Opus | 7/10 | 9/10 |
| GPT Sol | 8/10 | 9.5/10 |
```

When categories were scored, add the final round's members × categories
table under it.
