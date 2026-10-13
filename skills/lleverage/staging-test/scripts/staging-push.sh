#!/usr/bin/env bash
# Push a prepared staging merge as a fast-forward of the staging head you planned
# against. Never forces, never pushes any branch but staging.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: staging-push.sh --expect-staging SHA [--dir DIR] [--dry-run]

Run it in the worktree where you merged the change (or main, then the change)
on top of origin/staging (--dir, default the current directory). It refuses
unless all of these hold, then runs `git push <remote> HEAD:refs/heads/staging`
with no force:

  - the remote's staging head is still SHA, the head staging-plan.sh planned
    against (someone else pushed meanwhile otherwise: plan again);
  - HEAD is a descendant of SHA and differs from it (a fast-forward);
  - the worktree has no uncommitted changes and no unmerged paths;
  - no file changed since SHA still holds a conflict marker line.

On success it prints old=<SHA> and new=<HEAD> for the ticket comment.
Exit 0 pushed (or would push, with --dry-run), 1 refused, 2 error.

Environment: STAGING_REMOTE (origin).
EOF
}

die() { echo "staging-push: $*" >&2; exit 2; }
refuse() { echo "staging-push: refused: $*" >&2; exit 1; }

remote="${STAGING_REMOTE:-origin}"
expect="" dir="." dry=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --expect-staging) expect="$2"; shift 2 ;;
    --dir) dir="$2"; shift 2 ;;
    --dry-run) dry=true; shift ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done
[ -n "$expect" ] || die "--expect-staging SHA is required"
cd "$dir"
git rev-parse --git-dir >/dev/null 2>&1 || die "$dir is not a git repository"

expect=$(git rev-parse --verify --quiet "$expect^{commit}") || die "unknown commit $expect"
head=$(git rev-parse HEAD)

remote_staging=$(git ls-remote "$remote" refs/heads/staging | cut -f1)
[ -n "$remote_staging" ] || die "cannot read $remote staging"
[ "$remote_staging" = "$expect" ] || refuse "$remote staging is now $remote_staging, not $expect; run staging-plan.sh again"
[ "$head" != "$expect" ] || refuse "HEAD is the staging head already; nothing to push"
git merge-base --is-ancestor "$expect" "$head" || refuse "HEAD does not descend from $expect, so the push would not be a fast-forward"
[ -z "$(git ls-files --unmerged)" ] || refuse "unmerged paths remain"
[ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "uncommitted changes in the worktree"

markers=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if git show "HEAD:$f" 2>/dev/null | grep -Eq '^(<<<<<<<|>>>>>>>) |^=======$'; then
    # Only a file whose markers are new since the planned head counts.
    if ! git show "$expect:$f" 2>/dev/null | grep -Eq '^(<<<<<<<|>>>>>>>) '; then markers="$markers $f"; fi
  fi
done < <(git diff --name-only --diff-filter=AM "$expect" "$head")
[ -z "$markers" ] || refuse "conflict markers left in:$markers"

if $dry; then
  echo "dry-run: would push $head to $remote staging (fast-forward from $expect)"
else
  git push "$remote" "$head:refs/heads/staging"
fi
echo "old=$expect"
echo "new=$head"
