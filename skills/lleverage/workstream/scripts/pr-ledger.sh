#!/usr/bin/env bash
# One ledger and one watcher for every PR a workstream owns, in any repository.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage (WS_DIR must point at the workstream state directory):
  pr-ledger.sh add OWNER/REPO PR TICKET [OWNER-AGENT]
  pr-ledger.sh owner OWNER/REPO PR OWNER-AGENT
  pr-ledger.sh remove OWNER/REPO PR
  pr-ledger.sh list              # fresh status line for every tracked PR
  pr-ledger.sh watch [--interval SECONDS] [--stale-minutes N]

watch prints one line per change, so run it under the Monitor tool:
  CHANGE   repo#n ticket owner <status>          status changed
  ATTENTION repo#n ticket owner <status> (Nm)   needs action and unchanged for N minutes
  MERGED   repo#n ticket owner <merge sha>       merged; dropped from the ledger
  CLOSED   repo#n ticket owner                   closed unmerged; dropped from the ledger
  ERROR    repo#n <message>                      could not read the PR (repeats are suppressed)

A PR needs action when CI failed, a review requested changes, a thread is unresolved,
it conflicts with its base, or it is approved and green but auto-merge is off.
Defaults: --interval 90, --stale-minutes 20.

GitHub access: when prwatch is on PATH (npm i -g @tvdavies/prwatch@^0.1.3; upgrade with
npm i -g @tvdavies/prwatch@latest && prwatch daemon restart), list reads every
PR with one `prwatch status --json` call and watch keeps one `prwatch events` stream
open across the ledger, waking on each change and re-reading status from prwatch's
shared cache at least every --interval seconds. Nothing here then polls GitHub
itself. Without prwatch, or with NO_PRWATCH=1, each PR is read with gh GraphQL every
--interval seconds.
EOF
}

die() { echo "pr-ledger: $*" >&2; exit 2; }
use_prwatch() { [ -z "${NO_PRWATCH:-}" ] && command -v prwatch >/dev/null 2>&1; }
command -v jq >/dev/null || die "jq not on PATH"
case "${1:-}" in -h|--help) usage; exit 0 ;; esac
use_prwatch || command -v gh >/dev/null || die "gh not on PATH (and prwatch is not installed)"
[ -n "${WS_DIR:-}" ] || die "set WS_DIR to the workstream state directory"
mkdir -p "$WS_DIR"
LEDGER="$WS_DIR/prs.tsv"
CACHE="$WS_DIR/.pr-status"
touch "$LEDGER"; mkdir -p "$CACHE"

key() { echo "${1//\//_}_$2"; }

# The status line, from a normalised object:
# {state, isDraft, head, ci, review, cr, threads, mergeable, auto, merge}
FMT='def fmt:
  (if .state != "OPEN" then "none"
   elif .isDraft then "none"
   elif .ci == "FAILURE" or .ci == "ERROR" then "ci-failed"
   elif .cr != "" then "changes-requested"
   elif .threads > 0 then "threads"
   elif .mergeable == "CONFLICTING" then "conflict"
   elif .review == "APPROVED" and .ci == "SUCCESS" and (.auto | not) then "approved-not-armed"
   else "none" end) as $need
  | "state=\(.state) head=\(.head[0:8]) ci=\(.ci) review=\(.review)"
    + (if .cr != "" then " changes-by=\(.cr)" else "" end)
    + " threads=\(.threads) mergeable=\(.mergeable) auto=\(if .auto then "on" else "off" end)"
    + (if .isDraft then " draft" else "" end)
    + " need=\($need)"
    + (if .state == "MERGED" then " merge=\((.merge // "")[0:10])" else "" end);'

# prwatch snapshot -> normalised status object.
FROM_PRWATCH='def norm: {
  state, isDraft, head: .headRefOid, ci: .checks.state, review: (.reviewDecision // "NONE"),
  cr: ([.reviews[] | select(.state == "CHANGES_REQUESTED") | .author] | unique | join(",")),
  threads: .threads.unresolved, mergeable, auto: .autoMerge.enabled, merge: .mergeCommit };'

status() { # repo pr -> one-line status via gh, or ERROR text on stderr with non-zero exit
  local repo="$1" pr="$2" out
  out="$(gh api graphql -F owner="${repo%/*}" -F name="${repo#*/}" -F n="$pr" -f query='
    query($owner:String!,$name:String!,$n:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$n){
      state isDraft headRefOid mergeable reviewDecision baseRefName
      mergeCommit{oid} autoMergeRequest{enabledAt}
      commits(last:1){nodes{commit{statusCheckRollup{state}}}}
      reviewThreads(first:100){nodes{isResolved}}
      latestReviews(first:20){nodes{state author{login}}}
    }}}' 2>&1)" || { echo "$out" | tail -1 | sed -E 's/.*"message":"([^"]*)".*/\1/' | cut -c1-200 >&2; return 1; }
  echo "$out" | jq -r "$FMT"'.data.repository.pullRequest
    | {state, isDraft, head: .headRefOid,
       ci: (.commits.nodes[0].commit.statusCheckRollup.state // "NONE"),
       review: (.reviewDecision // "NONE"),
       cr: ([.latestReviews.nodes[] | select(.state == "CHANGES_REQUESTED") | .author.login] | unique | join(",")),
       threads: ([.reviewThreads.nodes[] | select(.isResolved | not)] | length),
       mergeable, auto: (.autoMergeRequest != null), merge: .mergeCommit.oid}
    | fmt'
}

# Every ledger row as "repo<TAB>pr<TAB>ticket<TAB>owner<TAB>status", where status is
# a status line or "ERROR <message>". With prwatch this is one call for all PRs.
status_all() {
  local repo pr ticket owner s
  if ! use_prwatch; then
    while IFS=$'\t' read -r repo pr ticket owner _; do
      [ -n "$repo" ] || continue
      s="$(status "$repo" "$pr" 2>&1)" || s="ERROR $s"
      printf '%s\t%s\t%s\t%s\t%s\n' "$repo" "$pr" "$ticket" "$owner" "$s"
    done < "$LEDGER"
    return 0
  fi
  local refs=() out err line ref msg
  declare -A got=()
  while IFS=$'\t' read -r repo pr _; do
    [ -n "$repo" ] && refs+=("$repo#$pr")
  done < "$LEDGER"
  [ "${#refs[@]}" -gt 0 ] || return 0
  err="$(mktemp "${TMPDIR:-/tmp}/pr-ledger-err.XXXXXX")"
  # Exits non-zero when any PR failed; the others are still printed.
  out="$(prwatch status --json "${refs[@]}" 2>"$err")" || true
  if jq -e 'type == "array"' <<<"$out" >/dev/null 2>&1; then
    # Incomplete snapshots are partial data: leave them out so they report as errors.
    while IFS=$'\t' read -r ref line; do
      [ -n "$ref" ] && got["$ref"]="$line"
    done < <(jq -r "$FMT $FROM_PRWATCH"'.[] | select(.incomplete | not)
      | "\("\(.owner)/\(.repo)#\(.number)" | ascii_downcase)\t\(norm | fmt)"' <<<"$out")
  fi
  while IFS=$'\t' read -r repo pr ticket owner _; do
    [ -n "$repo" ] || continue
    ref="$repo#$pr"
    s="${got[${ref,,}]:-}"
    if [ -z "$s" ]; then
      msg="$(grep -iF -- "$ref" "$err" | head -1 || true)"
      [ -n "$msg" ] || msg="$(head -1 "$err")"
      [ -n "$msg" ] || msg="no snapshot from prwatch"
      s="ERROR $(sed -E 's/^prwatch: //' <<<"$msg" | cut -c1-200)"
    fi
    printf '%s\t%s\t%s\t%s\t%s\n' "$repo" "$pr" "$ticket" "$owner" "$s"
  done < "$LEDGER"
  rm -f "$err"
}

# One pass over the ledger: print CHANGE/ATTENTION/MERGED/CLOSED/ERROR lines.
watch_pass() {
  local now rows repo pr ticket owner s k since age
  now="$(date +%s)"
  rows="$(status_all)"
  while IFS=$'\t' read -r repo pr ticket owner s; do
    [ -n "$repo" ] || continue
    k="$CACHE/$(key "$repo" "$pr")"
    if [[ "$s" == "ERROR "* ]]; then
      s="${s#ERROR }"
      [ "$(cat "$k.err" 2>/dev/null)" = "$s" ] || { echo "ERROR $repo#$pr $s"; echo "$s" > "$k.err"; }
      continue
    fi
    rm -f "$k.err"
    case "$s" in
      state=MERGED*)
        echo "MERGED $repo#$pr $ticket $owner ${s##*merge=}"
        "$0" remove "$repo" "$pr" >/dev/null; continue ;;
      state=CLOSED*)
        echo "CLOSED $repo#$pr $ticket $owner"
        "$0" remove "$repo" "$pr" >/dev/null; continue ;;
    esac
    if [ "$(cat "$k.status" 2>/dev/null)" != "$s" ]; then
      echo "CHANGE $repo#$pr $ticket $owner $s"
      echo "$s" > "$k.status"; echo "$now" > "$k.since"; rm -f "$k.flagged"
    elif [[ "$s" != *need=none* ]] && [ ! -e "$k.flagged" ]; then
      since="$(cat "$k.since" 2>/dev/null || echo "$now")"
      age=$(( (now - since) / 60 ))
      if [ "$age" -ge "$stale" ]; then
        echo "ATTENTION $repo#$pr $ticket $owner $s (${age}m)"; touch "$k.flagged"
      fi
    fi
  done <<<"$rows"
}

# watch with prwatch: one events stream across the ledger PRs (minus any that just
# failed, which would end the stream) wakes a pass on every change. Its output is
# only a wake-up; each pass re-reads every PR from prwatch's cache.
EV_PID=""
EV_FIFO=""
stop_events() {
  if [ -n "$EV_PID" ]; then kill "$EV_PID" 2>/dev/null || true; wait "$EV_PID" 2>/dev/null || true; EV_PID=""; fi
}
watch_prwatch() {
  local evfd ev_set="" want line settle args
  EV_FIFO="$(mktemp -u "${TMPDIR:-/tmp}/pr-ledger-events.XXXXXX")"
  mkfifo -m 600 "$EV_FIFO"
  exec {evfd}<>"$EV_FIFO"
  trap 'stop_events; rm -f "$EV_FIFO"' EXIT
  trap 'exit 130' INT TERM
  while :; do
    watch_pass
    want="$(while IFS=$'\t' read -r repo pr _; do
        if [ -n "$repo" ] && [ ! -e "$CACHE/$(key "$repo" "$pr").err" ]; then echo "$repo#$pr"; fi
      done < "$LEDGER" | sort -u)"
    if [ "$want" != "$ev_set" ] || { [ -n "$EV_PID" ] && ! kill -0 "$EV_PID" 2>/dev/null; }; then
      stop_events
      ev_set="$want"
      if [ -n "$want" ]; then
        args=()
        while read -r line; do args+=(--pr "$line"); done <<<"$want"
        prwatch events --json "${args[@]}" 1>&"$evfd" 2>>"$CACHE/.events.err" &
        EV_PID=$!
      fi
    fi
    if read -r -t "$interval" -u "$evfd" line; then
      # Coalesce a burst into one pass, but never delay the pass by more than ~2s.
      settle=$(( $(date +%s) + 1 ))
      while [ "$(date +%s)" -le "$settle" ] && read -r -t 1 -u "$evfd" line; do :; done
    fi
  done
}

cmd="${1:-}"; [ -n "$cmd" ] || { usage >&2; exit 2; }; shift
case "$cmd" in
  add)
    [ "$#" -ge 3 ] || die "add OWNER/REPO PR TICKET [OWNER-AGENT]"
    repo="$1"; pr="${2#\#}"; ticket="$3"; owner="${4:--}"
    awk -F'\t' -v r="$repo" -v p="$pr" '!($1 == r && $2 == p)' "$LEDGER" > "$LEDGER.tmp"
    printf '%s\t%s\t%s\t%s\t%s\n' "$repo" "$pr" "$ticket" "$owner" "$(date -u +%FT%TZ)" >> "$LEDGER.tmp"
    mv "$LEDGER.tmp" "$LEDGER"
    echo "tracking $repo#$pr ($ticket, owner $owner)" ;;
  owner)
    [ "$#" -eq 3 ] || die "owner OWNER/REPO PR OWNER-AGENT"
    awk -F'\t' -v OFS='\t' -v r="$1" -v p="${2#\#}" -v o="$3" '$1 == r && $2 == p {$4 = o} 1' "$LEDGER" > "$LEDGER.tmp"
    mv "$LEDGER.tmp" "$LEDGER" ;;
  remove)
    [ "$#" -eq 2 ] || die "remove OWNER/REPO PR"
    awk -F'\t' -v r="$1" -v p="${2#\#}" '!($1 == r && $2 == p)' "$LEDGER" > "$LEDGER.tmp"
    mv "$LEDGER.tmp" "$LEDGER"; rm -f "$CACHE/$(key "$1" "${2#\#}")".* ;;
  list)
    status_all | while IFS=$'\t' read -r repo pr ticket owner st; do
      printf '%s#%s\t%s\t%s\t%s\n' "$repo" "$pr" "$ticket" "$owner" "$st"
    done ;;
  watch)
    interval=90; stale=20
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --interval) interval="$2"; shift 2 ;;
        --stale-minutes) stale="$2"; shift 2 ;;
        *) die "unknown option $1" ;;
      esac
    done
    [[ "$interval" =~ ^[1-9][0-9]*$ ]] || die "--interval must be a positive integer"
    [[ "$stale" =~ ^[0-9]+$ ]] || die "--stale-minutes must be a non-negative integer"
    if use_prwatch; then watch_prwatch; fi
    while :; do
      watch_pass
      sleep "$interval"
    done ;;
  *) die "unknown command $cmd" ;;
esac
