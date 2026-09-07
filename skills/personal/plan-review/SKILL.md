---
name: plan-review
description: Mechanics for explicitly authorized plan publication and feedback on plans.myslop.app. Use when asked to publish a plan, check its review status, reply to comments, or revise a published plan. Does not grant implementation authority or require publication for local draft/review requests.
compatibility: Requires bash, curl, jq, and network access to plans.myslop.app.
---

<!-- Canonical copy. Derived from https://plans.myslop.app/skill.md with the
     raw curl/token mechanics replaced by scripts/plan.sh. Dispatch vendors an
     adapted copy separately; toolkit sync does not update that copy. -->

# plan-review

Publish authorized plans to https://plans.myslop.app, where humans comment on
blocks, approve, or request changes. Reviewers can see and compare versions.

## Caller-owned authority

The caller owns publication authorization, destination, wait mode, and
implementation authority within runtime/stage restrictions. This skill only
supplies service mechanics. For an interactive draft/review, return the
requested output and stop. An HTML-only request does not need the plan service.
Honour an explicit upload/publication request using the requested destination;
if that capability is unavailable, name the blocker rather than silently
substituting a draft or another destination.

No default polling, including headless/autonomous use. Plan approval does not
itself authorize implementation. Only the owning caller/stage can do that.

## The script owns the API

Resolve this skill directory as `SKILL_DIR`. Every service interaction goes
through one script — never hand-roll curl calls or token handling:

```sh
bash "$SKILL_DIR/scripts/plan.sh" <command> …
```

| Command | Purpose |
| --- | --- |
| `plan.sh create --title TITLE --md plan.md` | Create v1 → `{id, url, raw_url, version}` |
| `plan.sh revise PLAN --note "v2: …" --md plan.md` | Publish the next version (full markdown) |
| `plan.sh status PLAN` | `status` (`open`/`approved`/`changes_requested`, for the current version), versions, reviews, `unresolved_comment_count` |
| `plan.sh comments PLAN [--since MS]` | Comments with authors, threads, and block excerpts |
| `plan.sh comment PLAN --body TEXT [--reply-to ID \| --block ID]` | Agent comment, threaded reply, or block-anchored comment |
| `plan.sh resolve PLAN COMMENT_ID` | Mark a thread addressed |
| `plan.sh markdown PLAN [--version N]` | Stored markdown, tokenless — usable by any agent with the link |
| `plan.sh snapshot PLAN` | Canonical review snapshot (Dispatch wait fingerprints) |

`PLAN` is the plan URL (`https://plans.myslop.app/p/<id>`) or bare id.

The script resolves the API token itself (`$MYSLOP_PLANS_TOKEN`, then
`~/.config/myslop-plans/token`). Do not pre-verify the token or check that it
exists — just run the command. If the token is missing or rejected, the script
exits 3 with the exact remedy: the user mints one by running
`curl -fsS https://plans.myslop.app/setup.sh | bash` in an interactive
terminal. Surface that error verbatim and stop; do not improvise other
authentication.

## Authoring

For service publication, write the plan as markdown. These restrictions do not
apply to a local HTML deliverable. The service renders a bounded subset: ATX headings,
paragraphs, fenced code, `-`/`1.` lists (nesting allowed), blockquotes, pipe
tables, `---` rules, images, links, and inline code/bold/italic/strikethrough.
Raw HTML is escaped, not rendered; avoid setext (`===`) headings.

- Pass a short, specific **title** separately (not a heading): it identifies
  the plan among many.
- Open with a 2–4 sentence summary, then Goals / Non-goals, the design, phased
  steps, risks, and open questions.
- Every top-level block is an individually commentable anchor, so keep one
  idea per paragraph or list item, and keep unchanged blocks word-stable
  across versions so comments stay attached.
- Diagrams: export SVG/PNG, upload with the file-upload skill, embed the
  `files.myslop.app` URL as a markdown image.

## Workflow

1. When publication is authorized, `create` the plan and **give the returned
   `url` to the user** (review sign-in required; the link itself is unguessable).
   Otherwise deliver the requested local draft/review and stop.
2. When feedback arrives, read it with `status`/`comments`. Reply in-thread
   with `comment --reply-to`; apply, discuss, or decline with grounded
   reasoning. `resolve` a thread only after actually addressing it.
3. For changes, `revise` with the full updated markdown and a one-line
   `--note`. A new version resets status to `open`; batch feedback into one
   version rather than micro-revising.
4. On current-version `approved`, report the decision and version and stop.
   A new version resets approval. Start implementation only with separate
   caller authorization and permission from the owning stage.

Check once when asked to check. Wait only on explicit caller request/policy,
prefer event-driven waits, and use a bounded interval/deadline if polling is
necessary (30–60 s between checks). Stop on approval, changes requested, the
deadline, or failure; do not remain alive merely because the service is open.

Under Dispatch (`DISPATCH_TASK_ID` set), `plan-ticket` remains the driver. It
owns required publication, verified current-version approval and the handoff.
Never poll: `plan-ticket` records one seeded `plan_feedback` wait and exits;
the reconciler wakes the lane on review-state change. Do not weaken that
stage's required approval/wait semantics with the interactive draft default.
