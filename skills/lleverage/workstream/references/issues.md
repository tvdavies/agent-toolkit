# Issues: readiness, slicing, follow-ups, done

Last week's lesson: 358 issues were created in five days. Half were closed within
four hours of creation, and the next cycle opened with 83 tickets, 68 of them
created during the run. Creating issues isn't wrong, but each one costs board
attention. Create one only when it carries something the board needs.

## Readiness

A ticket is ready when all of these hold:

- the problem and the expected behaviour are stated, with reproduction or evidence
  for bugs;
- acceptance criteria can be checked (by a test, a query or a smoke step);
- the affected code is located (files, contracts, consumers);
- product decisions are made and recorded on the ticket. Ask Tom **before**
  building, not after (LLE-13929 sought sign-off on a table design after it was
  built). Batch these questions;
- no open blocker; dependencies are set as Linear `blocks` relations;
- it fits one reviewable PR (roughly under 1,500 changed lines, one main contract).

Getting a ticket ready is investigation work. Follow `../../prepare-ticket/SKILL.md`
(from a subagent: "Run the prepare-ticket skill on ID"), which writes the findings
into the ticket description, not just a comment, and returns a verdict.
Bug causes come from `../../root-cause/SKILL.md`.

## Planning a top-level issue

1. **Inventory first.** Before proposing an architecture, establish what already
   exists: storage, writers, consumers, alerts, migrations, jobs. On 2026-10-01 a
   plan assumed a new store before checking how log-shaped `session_events`
   already was. In the cycle sweep, a new alert duplicated working Slack alerts,
   and an index was built by hand where a migration was needed.
2. **Decisions with Tom**, presented as options with costs. Record the outcome in
   `STATE.md` and the design document.
3. **Spike the hardest seam** (a cross-repo contract or an SDK capability) before
   declaring the tree ready. On 2026-10-02 the provider-boundary design turned out
   impossible with rc.4 the morning after 32 tickets were declared ready.
4. **Write invariants as tests early.** The programme's central rule (append-only,
   never drop prompt entries) was broken by a slice and only caught later.
5. Optional: a Linear design document linked from the root.

## Slicing

- A slice is a piece of value that can be reviewed and verified on its own, not a
  PR. Several small fixes to one area are one ticket with one PR.
- **Lanes:** tickets touching the same files or registry (`session-repository.ts`,
  `platform-registry.ts`, alert rule files, feature-flag constants) form one lane,
  done in order or bundled into one PR. Parallel PRs in one file caused most
  conflicts last week.
- Keep coordination parents to a minimum: one root, plus a parent only where a
  track has its own acceptance. Every parent needs acceptance criteria, or it
  never gets closed (LLE-13889 and LLE-13890 stayed To Do after all their
  children were done).
- Set `blocks` relations for real ordering only.
- One owner per shared resource (SDK releases, migration numbering, staging
  branch promotion), named in `STATE.md`. Two sessions bumped the SDK release at
  the same time last week.

## Follow-ups

When review, testing or investigation turns something up, decide in this order:

1. **Fold it in** if it belongs to the current ticket's acceptance or is small.
   Reviewer suggestions: fold in, push back with a reply, or follow up. Most
   should be the first two.
2. **Add it to an existing open ticket** (`followup.sh` reports likely duplicates
   and exits 3; comment on the match instead).
3. **Create a follow-up** with `scripts/followup.sh`, which applies Tom's placement rules:
   - default: To Do, assigned to Tom, **current cycle**, parented under the
     workstream issue it came from, inheriting its project;
   - `--later` (next cycle): only when the urgency is very low **and** the
     priority is low;
   - `--triage`: only for a separate bug that has nothing to do with the
     workstream (unassigned, no cycle);
   - batch several related small findings into one ticket with a checklist rather
     than one ticket each.

Every follow-up states why it exists, where it came from (PR or review link) and
what done looks like. Report the net figure (created vs closed in `issues.log`)
in every status summary. If created runs ahead of closed for a day, slow down
creation and fold more in.

## Done means accepted

- Linear closes a ticket when its PR merges. A ticket whose acceptance needs
  deploy, rollout or soak verification gets reopened (or kept open) until that
  verification is recorded on it.
- An umbrella or parent closes when its acceptance holds, not merely when its
  children are done (`linear-queue.sh` reports `umbrella-done`).
- When work remains on a ticket that was closed, create a ready follow-up and
  link it. Don't leave the remainder in a comment.

## Cycle closeout

On the last day of a cycle, without being asked:

1. Finish what can merge today. Don't start what can't.
2. For each open ticket, decide: carry over (committed next-cycle work), move to
   the next cycle with `--later`-style reasoning, or Backlog (parked, no cycle).
   Keep parked children's parent link but take them out of the cycle.
3. Keep umbrella and parent tickets out of the cycle unless they are the work
   item. Rolling over a parent doesn't move its children, and vice versa.
4. Post a closeout summary: done, carried, parked, net issues created, and open
   human actions.
