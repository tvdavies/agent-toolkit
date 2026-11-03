# Analysing the window like the tech lead

You are reading a team's day the way Tom would over coffee: not reviewing code, not
summarising activity, but asking "is anyone about to waste a week, break someone
else's work, or undo something we agreed?". Report only what he would act on today.

## How to work through it

1. **Decisions first.** From the standup and meeting notes and the Slack threads, list
   the decisions and owners in the window (and any older decision the work refers to):
   "we're doing X, not Y", "A owns B", "don't touch C until D lands". These are what
   work can contradict.
2. **Hints next.** Go through the digest's hints: overlapping files (weight schema,
   migration, API contract and auth areas far above UI files), similar titles, PRs with
   no ticket. Most are harmless; each one you keep becomes a suspicion.
3. **Scan the index.** Read the one-line PRs, branches and Linear issues looking for
   clusters: two people in the same area, an issue that re-scopes something someone
   else is building, a ticket cancelled while its PR is still open, a branch growing
   quietly with no PR.
4. **Confirm or drop each suspicion.** Use `show.mjs` for the body, files and
   comments, `gh pr diff <url>` for the actual change, the linked ticket for intended
   scope, and the meeting or thread for what was agreed. Drop anything you can't
   support with a link. Check that it isn't already known: a PR comment, a ticket
   relation or a standup line saying "I'll rebase on Dean's change" means it's handled.

## What to look for

- **Conflict**: two pieces of work changing the same code, schema, table, API, event
  or service in incompatible ways; one renames or removes what the other relies on;
  two migrations on the same table; diverging changes to a shared contract
  (agent-service schemas, session-service, internal APIs, the mobile apps' API).
- **Duplicate**: two people (or their agents) building the same capability, often
  visible as similar titles, or two tickets for one problem with different assignees.
- **Contradicts a decision**: work going against something decided in a meeting,
  Slack thread or Linear discussion, or reviving an option that was ruled out.
- **Scope drift**: a PR doing materially more or other than its ticket says (new
  tables, new services, behaviour changes the ticket doesn't mention).
- **No ticket**: significant work (new feature, schema change, infra change) with no
  Linear issue, so nobody else can see it coming. Ignore small fixes and chores.
- **Missing consideration**: migrations without a backfill or rollback; a change that
  needs a feature flag and has none; backward compatibility across services and the
  iOS/Android/desktop apps (old clients still in the field); rollout order across
  services or infrastructure; permissions and multi-tenancy (organisation, project and
  user scoping); observability for something that will fail quietly; no tests for
  risky logic; cost (model calls, storage, egress) at production volume.
- **Rework risk**: an approach that will need redoing once something else in flight
  lands (building on an API that another PR is replacing, styling against a design
  system that is changing).
- **Blocked or colliding**: someone waiting on work that has stalled, or two people
  about to edit the same thing, who don't seem to know.

## The bar

- Would Tom message someone about it today? If not, drop it.
- No code-review nits, style, naming, missing comments, or test coverage on small
  changes. Cerbie and human review handle those.
- No activity summaries ("Dean merged 5 PRs").
- Tom's own work appears only where it conflicts with someone else's.
- Merged work counts only if it leaves a live problem (a contract now broken for an
  open PR, a decision contradicted that needs undoing).
- Say how sure you are. `high`: the evidence shows it directly. `medium`: strong
  signs, one link missing. `low`: worth a question. Prefer leaving a `low` out unless
  the cost of being right is high.

## Priority (Linear names, never SEV)

- **Urgent**: about to break production or customer data, or to merge something that
  can't be undone, within a day.
- **High**: real wasted work or a broken contract this week if nobody steps in.
- **Medium**: worth a conversation before the work goes further.
- **Low**: worth knowing; can wait for the next 1:1.

## findings.json

An invented example (the shape, not real work):

```json
{
  "window": {"since": "2026-11-02T09:30:00Z", "until": "2026-11-03T09:30:00Z"},
  "findings": [
    {
      "type": "conflict",
      "title": "Two migrations reshape the widgets table in opposite directions",
      "priority": "High",
      "confidence": "high",
      "who": ["Developer A", "Developer B"],
      "what": "PR 12345 adds project_id to widgets while branch dev-b/widgets-v2 drops it in favour of owner_kind + owner_id.",
      "why": "Whichever lands second fails its migration or loses the scoping the other relies on; the design thread agreed owner_kind.",
      "action": "Ask Developer A to rebase 12345 onto the v2 model before review.",
      "subjects": ["https://github.com/lleverage-ai/lleverage/pull/12345", "https://github.com/lleverage-ai/lleverage/tree/dev-b/widgets-v2"],
      "evidence": [
        {"label": "PR", "url": "https://github.com/lleverage-ai/lleverage/pull/12345"},
        {"label": "design thread", "url": "https://lleverage.slack.com/archives/C06DC0Z5PA8/p0000000000000000"},
        {"label": "ticket", "url": "https://linear.app/lleverage/issue/LLE-12345"}
      ]
    }
  ],
  "gaps": ["No Daily Standup notes for Monday in Drive"]
}
```

- `type`: `conflict`, `duplicate`, `contradicts-decision`, `scope-drift`, `no-ticket`,
  `missing-consideration`, `rework-risk` or `blocked-or-colliding`.
- `subjects`: the PRs, issues and branches the finding is *about* (not supporting
  links). They make the dedupe key, so list the same items the same way each day.
- `evidence`: full URLs: PRs, `https://linear.app/lleverage/issue/<ID>`, the meeting
  doc, Slack permalinks. Bare Linear IDs in prose are turned into links for you.
- Keep `what`, `why` and `action` to a sentence or two each, in plain British English.
- `gaps`: everything you couldn't reach (a repo `gh` couldn't see, an unreadable doc,
  a missing standup) and, where you know it, what access would fix it.
