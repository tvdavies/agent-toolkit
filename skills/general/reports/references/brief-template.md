# Report brief template

The data-gathering agent writes this before authoring starts. The writer treats it as the
only source of truth, so put everything in it. Unknown values are written as `UNKNOWN`,
never guessed.

```markdown
# Brief: <working title>

## Metadata
- title:
- standfirst (draft, 1–3 sentences):
- eyebrow: <Area> · <Report type>
- date: YYYY-MM-DD
- author:
- audience:
- data window and sources:
- status: Draft | Final
- classification: Internal | Confidential (+ handling note)
- series: Technical report | Incident review | Design proposal | Evaluation | Status report
- output filename: <slug>-<YYYY-MM-DD>.html
- upload visibility: unlisted (default) | private | none (local only, user asked). The parent uploads after checking.

## Purpose
What decision or understanding this report should produce, and for whom.

## Bottom line
One or two sentences.

## Findings (priority order)
1. <Headline with number>. Evidence: <numbers with denominators, window, source>.
   Mechanism: <why>. Confidence: high/medium/low. Refs: <file:line, ticket, query>.
2. …

## Data for visuals
For each candidate chart: the point it makes, the chart type if known, and the exact data
(a markdown table or CSV). Include units, n and the window.

## Diagrams
Systems, flows or timelines worth drawing: components, the connections between them, and
the part to highlight.

## Method and limitations
Sources, sampling, judging method, known gaps and anything not verified.

## Recommendations
Priority, action, owner or area, effort, expected effect.

## Evidence index
Code references, commits, tickets, example ids and reproduction notes.

## Writer instructions
Length target, sections to emphasise or omit, things to avoid, and the existing report to
restyle (path), if there is one.
```
