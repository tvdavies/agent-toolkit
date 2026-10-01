# Writing the report

## Voice

- British English (organisation, behaviour, analyse) and en-GB dates ("1 October 2026",
  "17 Sep – 1 Oct").
- Write plainly and specifically, as an engineer explaining things to a respected colleague.
  Use short sentences and the active voice. Say "we" or "I" for the analysis team.
- Every claim should be checkable. Give the number, the denominator, the window and where it
  came from: "63 of 2,970 turns (2.1%), 17 Sep – 1 Oct". Do not write "very few turns".
- Separate observation from inference. Use "the data shows", "this suggests" and "we did not
  verify" where each one fits. State confidence when it is not high.
- Name the mechanism. "The deadline starts at prefetch, 1.6 s before the hook reads it" is a
  finding. "There are timing issues" is not.
- No filler or stock phrases: avoid "it's worth noting", "in today's landscape",
  "delve", "robust", "leverage", "seamless", "comprehensive", "game-changer", and
  rhetorical questions. Use no exclamation marks. If the `unslop` skill is available, apply
  it to the summary and the standfirst.
- Prefer prose to bullet lists for reasoning. Use lists for parallel items such as findings,
  recommendations and limitations.
- Name people, teams, tickets and files exactly as the brief gives them. Do not add personal
  data the brief does not need.

## Shape

Every report has this spine. Adapt the section names to the subject:

1. **Summary** (always): the bottom line, then 3–7 numbered findings in priority order, each
   starting with a bolded sentence that carries the number.
2. **Key figures** (optional): 3–4 stat tiles.
3. **Scope and method**: data sources, windows, sample sizes, how judgements were made, and
   **limitations**. Put the limitations in a `callout note`.
4. **Body sections**: one section per question the reader has, in order of importance.
   Start each one with its conclusion, then show the evidence.
5. **Recommendations**: prioritised (P0/P1/P2 or Now/Next/Later). Give each one an owner or
   area where known, an effort estimate where known, and the expected effect.
6. **Appendices**: evidence index (file:line, commits, tickets, sample session ids), extra
   tables, how to reproduce.

### By report type

| Type | Body sections | `series` |
|---|---|---|
| Assessment or investigation | Background (how it works) → Findings by theme → Efficiency or cost → Recommendations | Technical report |
| Incident review | Impact → Timeline → Root cause → Contributing factors → What went well → Actions | Incident review |
| Design proposal | Problem → Constraints → Options (`.compare`) → Proposal → Rollout → Risks → Open questions | Design proposal |
| Benchmark or evaluation | Setup → Results (charts first) → Analysis → Caveats → Recommendation | Evaluation |
| Status or progress | Where we are (stats) → Done → In progress → Risks and blockers → Next | Status report |

## Length and density

- Make the report as long as the evidence needs and no longer. The summary should fit on one
  screen.
- Each section should start with a sentence that a skimming reader can stop at.
- Move long evidence (big tables, raw lists, query text) to appendices and link to it from
  the body: `(Appendix A)`.
- When restyling an existing report, keep every substantive finding, number and
  recommendation. Remove repetition, tighten the wording, and convert the tables that make a
  visual point into charts. List anything you dropped in the handoff.

## Before you finish

- Each number in the summary appears, with the same value, in the body or a chart.
- Each figure caption states a finding. Each figure has a `.sub` line, and a source note
  where relevant.
- Limitations are stated. Unverified claims are marked as unverified.
- Recommendations are concrete enough that someone could open a ticket from each one.
- There are no `TODO`s, placeholder text or invented values.
