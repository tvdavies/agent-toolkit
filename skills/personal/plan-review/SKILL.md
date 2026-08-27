---
name: plan-review
description: Author an implementation plan as markdown, publish it to plans.myslop.app for human review, then track comments and approvals, reply to feedback, and publish revised versions. Use whenever a plan, design, or proposal should be reviewed and approved by a human before implementation.
compatibility: Requires bash, curl, jq, and network access to plans.myslop.app.
---

<!-- Canonical copy. Derived from https://plans.myslop.app/skill.md with the
     raw curl/token mechanics replaced by scripts/plan.sh. The Dispatch repo
     vendors this skill at dispatch/skills/plan-review; keep them in step. -->

# plan-review

Publish plans to https://plans.myslop.app where humans review them: they
comment on individual blocks (paragraphs, list items, headings), approve, or
request changes. You reply as the agent, resolve addressed comments, and
publish new versions until the plan is approved. Reviewers see every version
and can diff any two.

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

Write the plan as markdown. The service renders a bounded subset: ATX headings,
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

1. `create` the plan and **give the returned `url` to the user** — that is
   where they review (sign-in required; the link itself is unguessable).
2. When feedback arrives, read it with `status`/`comments`. Reply in-thread
   with `comment --reply-to`; apply, discuss, or decline with grounded
   reasoning. `resolve` a thread only after actually addressing it.
3. For changes, `revise` with the full updated markdown and a one-line
   `--note`. A new version resets status to `open`; batch feedback into one
   version rather than micro-revising.
4. On `approved`, proceed with the work.

Outside Dispatch, poll `status` every 30–60 s while waiting. Under Dispatch
(`DISPATCH_TASK_ID` set), never poll: the `plan-ticket` skill records one
seeded `plan_feedback` wait and exits, and the reconciler wakes the lane when
review state changes.
