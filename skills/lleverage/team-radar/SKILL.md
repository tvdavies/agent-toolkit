---
name: team-radar
description: Daily tech-lead review of what the other Lleverage developers are doing (PRs, pushed branches, Linear, standup and meeting notes, Slack decisions) to flag conflicts, duplicated work, contradicted decisions and missed considerations before much work is done. Read-only; returns ranked findings or "nothing to flag". Use for "team radar" or a daily cross-team review.
metadata:
  author: tvd
  version: 1.0.0
---

# Team radar

Tom is tech lead. Once a day this skill reads what everyone else has been doing and
tells him only what he would act on: two pieces of work about to collide, work going
against something already decided, a PR wandering from its ticket, a consideration
nobody seems to have thought about. The aim is to catch a wrong path before much work
goes down it. "Nothing to flag" is the normal, expected result.

**Read-only throughout.** Never post, comment, react, label, assign, approve or edit
anything in Slack, GitHub, Linear or Drive. `gh` only for `pr list/view/diff` and GET
`gh api` calls; `linear-cli` only for `api query` and `issues get`. Findings go back to
Sal, who decides what reaches Tom.

## 1. Gather GitHub and Linear (script)

```bash
S=~/.agents/skills/team-radar/scripts
node $S/gather.mjs --out "$PWD/team-radar"        # in your workspace, not /tmp
```

It prints a JSON summary. Exit 0 means every source answered; 4 means something wasn't
reached (listed under `gaps` and at the top of the digest): carry those into your
result. It writes `team-radar/digest.md` (read this) and `team-radar/data.json`.

- **Window**: from the last recorded run (state file, below), else the previous
  working day at the same time; a Monday run reaches back to Friday. Override with
  `--since <ISO>`; `--print-window` just prints it.
- **GitHub** (`lleverage-ai`): every repo pushed in the window except agent memory
  repos (`*-brain`); PRs updated in the window (draft, open, merged, closed) with files
  and linked Linear IDs; other open PRs from the last 21 days, for overlaps; branches
  with new commits that have never had a PR, compared with the default branch. Bots
  are dropped. Jeff's PRs (`jefftheai`) are real work done for a developer: keep them.
- **Linear** (`--teams LLE` by default, `--teams LLE,FDE,CC` or `all` to widen):
  issues with human activity in the window (created, retitled, re-described,
  reassigned, re-prioritised, cancelled, marked duplicate or blocked, commented). Plain
  status and project moves are left out. Also the issues other people's PRs link to.
- Tom's own PRs and issues are kept to one line: they matter only where they meet
  someone else's work. Repos where only Tom is active (such as `kantel`) are counted,
  not listed.

The digest opens with mechanical **hints**: unshipped work touching the same files as
someone else's, similar titles from different people, and PRs with no ticket. They are
leads, not findings. For detail on any item:

```bash
node $S/show.mjs --data team-radar/data.json https://github.com/lleverage-ai/lleverage/pull/9669 LLE-17305
```

Use `gh pr diff <url>` (or `gh pr view <url> --comments`) when the files and
description aren't enough to judge, and `linear-cli issues get LLE-123 --output json`
for an issue outside the window.

## 2. Read the meetings (Drive tools)

Use `drive_search` and `drive_read_doc` (Sal's host tools; never `gog`). Gemini notes
docs are titled `<Meeting> - YYYY/MM/DD HH:MM <TZ> - Notes by Gemini`, the time zone
being the host's: `CET` in winter, `CEST` in summer, sometimes `GMT`/`BST`.

1. `drive_search "Notes by Gemini CET"` (and `CEST` between late March and late
   October). Results are newest first; keep rows of type **Doc** (skip the
   `application/vnd.google-apps.shortcut` duplicates) whose title date falls in the
   window. Page on if the last row is still inside it.
2. Always read the **Daily Standup** docs (09:00 London, titled around 09:58-10:00 CET).
   Also read other team meetings in the window: initiative check-ins and reviews,
   technical or design sessions, the Friday all hands. Skip sales and customer calls
   unless they decide something about how the product is built.
3. Read **Decisions** (Aligned / Needs Further Discussion) and **Next steps** in the
   full notes; go to the transcript only to confirm who said what. Transcripts
   misattribute speakers, so say "per the notes" when it matters.

No standup doc for a weekday in the window (holiday, not recorded, not shared) goes in
your gaps, not in a finding.

## 3. Read Slack decisions (Slack tools)

Use `slack_history`, `slack_search` and `slack_thread` (read-only; never a token).

- `slack_history` over the window for `#devs` (`C06DC0Z5PA8`) and the initiative
  channels `#initiative-operate-expand` (`C0C9RHULML2`) and
  `#initiative-get-solutions-live` (`C0C9PQK9BDL`). Open threads whose parent is a
  design or approach discussion with `slack_thread`.
- `slack_search` with `after:<day before the window starts>` for decision language:
  `decided`, `agreed`, `"going with"`, `"instead of"`, `"let's not"`, `"don't merge"`,
  `deprecate`, `migration`, plus the names of anything in the hints that looks risky.
- Skip bot digests (Daily Merge Report, security watch, Delta summaries) unless they
  record a decision. Results outside Tom's channels are hidden; that's expected.

## 4. Analyse like the tech lead

Follow `references/analysis.md`: what to look for, the bar, and how to write each
finding. In short: start from the hints and the meetings' decisions, form a handful of
suspicions, then confirm or drop each against the PR diff, the ticket and the
discussion. Two or three solid findings beat ten weak ones, and zero is fine.

## 5. Dedupe and output (script)

Write the findings to `team-radar/findings.json` (format in `references/analysis.md`;
`{"findings": []}` when there are none) and run:

```bash
node $S/findings.mjs --in team-radar/findings.json --record [--seen tr-abc,tr-def]
```

It validates every finding (Linear priority names Urgent/High/Medium/Low only, a person,
evidence links), gives each a stable key, drops anything already flagged that hasn't
materially changed, ranks the rest and prints the result. Exit 0 means nothing to flag;
3 means findings; 2 means fix the input and rerun. Return its output as your result,
word for word, with your gaps in the input's `gaps` list.

**Persistence.** The state file `~/.local/state/team-radar/state.json` holds `lastRun`
(the next window's start) and every flagged key with its priority and the PRs and
issues it cited. `~/.local/state` is on the host's disk and writable from Sal workers,
and it survives between tasks (the sweep skill keeps its gate state the same way).
`--record` writes it atomically; leave it off for a dry run. A finding counts as
changed, and is flagged again, when its priority rises or it cites a PR or issue it
didn't before. As a second line of defence, every finding carries its key (`tr-…`), so
the scheduler can pass earlier keys with `--seen` (or `--seen-file`) if the state file
is ever lost.

## Gotchas

- `gh pr list --search updated:>=…` is the only cheap way to get a window of PRs; the
  repo events API keeps about two days and misses most pushes.
- Branch listing pages through every ref (about 15 GraphQL pages for
  `lleverage-ai/lleverage`), so a gather takes about two minutes. It's mostly waiting.
- A daily digest is small; a week's (a first run, or after a gap) is about 300 KB.
  Read it a section at a time, hints first.
- PRs at GitHub's 100-file cap (staging twins cut from `main`, un-rebased stacks) are
  left out of the overlap pairs and named under them: their file lists carry other
  people's merged work. The same goes for the Linear IDs a stacked PR "links": check
  the PR body before calling it scope drift.
- Linear `history` actors are users even when GitHub automation moved the issue; that
  is why plain status moves are ignored.
- Agents (Jeff, Delta, Sal) file many Linear issues on people's behalf. Treat the
  assignee as the person doing the work.
