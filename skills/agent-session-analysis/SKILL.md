---
name: agent-session-analysis
description: Analyse a local bundle produced by scripts/download-agent-sessions and generate product/agent insight reports plus Linear-ready candidate issues. Use when asked to analyse downloaded agent session data, generate an agent session insight report, find themes in agent sessions, or create Linear candidates from an agent analysis bundle.
---

# Agent Session Analysis Skill

Use this skill to turn a downloaded agent-session bundle into actionable product and agent-improvement insights.

## Inputs

The user should provide a bundle path, usually under:

```text
reports/agent-sessions/<from>_<to>/
```

If no path is provided, find the most recent directory under `reports/agent-sessions/`.

Expected files:

- `metadata.json` — extraction parameters and counts
- `sessions.jsonl` — one normalised record per session
- `samples/<session-id>/...` — downloaded GCS files, when available

## Process

1. Read `metadata.json` and summarise the extraction scope.
2. Read `sessions.jsonl`.
3. Sort sessions by `score` descending and inspect:
   - top scored sessions
   - sessions with `negative_text_signals`
   - sessions with `error_text_signals`
   - sessions with many model requests or high token use
   - a small baseline sample of low/medium scored sessions
4. For representative sessions, inspect downloaded sample JSON files where available.
5. Identify recurring themes:
   - workflow debugging loops
   - integration credential/auth problems
   - data mapping confusion
   - agent misunderstood workflow structure
   - missing product capability
   - poor error recovery
   - excessive tool usage or repeated model calls
   - unclear final answer or user frustration
6. Separate evidence-backed findings from hypotheses.
7. Write reports back into the bundle directory.

## Output files

Create or overwrite:

```text
summary.md
linear-candidates.md
sessions-to-review.md
data-quality.md
```

### `summary.md`

Include:

- date range and extraction stats
- headline findings
- what the agent appears to do well
- what the agent appears to do poorly
- top themes with counts where possible
- recommended next steps

### `linear-candidates.md`

For each candidate issue:

```md
## Candidate: <short title>

Priority: High | Medium | Low
Confidence: High | Medium | Low
Evidence sessions: <count/list>
Affected organisations: <count/list if safe>
Themes: <tags>

### Problem

### Evidence

### Suggested fix

### Acceptance criteria
```

Keep candidates specific enough to become Linear tickets. Avoid creating tickets for one-off unclear sessions unless the impact is high.

### `sessions-to-review.md`

List sessions that a human should inspect manually, with:

- session ID
- organisation ID
- score and score reasons
- why it is interesting
- local sample path

### `data-quality.md`

Call out limitations, for example:

- no GCS files downloaded for some sessions
- bucket mapping failures
- missing organisation/user metadata
- sampled data biased towards high-volume sessions
- low signal in deterministic text heuristics

## Privacy rules

- Do not include secrets, API keys, credentials, or long raw transcripts in reports.
- Use short evidence snippets only when necessary.
- Prefer aggregate observations over raw session content.
- If sensitive content appears in samples, redact it in generated reports.

## Reporting style

Be concise, evidence-led, and action-oriented. The goal is to help the team create Linear issues that improve the Lleverage agent.
