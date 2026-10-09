---
name: epicify
description: Turn a plan already discussed in the session into a Linear epic whose child tickets are ready to implement, with blocking relations, recorded decisions and a short list of open questions. Investigates first, asks the user only the few largest questions in one batch, decides the rest itself, then builds the tree so /workstream can churn through it. Use only when the user invokes /epicify, or explicitly asks to build, chart or create an epic from the current plan.
compatibility: Requires linear-cli and jq, and the workstream scripts (followup.sh, linear-queue.sh). Read-only access to the repositories involved.
disable-model-invocation: true
metadata:
  author: tvd
  version: 1.0.0
---

# Epicify

Turn a plan into a Linear epic that an agent can deliver with `/workstream`
without coming back to ask what was meant. The epic is the plan made visible: Tom
should be able to read it in a couple of minutes, see what the agent is about to
do, and intervene in Linear by editing a ticket, a decision or a relation.

This is planning only. Don't change code, open branches or start tickets. The
only writes are Linear issues, their descriptions, relations and comments.

## Arguments

All optional:

- an issue ID to use as the epic. Its description is rewritten into the epic
  shape, with the original kept in a collapsed section. Without an ID, create a
  new epic;
- `--draft`: produce the outline and questions, but write nothing to Linear;
- a project name, team key (default `LLE`) or any extra mandate.

## Principles

- **Start from the session.** The plan has usually been discussed already. Harvest
  what was said and decided before investigating or asking anything. Never ask
  again about something the user has settled.
- **Decide, don't defer.** Make every decision you reasonably can, record it on the
  epic with a one-line reason, and move on. Linear is where Tom reviews and
  overrides those decisions. Questions that investigation can answer are answered
  by investigating.
- **Ask few, ask early.** One batch of the largest open questions, before any
  ticket exists. Four at most; one or two is better; none is fine.
- **Ready means ready.** Every implementation ticket meets the readiness bar in
  `../workstream/references/issues.md` (Readiness). If one can't, it's blocked by a
  named question or spike, not quietly vague.
- **Short and plain.** Tickets are read by people deciding whether to intervene.
  Write them with the `writing-for-humans` skill: no preamble, no restating the
  epic, no flowery words. Prefer a bullet to a paragraph and a link to a quote.
- **Refer by name.** In anything a human reads, refer to tickets by title, linked
  to the issue. Don't leave a bare `LLE-123` as the only description of a step.

## 1. Gather

1. List what the session already establishes: goal, constraints, decisions made,
   rejected options, things explicitly out of scope.
2. If an epic ID was given, read it and its tree:
   `../workstream/scripts/linear-queue.sh tree ID --include-closed`. If the tree
   already has children, you're refining it: keep what fits, update rather than
   duplicate, and close what the plan no longer needs, with a comment saying why.
3. Search Linear and open PRs for overlapping work (`searchIssues` on the key
   terms, `gh pr list --search`). Existing tickets that fit get reparented into the
   epic rather than recreated; mention that in the outline.
4. **Inventory before designing.** Find what already exists: storage, writers,
   consumers, contracts, flags, jobs, tests. Read the `CLAUDE.md` and scoped
   `AGENTS.md` files and `.cerbie/rules` for the areas involved. Send bounded
   questions to read-only agents in parallel (`sol-scout` for locating code,
   `sol-investigator` for how something works or why it fails), one question each.
5. Identify the riskiest seam (a cross-service contract, a migration, an SDK or
   third-party capability). If reading code can settle whether it works, settle it
   now. If it needs running code, that becomes a spike ticket.

## 2. Draft privately

Before asking anything, sketch the whole epic for yourself:

- **Outcome:** one or two lines on what's true when the epic is done.
- **Decisions:** each with a short reason. Mark which ones you made yourself.
- **Open questions:** what you can't decide.
- **Out of scope:** what you're deliberately not doing, and why.
- **Tickets:** value-sized slices per `issues.md` (Slicing): each reviewable and
  verifiable on its own, one PR each, grouped into lanes where they touch the same
  files. Typically 4–12 tickets. More than about 15 means the epic should be split
  into two epics, or into tracks with a parent that has its own acceptance.
- **Order:** real `blocks` edges only, and the critical path. Make sure there is
  something unblocked to start on.

Then sort the open questions:

| Kind | What to do |
|---|---|
| Answerable by reading code, data or docs | Investigate now. Not a question. |
| Small, reversible, or a matter of taste | Decide it, record it as an assumption. |
| Needs code to run before anyone can know | A spike ticket that blocks its dependants. |
| Changes the shape of the epic, or is Tom's call: user-facing behaviour, shared contracts and compatibility, cost, security, anything hard to undo | Ask. |

## 3. Ask the big questions

Send **one** message, before creating anything, with:

1. the outcome in one line;
2. the ticket outline: titles only, in order, lanes and blockers shown with
   indentation or arrows, existing tickets that will be reused marked as such;
3. the questions, at most four. Each has two to four concrete options with their
   consequences, and your recommendation first.

Use the `AskUserQuestion` tool where it exists (it caps at four questions, which is
the right cap). Otherwise, number the questions and options so the reply can be
`1a 2b`. Tell the user that silence on anything else means the assumptions in the
outline stand.

If there are no questions worth asking, say so, show the outline, and carry on
unless the user stops you. With `--draft`, stop after this message.

Once answered, revise the draft. Don't start a second round unless an answer
opened a question that's bigger than the ones you asked; in that case ask only
that one.

## 4. Build in Linear

Create first, then wire. Issues need IDs before they can reference each other.

1. **Epic.** Reuse the given issue, or create one:
   `linear-cli issues create "<title>" -t LLE -s "To Do" -a me -d "<body>"`,
   then add `--project` with `linear-cli issues update` if there is one. Keep the
   epic out of the cycle; the children carry the cycle. Don't set it In Progress:
   that's how `/workstream` claims it.
2. **Children.** Create each with
   `../workstream/scripts/followup.sh --parent EPIC -d "<body>" "<title>"`, which
   puts it in the current cycle, assigned to Tom, inheriting the project, after a
   duplicate check. If it exits 3, inspect the match: reuse it (reparent with
   `linear-cli relations parent`) or rerun with `--force` if it's genuinely
   different. Spike tickets use the title prefix `Spike:`.
3. **Relations.** Second pass: `linear-cli relations add A B -r blocks` for each
   edge (A must finish before B starts). Add `related` only where it saves
   someone a search.
4. **Epic description.** Now that the IDs exist, write the epic body with links
   to each ticket.

### Epic body

Keep it under about 50 lines. The epic is an index: a decision's detail lives in
the ticket it affects, and the epic gives the gist and a link.

```markdown
## Outcome
<One or two lines: what's true when this is done.>

## Approach
<Three to six bullets on how. No implementation detail that belongs in a ticket.>

## Plan
1. [Title](url) — <a few words>
2. [Title](url) — <a few words>, after 1
   - [Title](url) — <in parallel with 2>
Critical path: 1 → 2 → 4.

## Decisions
- <Decision> — <reason>. *(Tom)*
- <Decision> — <reason>. *(assumed: edit or comment to change)*

## Open questions
- <Question> — waits on [Spike title](url); blocks [Title](url).

## Out of scope
- <Item> — <why>.
```

Omit any section that would be empty.

### Ticket body

Keep it under about 25 lines. It is the brief an implementer starts from, so
everything they need to begin is here or one link away, and nothing else is.

```markdown
## Goal
<One or two sentences: the change and why it matters.>

## Scope
- <What to do, as concrete bullets.>
- Not: <a tempting adjacent change that belongs elsewhere, if any.>

## Acceptance
- [ ] <Checkable by a test, query or smoke step.>

## Where
<Files, contracts and consumers. Lane, if it shares files with another ticket.>

## Notes
<Only if needed: decisions that constrain this ticket, links, gotchas found while investigating.>

Size: S / M
```

Titles are imperative and say the outcome, in under about 70 characters, in
British English, with no ID or epic prefix. Spike tickets put the question in
`## Goal` and make their acceptance "decision recorded on the epic, and the
blocked tickets updated to match".

## 5. Check

1. `../workstream/scripts/linear-queue.sh tree EPIC`: every child appears, at
   least one is `eligible`, and the blocked ones are blocked by what you intended.
   Check there's no cycle in the `blocks` edges.
2. Reread three tickets as an implementer who has never seen this session. If one
   needs this conversation to make sense, fix the ticket.
3. Reread the epic as Tom with two minutes to spare. Cut anything that doesn't
   help him decide whether to intervene.

## 6. Report

Reply with:

- the epic link;
- the plan as it appears on the epic (titles and order);
- the assumptions you made that Tom is most likely to want to change, at most
  three;
- the next step: `/workstream EPIC`, or what has to be answered first.
