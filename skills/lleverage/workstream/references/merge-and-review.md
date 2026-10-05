# Merge and review

## Merge policy

- Per ticket, follow `~/.claude/skills/yolo-ticket/SKILL.md`: normal GitHub
  auto-merge with `--squash --match-head-commit <head>`, armed only once the PR is
  ready. No `--admin`, no force-push, no push to `main`.
- **Temporary exceptions** live in memory, not here. Check
  `~/.claude/projects/-home-tvd-dev-lleverage-ai-lleverage/memory/MEMORY.md`
  (for example the jaythegeek comment-approval workaround) at the start of every
  run, and copy any that are active into `brief.md` verbatim, with their limits.
  Drop them from the brief as soon as memory says they are gone.
- The orchestration policy is stricter than GitHub: a code-owner human (or an
  active documented exception) must approve. A bot approval alone is never enough
  (#7602 merged on CodeRabbit's approval alone).
- `lleverage-ai/infrastructure` has no auto-merge, so Tom merges. Open the PR, put
  it in the ledger and on the human queue, and verify the rollout after the merge.
  Staging overlays target the `staging` branch (`--base staging`); production
  overlays target `main`. When both are needed, open both.
- Never publish anything outside the repo (gists, file uploads, public buckets,
  Slack) unless Tom asked for it in this run.

## Review economics

`main` requires approval of the last push, so **every push after an approval
costs a new review round** (20–60 minutes). Therefore:

- implementers run their own checks and an independent `sol-reviewer` (foreground,
  with the diff inline) **before** marking ready;
- batch all feedback fixes into one push per review round;
- no cosmetic or docs-only pushes after approval. Put them in a follow-up PR or
  the next PR in the lane;
- bundle a lane's small slices into one PR (one session went from about 20 PRs to
  8 for the same work);
- for a stale CodeRabbit CHANGES_REQUESTED review whose threads are resolved, with
  green CI and a code-owner approval on the head, dismiss it as the brief
  describes. Never dismiss a human's review.
- cap review rounds: after three rounds on one PR without convergence, stop and
  escalate the disagreement in one message, rather than continuing the loop.

## Conflicts and main health

- `strict_required_status_checks_policy` is off, so two PRs that are green on
  their own can break `main` together (#7413 with #7419 on 2026-10-01). After a
  burst of merges, or when a PR fails in code it didn't touch, run the failing
  suite on `origin/main` first.
- When `main` is red, fixing it is the top priority for the whole workstream. One
  agent fixes it, and everyone else rebases after.
- After each merge, the PRs in the same lane get refreshed immediately (`gh pr
  update-branch` or a rebase by their owner), before a human finds the conflict.
- Close superseded PRs as soon as their replacement lands (#7601 sat orphaned).
- Watch image builds and deploys, not only PR CI: on 2026-10-04 app builds failed
  silently, and another merge ran out of build heap.

## Evidence

- A command passes only on exit status 0 with a completed run. Empty output is not
  a pass (a type-check "pass" on 2026-10-01 was empty output).
- Integration suites for agent-service and session-service are skipped in CI, so
  run the relevant ones locally (`pnpm test:integration`) and quote the counts.
- Review the final diff, including conflict-resolution commits. An unreviewed
  merge commit shipped a bug to agent-sdk main on 2026-10-02.
