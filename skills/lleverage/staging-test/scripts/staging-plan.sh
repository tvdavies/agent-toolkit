#!/usr/bin/env bash
# Decide how a change gets onto lleverage `staging` for a test: which tier applies
# now, or why to wait or defer. Read-only: it fetches and trial-merges, never pushes.
# The output keys are read indirectly ("${!k}"), which shellcheck can't see.
# shellcheck disable=SC2034
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: staging-plan.sh (--ref REF | --pr N) [--repo DIR] [--mine SHA]... [--wait MINUTES]
                       [--json] [--no-fetch]

Run it in a checkout of lleverage-ai/lleverage (default: the current directory).
It fetches origin/main and origin/staging (and refs/pull/N/head for --pr), then
prints one verdict and the measurements behind it, as key=value lines (or one
JSON object with --json). Exit 0 whenever it reached a verdict, 2 on an error.

Verdicts, checked in this order:
  defer               a deploy freeze is active on staging, or the freeze state
                      can't be read; or staging was still busy after --wait
  wait                staging is busy: a push in the last 30 minutes that isn't
                      one of yours (--mine), the push history can't be read, or
                      Cloud Build staging builds are still running on its head
  already-on-staging  REF is already contained in staging
  update-branch       REF doesn't merge cleanly into origin/main; bring the PR
                      branch up to date first (this isn't a staging problem)
  merge-as-is         tier 1: staging is not badly out of date and REF merges
                      into it with no conflicts
  merge-main-first    tier 2: origin/main merges into staging with no conflicts
                      and REF then merges with no conflicts
  merge-main-first-resolve
                      tier 2 with a few conflicts to resolve by hand: at most 3
                      files and 5 conflict hunks, none in a lockfile, a
                      migration, a Prisma schema or SQL
  reset-needed        tier 3: none of the above. Staging would have to be reset
                      to origin/main, which needs Tom's approval each time

Thresholds (fixed; the environment overrides exist for tests):
  badly out of date   staging lacks >= 100 commits of origin/main
                      (STAGING_MAX_BEHIND), or the oldest main commit it lacks is
                      >= 24 hours old (STAGING_MAX_AGE_HOURS)
  too many conflicts  > 3 conflicted files (STAGING_MAX_CONFLICT_FILES), > 5
                      conflict hunks (STAGING_MAX_CONFLICT_HUNKS), or any conflict
                      in a protected path
  busy                a push within 30 minutes (STAGING_QUIET_MINUTES)

--mine SHA   a staging head you pushed yourself; your own push and its builds
             don't count as someone else's activity. Repeatable.
--wait N     while the verdict is wait, recheck every 5 minutes
             (STAGING_POLL_SECONDS) for up to N minutes; if still busy, the
             verdict becomes defer.

Environment: STAGING_REPO_SLUG (lleverage-ai/lleverage), STAGING_REMOTE (origin),
STAGING_FREEZE_CMD (the deploy-freeze skill's `status --env staging`).
EOF
}

die() { echo "staging-plan: $*" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
slug="${STAGING_REPO_SLUG:-lleverage-ai/lleverage}"
remote="${STAGING_REMOTE:-origin}"
max_behind="${STAGING_MAX_BEHIND:-100}"
max_age_hours="${STAGING_MAX_AGE_HOURS:-24}"
max_files="${STAGING_MAX_CONFLICT_FILES:-3}"
max_hunks="${STAGING_MAX_CONFLICT_HUNKS:-5}"
quiet_minutes="${STAGING_QUIET_MINUTES:-30}"
poll_seconds="${STAGING_POLL_SECONDS:-300}"
freeze_cmd="${STAGING_FREEZE_CMD:-$here/../../deploy-freeze/scripts/deploy-freeze.sh status --env staging}"
protected_re='(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|schema\.prisma)$|(^|/)migrations?/|\.sql$'

ref="" pr="" repo="." json=false fetch=true wait_minutes=0
mine=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --ref) ref="$2"; shift 2 ;;
    --pr) pr="$2"; shift 2 ;;
    --repo) repo="$2"; shift 2 ;;
    --mine) mine+=("$2"); shift 2 ;;
    --wait) wait_minutes="$2"; shift 2 ;;
    --json) json=true; shift ;;
    --no-fetch) fetch=false; shift ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done
[ -n "$ref" ] || [ -n "$pr" ] || die "give --ref REF or --pr N"
[[ "$wait_minutes" =~ ^[0-9]+$ ]] || die "--wait takes whole minutes"
cd "$repo"
git rev-parse --git-dir >/dev/null 2>&1 || die "$repo is not a git repository"

if $fetch; then
  specs=("+refs/heads/main:refs/remotes/$remote/main" "+refs/heads/staging:refs/remotes/$remote/staging")
  [ -n "$pr" ] && specs+=("+refs/pull/$pr/head:refs/remotes/$remote/pr/$pr")
  git fetch --quiet "$remote" "${specs[@]}" || die "git fetch from $remote failed"
fi
[ -n "$pr" ] && [ -z "$ref" ] && ref="refs/remotes/$remote/pr/$pr"

main=$(git rev-parse --verify --quiet "refs/remotes/$remote/main^{commit}") || die "no $remote/main"
staging=$(git rev-parse --verify --quiet "refs/remotes/$remote/staging^{commit}") || die "no $remote/staging"
change=$(git rev-parse --verify --quiet "$ref^{commit}") || die "cannot resolve $ref"

is_mine() { local s; for s in "${mine[@]+"${mine[@]}"}"; do [ "$s" = "$1" ] && return 0; done; return 1; }

# Trial merge of two commits without touching any worktree. Sets m_tree, m_files
# (newline-separated conflicted paths), m_count, m_hunks and m_protected.
trial() {
  local out status=0 f n
  out=$(git merge-tree --write-tree --name-only --no-messages "$1" "$2") || status=$?
  [ "$status" -le 1 ] || die "git merge-tree failed for $1 $2"
  m_tree=$(head -n1 <<<"$out")
  m_files=$(tail -n +2 <<<"$out" | sed '/^$/d' | sort -u)
  m_count=0 m_hunks=0 m_protected=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    m_count=$((m_count + 1))
    n=$(git cat-file -p "$m_tree:$f" 2>/dev/null | grep -c '^<<<<<<< ' || true)
    [ "${n:-0}" -ge 1 ] || n=1   # a modify/delete or binary conflict has no markers
    m_hunks=$((m_hunks + n))
    if grep -Eq "$protected_re" <<<"$f"; then m_protected="${m_protected:+$m_protected,}$f"; fi
  done <<<"$m_files"
}

# Gates: freeze, recent push, running builds.
gate() {
  local out
  if out=$(bash -c "$freeze_cmd" 2>/dev/null); then
    if grep -qw FROZEN <<<"$out"; then freeze=frozen; else freeze=live; fi
  else
    freeze=unknown
  fi

  last_push="" last_push_minutes="" last_push_sha="" last_push_actor="" push_readable=true
  if out=$(gh api "repos/$slug/activity?ref=refs/heads/staging&per_page=1" \
      --jq '.[0] | [.timestamp, .after, .actor.login] | @tsv' 2>/dev/null) && [ -n "$out" ]; then
    IFS=$'\t' read -r last_push last_push_sha last_push_actor <<<"$out"
    local then_s now_s
    then_s=$(date -u -d "$last_push" +%s 2>/dev/null) || push_readable=false
    now_s=$(date -u +%s)
    $push_readable && last_push_minutes=$(( (now_s - then_s) / 60 ))
  else
    push_readable=false
  fi

  builds_running=0 builds_readable=true
  if out=$(gh api "repos/$slug/commits/$staging/check-runs?per_page=100" \
      --jq '[.check_runs[] | select(.app.slug == "google-cloud-build" and (.name | endswith("(lleverage-staging)")) and .status != "completed")] | length' 2>/dev/null); then
    builds_running=${out:-0}
  else
    builds_readable=false
  fi

  busy_reason=""
  if ! $push_readable; then
    busy_reason="staging push history unreadable"
  elif [ "$last_push_minutes" -lt "$quiet_minutes" ] && ! is_mine "$last_push_sha"; then
    busy_reason="staging was pushed ${last_push_minutes} min ago by ${last_push_actor:-someone}"
  elif ! is_mine "$staging"; then
    if ! $builds_readable; then busy_reason="staging build state unreadable"
    elif [ "$builds_running" -gt 0 ]; then busy_reason="$builds_running staging build(s) still running"
    fi
  fi
}

# With --wait, recheck a busy staging every poll interval until the budget is spent.
rechecks=0
[ "$wait_minutes" -gt 0 ] && [ "$poll_seconds" -gt 0 ] && rechecks=$(( wait_minutes * 60 / poll_seconds ))
started=$(date -u +%s)
while :; do
  gate
  [ "$freeze" = live ] && [ -n "$busy_reason" ] && [ "$rechecks" -gt 0 ] || break
  echo "staging-plan: $busy_reason; rechecking in ${poll_seconds}s" >&2
  sleep "$poll_seconds"
  rechecks=$((rechecks - 1))
  if $fetch; then
    git fetch --quiet "$remote" "+refs/heads/staging:refs/remotes/$remote/staging" || die "git fetch failed"
    staging=$(git rev-parse "refs/remotes/$remote/staging^{commit}")
  fi
done
waited=$(( ($(date -u +%s) - started) / 60 ))

# Measurements.
behind=$(git rev-list --count "$staging..$main")
staging_only=$(git rev-list --count --no-merges "$main..$staging")
behind_age_hours=0
if [ "$behind" -gt 0 ]; then
  oldest=$(git log --format=%ct "$staging..$main" | sort -n | head -n1)
  behind_age_hours=$(( ($(date -u +%s) - oldest) / 3600 ))
fi
badly=false
{ [ "$behind" -ge "$max_behind" ] || [ "$behind_age_hours" -ge "$max_age_hours" ]; } && badly=true

# At most 10 paths, comma-separated, with a count of the rest.
list() {
  local n s; n=$(sed '/^$/d' <<<"$1" | wc -l)
  s=$(sed '/^$/d' <<<"$1" | head -n 10 | paste -sd, -)
  [ "$n" -le 10 ] || s="$s (+$((n - 10)) more)"
  printf '%s' "$s"
}

trial "$main" "$change"; change_main_conflicts=$m_count
trial "$staging" "$change"; t1_conflicts=$m_count; t1_files=$(list "$m_files")
trial "$staging" "$main"
main_conflicts=$m_count main_hunks=$m_hunks main_files=$(list "$m_files") main_protected=$m_protected
t2_change_conflicts=unknown
if [ "$main_conflicts" -eq 0 ]; then
  # A local, unreferenced trial commit; it is never pushed.
  merged=$(GIT_AUTHOR_NAME=staging-plan GIT_AUTHOR_EMAIL=staging-plan@localhost \
    GIT_COMMITTER_NAME=staging-plan GIT_COMMITTER_EMAIL=staging-plan@localhost \
    git -c commit.gpgsign=false commit-tree "$m_tree" -p "$staging" -p "$main" -m "staging-plan trial")
  trial "$merged" "$change"; t2_change_conflicts=$m_count
fi

# Verdict.
if [ "$freeze" = frozen ]; then
  verdict=defer reason="a deploy freeze is active on staging"
elif [ "$freeze" = unknown ]; then
  verdict=defer reason="the staging deploy-freeze state could not be read"
elif [ -n "$busy_reason" ]; then
  if [ "$wait_minutes" -gt 0 ]; then
    verdict=defer reason="$busy_reason, still after waiting ${waited} min"
  else
    verdict=wait reason="$busy_reason"
  fi
elif git merge-base --is-ancestor "$change" "$staging"; then
  verdict=already-on-staging reason="the change is already contained in staging"
elif [ "$change_main_conflicts" -gt 0 ]; then
  verdict=update-branch reason="the change conflicts with origin/main in $change_main_conflicts file(s)"
elif ! $badly && [ "$t1_conflicts" -eq 0 ]; then
  verdict=merge-as-is reason="staging is $behind commits / ${behind_age_hours}h behind main and the change merges cleanly"
elif [ "$main_conflicts" -eq 0 ] && [ "$t2_change_conflicts" = 0 ]; then
  verdict=merge-main-first reason="main merges into staging cleanly, then the change merges cleanly"
elif [ "$main_conflicts" -gt 0 ] && [ "$main_conflicts" -le "$max_files" ] && [ "$main_hunks" -le "$max_hunks" ] && [ -z "$main_protected" ]; then
  verdict=merge-main-first-resolve reason="main conflicts with staging in $main_conflicts file(s), $main_hunks hunk(s): within the limit to resolve by hand"
else
  if [ "$main_conflicts" -eq 0 ]; then
    reason="main merges cleanly but the change then conflicts with staging-only work in $t2_change_conflicts file(s)"
  elif [ -n "$main_protected" ]; then
    reason="merging main conflicts in protected path(s): $main_protected"
  else
    reason="merging main conflicts in $main_conflicts file(s), $main_hunks hunk(s): over the limit of $max_files files / $max_hunks hunks"
  fi
  verdict=reset-needed
fi

keys=(verdict reason staging main change behind behind_age_hours staging_only badly_out_of_date
  t1_conflicts t1_files main_conflicts main_hunks main_files main_protected t2_change_conflicts
  change_main_conflicts freeze last_push last_push_minutes last_push_actor builds_running waited_minutes)
badly_out_of_date=$badly waited_minutes=$waited
if $json; then
  args=()
  for k in "${keys[@]}"; do args+=(--arg "$k" "${!k-}"); done
  jq -n "${args[@]}" '$ARGS.named'
else
  for k in "${keys[@]}"; do printf '%s=%s\n' "$k" "${!k-}"; done
fi
