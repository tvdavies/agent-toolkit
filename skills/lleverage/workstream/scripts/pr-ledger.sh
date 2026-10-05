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
EOF
}

die() { echo "pr-ledger: $*" >&2; exit 2; }
for c in gh jq; do command -v "$c" >/dev/null || die "$c not on PATH"; done
[ -n "${WS_DIR:-}" ] || die "set WS_DIR to the workstream state directory"
mkdir -p "$WS_DIR"
LEDGER="$WS_DIR/prs.tsv"
CACHE="$WS_DIR/.pr-status"
touch "$LEDGER"; mkdir -p "$CACHE"

key() { echo "${1//\//_}_$2"; }

status() { # repo pr -> one-line status, or ERROR text on stderr with non-zero exit
  local repo="$1" pr="$2" out
  out="$(gh api graphql -F owner="${repo%/*}" -F name="${repo#*/}" -F n="$pr" -f query='
    query($owner:String!,$name:String!,$n:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$n){
      state isDraft headRefOid mergeable reviewDecision baseRefName
      mergeCommit{oid} autoMergeRequest{enabledAt}
      commits(last:1){nodes{commit{statusCheckRollup{state}}}}
      reviewThreads(first:100){nodes{isResolved}}
      latestReviews(first:20){nodes{state author{login}}}
    }}}' 2>&1)" || { echo "$out" | tail -1 | sed -E 's/.*"message":"([^"]*)".*/\1/' | cut -c1-200 >&2; return 1; }
  echo "$out" | jq -r '.data.repository.pullRequest
    | (.commits.nodes[0].commit.statusCheckRollup.state // "NONE") as $ci
    | ([.reviewThreads.nodes[] | select(.isResolved | not)] | length) as $threads
    | ([.latestReviews.nodes[] | select(.state == "CHANGES_REQUESTED") | .author.login] | unique | join(",")) as $cr
    | (if .state != "OPEN" then "none"
       elif .isDraft then "none"
       elif $ci == "FAILURE" or $ci == "ERROR" then "ci-failed"
       elif $cr != "" then "changes-requested"
       elif $threads > 0 then "threads"
       elif .mergeable == "CONFLICTING" then "conflict"
       elif .reviewDecision == "APPROVED" and $ci == "SUCCESS" and .autoMergeRequest == null then "approved-not-armed"
       else "none" end) as $need
    | "state=\(.state) head=\(.headRefOid[0:8]) ci=\($ci) review=\(.reviewDecision // "NONE")"
      + (if $cr != "" then " changes-by=\($cr)" else "" end)
      + " threads=\($threads) mergeable=\(.mergeable) auto=\(if .autoMergeRequest then "on" else "off" end)"
      + (if .isDraft then " draft" else "" end)
      + " need=\($need)"
      + (if .state == "MERGED" then " merge=\(.mergeCommit.oid[0:10])" else "" end)'
}

cmd="${1:-}"; [ -n "$cmd" ] || { usage >&2; exit 2; }; shift
case "$cmd" in
  -h|--help) usage ;;
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
    while IFS=$'\t' read -r repo pr ticket owner _; do
      [ -n "$repo" ] || continue
      s="$(status "$repo" "$pr" 2>&1)" || s="ERROR $s"
      printf '%s#%s\t%s\t%s\t%s\n' "$repo" "$pr" "$ticket" "$owner" "$s"
    done < "$LEDGER" ;;
  watch)
    interval=90; stale=20
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --interval) interval="$2"; shift 2 ;;
        --stale-minutes) stale="$2"; shift 2 ;;
        *) die "unknown option $1" ;;
      esac
    done
    while :; do
      now="$(date +%s)"
      while IFS=$'\t' read -r repo pr ticket owner _; do
        [ -n "$repo" ] || continue
        k="$CACHE/$(key "$repo" "$pr")"
        if ! s="$(status "$repo" "$pr" 2>&1)"; then
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
      done < "$LEDGER"
      sleep "$interval"
    done ;;
  *) die "unknown command $cmd" ;;
esac
