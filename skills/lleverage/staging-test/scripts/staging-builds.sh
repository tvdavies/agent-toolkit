#!/usr/bin/env bash
# Report (and optionally wait for) the Cloud Build staging builds of one commit.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: staging-builds.sh SHA [--wait MINUTES]

Lists the google-cloud-build check runs named "<service> (lleverage-staging)" on
SHA in lleverage-ai/lleverage, one "<status> <conclusion> <name>" line each.
With --wait, rechecks every 60 seconds (STAGING_POLL_SECONDS) until none is
still queued or in progress, or the minutes run out.

Exit 0  every build completed: success, neutral (nothing to build) or skipped
     1  at least one completed with failure, cancelled or timed out
     3  builds are still running (after --wait), or none has appeared yet
     2  error (GitHub unreadable)

A build cancelled because a newer staging push superseded it is "cancelled":
look at the newer head before treating it as a failure.

Environment: STAGING_REPO_SLUG (lleverage-ai/lleverage).
EOF
}

die() { echo "staging-builds: $*" >&2; exit 2; }

slug="${STAGING_REPO_SLUG:-lleverage-ai/lleverage}"
poll="${STAGING_POLL_SECONDS:-60}"
sha="" wait_minutes=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --wait) wait_minutes="$2"; shift 2 ;;
    -*) die "unknown option $1" ;;
    *) sha="$1"; shift ;;
  esac
done
[ -n "$sha" ] || die "give the staging commit SHA"

deadline=$(( $(date -u +%s) + wait_minutes * 60 ))
while :; do
  runs=$(gh api "repos/$slug/commits/$sha/check-runs?per_page=100" \
    --jq '[.check_runs[] | select(.app.slug == "google-cloud-build" and (.name | endswith("(lleverage-staging)")))]') \
    || die "cannot read check runs for $sha"
  total=$(jq length <<<"$runs")
  running=$(jq '[.[] | select(.status != "completed")] | length' <<<"$runs")
  if [ "$total" -gt 0 ] && [ "$running" -eq 0 ]; then break; fi
  [ "$(date -u +%s)" -lt "$deadline" ] || break
  sleep "$poll"
done

jq -r '.[] | "\(.status) \(.conclusion // "-") \(.name)"' <<<"$runs" | sort
if [ "$total" -eq 0 ] || [ "$running" -gt 0 ]; then
  echo "builds: $running of $total still running" >&2
  exit 3
fi
failed=$(jq '[.[] | select(.conclusion as $c | ["success", "neutral", "skipped"] | index($c) | not)] | length' <<<"$runs")
[ "$failed" -eq 0 ] || { echo "builds: $failed of $total did not succeed" >&2; exit 1; }
echo "builds: all $total completed" >&2
