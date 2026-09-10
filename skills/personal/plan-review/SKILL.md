---
name: plan-review
description: Mechanics for explicitly authorized plan publication, feedback, approval and requests for changes on plans.myslop.app. Use when asked to publish, check status, reply, revise, approve or reject a plan. Requires explicit instructions and a permissioned key for agent verdicts; does not grant implementation authority.
compatibility: Requires bash, curl, jq, and network access to plans.myslop.app.
---

<!-- Canonical copy. Derived from https://plans.myslop.app/skill.md with the
     raw curl/token mechanics replaced by scripts/plan.sh. Dispatch vendors an
     adapted copy separately; toolkit sync does not update that copy. -->

# plan-review

Publish authorized plans to https://plans.myslop.app. Humans and explicitly
authorized reviewer agents can comment, approve, or request changes. Reviewers
can see and compare versions; agent decisions are labelled separately from
human decisions.

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
Possessing `plans:review` is a capability, not an instruction to approve.
Only submit a verdict when the caller explicitly authorizes a posted approval
or request for changes on that named plan. A request to examine/review a plan
without publication authorization returns findings, not a vote. Publication,
authoring, a pending wait, or an approving-sounding comment does not authorize
an agent verdict.

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
| `plan.sh verify` | Selected key ID/name and effective permissions; use when asked to inspect credential capabilities |
| `plan.sh review PLAN --version N --verdict approved\|changes_requested [--note TEXT]` | Submit an explicitly authorized verdict for the reviewed version |
| `plan.sh approve PLAN --version N [--note TEXT]` | Convenience command for `approved` |
| `plan.sh request-changes PLAN --version N [--note TEXT]` | Convenience command for `changes_requested`; `plan.sh reject` is an alias, not deletion |
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

Existing `msp_` keys and local token files remain valid. Review requires an
explicit `plans:review` grant on that key; ordinary author and setup keys do
not gain it automatically. The owner can enable **Approve and request changes**
in **Dashboard → API tokens → Permissions**, keeping existing permissions
checked, without rotating the key. The **Oracle reviewer** preset instead
grants read/comment/review without write/resolve. Everyone holding the same
key shares its permissions. All authenticated plan access is limited to the
issuing user's account, including plans created with their other keys.

A `403` exits 4 and asks the owner to update the existing key's permissions.
Do not change credentials, mint a replacement or fall back to a platform key.
A `409` exits 5: inspect and review the new version before another submission.
The script never retries a verdict automatically. The `msa_` platform identity
currently supports authoring, not individually granted review authority.

## Approve or request changes when instructed

1. Verify the caller explicitly authorized your verdict on this plan. Do not
   use this command to satisfy an authoring task's own human-review wait.
2. Run `plan.sh status PLAN` and read `plan.sh markdown PLAN --version N` for
   that exact current version. Read relevant comments and evaluate the plan
   against the caller's requirements; never merely approve to unblock work.
3. Publish detailed findings with `comment` if needed, then submit one verdict:

   ```sh
   bash "$SKILL_DIR/scripts/plan.sh" approve "$PLAN_URL" --version 3 \
     --note "Migration and rollback coverage look sufficient."
   # Or, to reject the current proposal and ask for a revision:
   bash "$SKILL_DIR/scripts/plan.sh" request-changes "$PLAN_URL" --version 3 \
     --note "Add a rollback plan and cover partial migration failures."
   ```

4. Report the reviewed version and returned status. If `current_version`
   differs from the reviewed `version`, or the request fails with `409`, the
   current version still needs review. Never resubmit an old verdict merely by
   replacing its version number.

API responses and `snapshot` retain each review's `author: {type, id, name}`.
`type` is `user` or `agent`; agent IDs are stable key IDs. Reviews from a key
never replace its owner's human review. Unknown/absent author metadata is not
proof of a human decision. When a caller or Dispatch stage requires human
approval, require an explicit current-version `user` approval as well as
aggregate `approved`; an agent-only approval does not satisfy that gate.
Changing a stage's required reviewer needs separate caller authorization.
Requests for changes take precedence over approvals. Resolving a thread does
not clear a verdict; revocation preserves past decisions.

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
4. On current-version `approved`, check the required reviewer type, report the
   decision, reviewer and version, and stop. A new version resets approval.
   Start implementation only with separate caller authorization and permission
   from the owning stage.

Check once when asked to check. Wait only on explicit caller request/policy,
prefer event-driven waits, and use a bounded interval/deadline if polling is
necessary (30–60 s between checks). Stop on approval, changes requested, the
deadline, or failure; do not remain alive merely because the service is open.

Under Dispatch (`DISPATCH_TASK_ID` set), `plan-ticket` remains the driver. It
owns required publication, verified current-version approval and the handoff.
Never poll: `plan-ticket` records one seeded `plan_feedback` wait and exits;
the reconciler wakes the lane on review-state change. Do not weaken that
stage's required approval/wait semantics with the interactive draft default.
