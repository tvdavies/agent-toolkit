# Category presets

Starting points. Trim them to what the goal needs; 3 to 7 categories is
enough.

## UI: one screen, a flow or the whole app

- **Scorer:** judged (council), from screenshots.
- **Categories:** visual hierarchy, typography, colour and contrast, spacing
  and layout, consistency, iconography, states (empty, loading, error,
  focus), clarity of labels and copy.
- **Evidence:** a fixed screenshot set, taken the same way every round:
  - the same screens and states, with realistic data, captured whole page
  - every primary route, plus hover, open menu, focus and dialog states
  - light and dark themes
  - at least two widths
  - the in-app preview, Playwright or computer use
- **Anchors:** baseline screenshots, plus 1 to 3 products the user wants to
  beat, shown as the same kind of surface (a signed-in dashboard against a
  dashboard, not a marketing page). Ask the user for these if none are given.
- **Operator:** do your own design pass each round as well as the judges'
  findings: type scale, density, rhythm and states are system changes judges
  rarely ask for by name.
- **Guards:** no visual regressions on screens outside the scope, plus
  existing tests and type checks.
- **Target:** every member scores 9 or more in every category.

Scoped UI work uses the same categories with evidence limited to that
surface. Still include one wider screenshot so the change fits the rest of
the app.

## Performance

- **Scorer:** measured. One primary metric, such as p50 or p95 latency,
  throughput, bundle KB, memory, payload bytes or startup time.
- **Method:** the same machine and inputs, warm-up runs, then the median of
  at least 5 runs. Report the spread.
- **Guards:** tests pass and output is equivalent: the same responses, or no
  UI regressions.
- **Target:** what the user names. Otherwise propose one from the baseline,
  for example 2x faster or a quarter of the bytes.

## Evals, prompts and tool descriptions

- **Scorer:** measured. The pass count on a fixed eval set, run against each
  model that matters.
- **Second climb:** once every case passes, make that a guard, then reduce
  tokens or context size.
- **Guards:** the eval set stays fixed. Never delete or weaken cases to pass.

## Code quality

- **Scorer:** judged (council) on the diff, backed by measured signals where
  they exist: lint and type errors, complexity, lines changed, coverage.
- **Categories:** correctness risk, readability, simplicity, boundaries and
  cohesion, consistency with the codebase, value of the tests.
- **Guards:** behaviour does not change, and tests and type checks pass.
- **Target:** every member scores 9 or more. Watch for churn: a smaller diff
  that scores the same is better.
