---
name: worktrees
description: Manage git worktrees so independent work stays isolated and concurrent work never collides. Use when a task needs its own branch/worktree, when continuing or reviewing an existing branch or PR (adopt the branch it is on rather than starting fresh), when a task spans more than one repo, or whenever you would otherwise risk dirtying a shared checkout. Trigger phrases include "work in a worktree", "isolate this change", "create a worktree", "adopt the branch", "review PR in its worktree", "merge the worktree back".
metadata:
  author: tvd
  version: 1.0.0
---

# Working with git worktrees

A git worktree is a second working directory backed by the same repository, checked out
on its own branch. Worktrees let independent pieces of work proceed in parallel without
touching each other's files or the main checkout. This toolkit manages worktrees under
`~/.pi-worktrees/<repo>/` on prefixed branches.

You have agent-callable tools that do the same things as the `/wt-*` commands. Prefer them
over raw `git worktree` so everything follows the same convention.

## When to use a worktree

- **Fresh, isolated work** on a repo → `worktree_new`.
- **Continue or review an existing branch / PR** → inspect the current checkout first. Reuse it
  when it is already the dedicated non-primary managed worktree for that branch or PR; otherwise
  inspect `worktree_list`, then use `worktree_adopt`. Never create a redundant worktree, and never
  do code-changing PR work in the primary checkout merely because that branch is already there.
- **A task touching more than one repo** → call the tools once per repo, passing each
  repo's path as `repo`.
- **You are a delegated worker** → you already start in your own auto-created worktree, so
  you usually need these tools only to adopt a *different* existing branch/PR, or to work in
  *another* repo. If you don't need a different worktree, just work where you are.

## Tools

- `worktree_list({ repo? })` — list a repo's worktrees (path + branch). **Check this first**
  so you reuse an existing worktree instead of duplicating it.
- `worktree_new({ name, base?, repo? })` — create a worktree on a new prefixed branch from
  `base` (default: latest origin default branch). Returns the path to work in.
- `worktree_adopt({ branch?, pr?, repo? })` — check out an existing branch (or a PR's head
  branch) in its own worktree. This is the right tool for "review/continue PR #123".
- `worktree_status({ path? })` — current branch + changed-file count for a worktree.
- `worktree_merge({ target, branch?, mode?, repo? })` — integrate a worktree's branch into
  `target` (`squash` | `merge` | `cherry-pick`). Reports conflicts for you to resolve; does
  not delete anything. A squash leaves staged changes ready to commit.
- `worktree_remove({ branch?, path?, deleteBranch?, repo? })` — remove a worktree (and
  optionally its local branch) once integrated or abandoned.

## Typical flows

**Review/continue a PR that already has a branch**
1. Inspect the current checkout's absolute root, worktree entry, branch, upstream, HEAD, and status. If it is already the dedicated non-primary managed worktree for this PR, reuse it instead of adopting or creating another one.
2. Preserve intended dirty files or local commits in that current PR worktree. Determine whether it is ahead, behind, or diverged from the remote head; do not require exact HEAD equality before understanding legitimate local work.
3. Otherwise use `worktree_list({ repo })` and identify the primary checkout plus any existing managed PR worktree.
4. `worktree_adopt({ pr: "123", repo })` when no suitable managed PR worktree exists.
5. Verify the returned path is under the managed worktree root and is not the primary checkout before any code-related command.
6. If adoption returned the primary checkout because the head branch is already checked out there, ensure the exact PR head object is fetched without changing primary-checkout files, then call `worktree_new` with a unique PR-specific name and `base` set to that exact SHA. For a GitHub fork PR, fetching `pull/PR_NUMBER/head` from the base remote can make the head object available before worktree creation. Verify the fetched SHA before continuing. Work on the temporary local branch and push only with an explicit `HEAD:PR_HEAD_BRANCH` refspec after re-checking the remote head.
7. Do all installs, edits, builds, tests, commits, and conflict resolution in the verified worktree.
8. Remove it only when clean and safely integrated or pushed; never delete the remote PR head branch.

**New isolated feature**
1. `worktree_new({ name: "fix-login-cache" })` → path on `…/fix-login-cache`.
2. Work, commit. `worktree_merge({ target: "main", mode: "squash" })` → commit the squash.
3. `worktree_remove({ branch: "…/fix-login-cache", deleteBranch: true })`.

**Multi-repo task** — repeat per repo, passing `repo`:
`worktree_new({ name: "shared-change", repo: "/path/to/other-repo" })`.

## Rules

- Inspect the current checkout before listing, creating, or adopting. Reuse it when it is already the correct dedicated non-primary worktree, including when it contains intended ahead or dirty work for the task.
- Use `worktree_list` before creating or adopting when the current checkout is unsuitable, so you know which path is the primary checkout and avoid duplicates.
- A request for isolation is not satisfied by returning the primary checkout. Verify the adopted path before mutation.
- Prefer `worktree_adopt` for an existing branch only when it yields a dedicated managed worktree.
- If the existing branch is checked out in the primary checkout, create a managed worktree from the exact remote head on a temporary local branch rather than touching or moving the primary checkout.
- Anchor every mutating command to the verified worktree path; do not assume a prior `cd` persists between tool calls.
- Commit or stash before `worktree_merge` (it refuses on a dirty tree).
- Clean up with `worktree_remove` only when work is integrated or pushed and the worktree is clean. Preserve dirty worktrees and report their paths.
- Destructive git operations are still subject to the guardrails floor — a blocked op means
  ask before retrying, don't force around it.
