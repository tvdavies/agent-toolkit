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
- **Continue or review an existing branch / PR** → `worktree_adopt` (do NOT create a new
  branch — adopt the one the work is already on, e.g. the head branch of the PR).
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
1. `worktree_adopt({ pr: "123" })` → returns the worktree path.
2. Do the review/work there (operate on that path).
3. If you changed things: commit, then `worktree_merge({ target: "main" })`, then
   `worktree_remove({ branch, deleteBranch: true })`.

**New isolated feature**
1. `worktree_new({ name: "fix-login-cache" })` → path on `…/fix-login-cache`.
2. Work, commit. `worktree_merge({ target: "main", mode: "squash" })` → commit the squash.
3. `worktree_remove({ branch: "…/fix-login-cache", deleteBranch: true })`.

**Multi-repo task** — repeat per repo, passing `repo`:
`worktree_new({ name: "shared-change", repo: "/path/to/other-repo" })`.

## Rules

- Always `worktree_list` before `worktree_new` to avoid duplicate worktrees for a branch.
- Prefer `worktree_adopt` over `worktree_new` when the branch already exists.
- Commit or stash before `worktree_merge` (it refuses on a dirty tree).
- Clean up: `worktree_remove` once the work is integrated, so worktrees don't accumulate.
- Destructive git operations are still subject to the guardrails floor — a blocked op means
  ask before retrying, don't force around it.
