---
name: deslop
description: Find and optionally fix accidental complexity, maintainability cruft, duplicated logic, needless wrappers, dead code, and low-risk performance issues before PR review. Use when the user asks to deslop, simplify, clean up a branch, run a preflight cleanup pass, find code slop, improve code before review, or run clawpatch deslopify. Uses clawpatch internally when useful, but does not replace final PR review.
metadata:
  author: tvd
  version: 1.0.0
---

# Deslop

Use this skill for **authoring-time cleanup** and **pre-review simplification**. The goal is to find and optionally fix code slop before final PR review.

This skill may use `clawpatch` internally, especially `--mode deslopify`, but the user-facing task is desloping, not operating clawpatch directly.

## Scope

Look for issues such as:

- duplicated logic or boilerplate that can be consolidated
- dead or unreachable code
- needless wrappers, pass-through helpers, and shadow modules
- over-abstracted code that obscures simple behaviour
- cargo-cult defensive code that does not match a real trust boundary
- repeated work or local performance waste
- brittle tests coupled to implementation details
- type/build/lint band-aids such as broad `any`, ignores, sleeps, fake success paths, or removed checks
- production-included debug/demo/test artefacts

Avoid treating these as slop by default:

- normal framework boilerplate
- intentionally explicit domain code
- generated files
- large files solely because they are large
- style preferences without maintainability impact
- changes outside the branch/diff unless the user asks for broader cleanup

## Relationship to Other Skills

- `deslop` is for local cleanup before review.
- `pr-review` remains the final PR judgement path for correctness, ticket compliance, CI, security, and GitHub review output.
- `clawpatch` is a tool this skill can use, not the primary user-facing concept.

Do not invoke final `pr-review` unless the user asks.

## Safety Rules

- Start read-only unless the user explicitly asks to fix.
- Before edits, inspect `git status --short` and avoid touching unrelated changes.
- Prefer small, targeted changes.
- Do not commit, push, open PRs, or run `clawpatch open-pr` unless explicitly asked.
- Do not commit `.clawpatch/` state.
- Treat clawpatch findings as suggestions requiring judgement, not blockers.

## Default Workflow: Find Slop

Use this when the user asks to deslop/check/clean up without explicitly asking for automatic fixes.

1. Check branch and dirty state:

```bash
git status --short
git branch --show-current
```

2. Detect base branch:

```bash
git remote show origin | grep 'HEAD branch' | awk '{print $NF}'
```

Fallback to `main`.

3. Fetch base:

```bash
git fetch origin BASE_BRANCH
```

4. Inspect the diff yourself first:

```bash
git diff origin/BASE_BRANCH...HEAD --stat
git diff origin/BASE_BRANCH...HEAD --name-only
git diff origin/BASE_BRANCH...HEAD
```

5. If clawpatch is available and initialized, run a focused deslop pass:

```bash
clawpatch review --mode deslopify --since origin/BASE_BRANCH --provider pi --limit 20
clawpatch report --status open
```

If clawpatch is unavailable or not initialized, continue with manual inspection. Ask before running `clawpatch init` or `clawpatch map`.

6. Summarise findings in three groups:

- **Worth fixing** — low-risk cleanup with clear benefit
- **Maybe** — needs product/domain judgement or could be subjective
- **Ignore** — likely false positive or not worth churn

For each finding, include:

- file/path
- short issue description
- why it matters
- suggested fix
- whether clawpatch or manual inspection found it

Ask before applying fixes unless the user clearly asked to fix them.

## Fix Workflow

Use when the user asks to fix/deslop rather than only inspect.

1. Confirm intended scope if ambiguous.
2. Check dirty state:

```bash
git status --short
```

3. Apply small targeted edits manually where straightforward.
4. For a specific clawpatch finding, you may use:

```bash
clawpatch show --finding FINDING_ID
clawpatch fix --finding FINDING_ID --provider pi
```

Only use `clawpatch fix` for a specific finding, and only after the user has asked for fixes.

5. Run relevant validation. Prefer targeted commands first, then broader checks if appropriate:

```bash
pnpm type-check
pnpm lint
pnpm test --filter <package>
```

6. If a clawpatch finding was involved, revalidate:

```bash
clawpatch revalidate --finding FINDING_ID --provider pi
```

7. Report:

- what changed
- why it is simpler/better
- validation run and result
- any remaining optional cleanup

## Clawpatch Finding Inspection

If the user references a clawpatch finding ID:

```bash
clawpatch show --finding FINDING_ID
```

Then assess it manually before recommending a fix. Do not blindly trust it.

## Deslopify Only

If the user specifically asks to run clawpatch deslopify:

```bash
clawpatch review --mode deslopify --since origin/BASE_BRANCH --provider pi --limit 20
clawpatch report --status open
```

Then summarise as suggestions rather than blockers.

## Output Style

Be concise and practical. Focus on actionable cleanup, not exhaustive critique.

Preferred structure:

```text
Found N cleanup candidates.

Worth fixing:
- path: issue → suggested simplification

Maybe:
- path: issue → why uncertain

Ignore:
- path: likely false positive / not worth churn

Next: I can apply the worth-fixing items if you want.
```

If no useful cleanup is found, say so directly and recommend moving to final `pr-review` if appropriate.
