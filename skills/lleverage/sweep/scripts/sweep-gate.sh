#!/usr/bin/env bash
# The continuous sweep's gate: a cheap check with no model that decides whether a sweep should start.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sweep-gate.sh [--team LLE] [--max 5] [--state FILE] [--docket DIR] [--dry-run]

Runs the sweep's own queue (linear-queue.sh cycle --all-assignees) and Sal's Docket
workspace, then exits with Sal's check contract:

  0  nothing to start. Standard output says why: a sweep is still in flight, an
     Urgent incident is open, or there is nothing to work on.
  3  start a sweep. Standard output is {"findings": [one finding]}:
       cycle-sweep:deliver:<hash>  up to --max ready tickets, for yolo-ticket
       cycle-sweep:prepare:<hash>  up to --max unready tickets, for prepare-ticket,
                                   only when no ticket is ready
     The finding's "tickets" list is the pick, best first.
  2  the gate could not decide (Linear, GitHub or Docket unreadable).

A ticket is eligible when all of these hold:
  - it is open in the team's active cycle, in an unstarted or backlog state;
  - linear-queue's verdict is eligible: not started, no started ancestor, no open
    PR mentioning it, no open blocker, no open children;
  - no ancestor is open at all (the parent tree, not the Linear project);
  - it is unassigned or assigned to the Linear user the CLI acts as (Tom);
  - its size is XS, S or M, or not yet known (L and XL are never swept);
  - no open Docket task in the workspace names it (another task has it), and no
    sweep task for it was updated in the last --recent-days (default 3).
It is ready when prepare-ticket's "**Status:** Ready" line is on it and its size
is known. Human Required tickets are in a started state, so they are never
eligible and never prepared again.

A sweep is in flight while any "Cycle sweep: ..." task is assigned to the worker
in the ready or in-progress lane and was updated in the last --stale-hours (12).

Fingerprint: when no ticket is ready, the gate hashes the sorted IDs of every
unready eligible ticket. It raises a prepare sweep only when that hash differs
from the one it last raised for, and records it in the state file, so a sweep
that changed nothing is not repeated until the set changes. --dry-run records
nothing.
EOF
}

die() { echo "sweep-gate: $*" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
queue="${SWEEP_QUEUE:-$here/../../workstream/scripts/linear-queue.sh}"
team="LLE"; max=5; dry=false; recent_days=3; stale_hours=12
state="${XDG_STATE_HOME:-$HOME/.local/state}/sweep/gate-state.json"
docket_home="${SWEEP_DOCKET_HOME:-$HOME/docket/dev}"
docket="${DOCKET_BIN:-docket}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --team) team="$2"; shift 2 ;;
    --max) max="$2"; shift 2 ;;
    --state) state="$2"; shift 2 ;;
    --docket) docket_home="$2"; shift 2 ;;
    --recent-days) recent_days="$2"; shift 2 ;;
    --stale-hours) stale_hours="$2"; shift 2 ;;
    --dry-run) dry=true; shift ;;
    *) die "unknown option $1" ;;
  esac
done
for c in jq sha256sum "$docket"; do command -v "$c" >/dev/null || die "$c not on PATH"; done
[ -x "$queue" ] || [ -f "$queue" ] || die "queue script not found: $queue"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
now="$(date -u +%s)"

idle() { # reason, extra JSON
  local extra="${2:-}"
  [ -n "$extra" ] || extra='{}'
  jq -cn --arg reason "$1" --argjson extra "$extra" \
    '{status: "idle", reason: $reason, sources: {linear: "ok", docket: "ok"}} + $extra'
  exit 0
}

# 1. Docket: open incidents, sweeps in flight and tickets other tasks already have.
(cd "$docket_home" && "$docket" list --json --compact) > "$tmp/docket.json" 2> "$tmp/docket.err" \
  || die "could not list Docket tasks in $docket_home: $(head -c 300 "$tmp/docket.err")"
jq -e 'type == "array"' "$tmp/docket.json" >/dev/null || die "docket list did not return a list"

jq -c --argjson now "$now" --argjson recent "$((recent_days * 86400))" --argjson stale "$((stale_hours * 3600))" '
  def age: (.updated_at // "1970-01-01T00:00:00Z" | sub("\\.[0-9]+"; "") | fromdateiso8601) as $t | $now - $t;
  def ids: [.title | scan("\\b[A-Z][A-Z0-9]*-[0-9]+\\b")];
  def sweep: .title | test("^Cycle sweep: (deliver|prepare) ");
  # Sal counts a task open unless it is done, in its completed lane (in-review) or its failed lane (blocked).
  def open: (.status | IN("done", "in-review", "blocked")) | not;
  {
    urgent: [.[] | select(open and ((.labels // []) | any(. == "urgent" or . == "sev1"))) | .id],
    inFlight: [.[] | select(sweep and .assignee == "worker" and (.status | IN("ready", "in-progress")) and age < $stale)
               | {task: .id, title}],
    taken: ([.[] | select((.status | IN("ready", "in-progress")) and age < $recent) | ids[]]
            + [.[] | select(sweep and .status != "done" and age < $recent) | ids[]]) | unique,
    swept: [.[] | select(sweep and age < $recent) | ids[]] | unique
  }' "$tmp/docket.json" > "$tmp/docket-view.json"

urgent="$(jq -r '.urgent | join(", ")' "$tmp/docket-view.json")"
[ -z "$urgent" ] || idle "an Urgent incident is open ($urgent); sweeps wait until it is closed"
if [ "$(jq '.inFlight | length' "$tmp/docket-view.json")" -gt 0 ]; then
  idle "a sweep is in flight: $(jq -r '[.inFlight[].task] | join(", ")' "$tmp/docket-view.json")" "$(jq -c '{inFlight}' "$tmp/docket-view.json")"
fi

# 2. The sweep's queue.
bash "$queue" cycle --team "$team" --all-assignees --json > "$tmp/queue.jsonl" 2> "$tmp/queue.err" \
  || die "linear-queue.sh failed: $(head -c 300 "$tmp/queue.err")"

jq -sc --slurpfile d "$tmp/docket-view.json" '
  # Priority (Linear 1 urgent .. 4 low; 0, no priority, last), then smaller first, then older first.
  def rank: [(if .priority == 0 then 5 else .priority end), ({"XS": 0, "S": 1, "M": 2}[.size // ""] // 3), (.id | sub("^[A-Z0-9]+-"; "") | tonumber)];
  def pick: {id, title, url, priority, size, state, assignee, prepared};
  ($d[0].taken) as $taken | ($d[0].swept) as $swept
  | [.[] | select(
      .verdict == "eligible"
      and (.stateType | IN("unstarted", "backlog"))
      and (.openAncestor | not)
      and (.assignee == null or .assignedToMe)
      and (.size == null or (.size | IN("XS", "S", "M")))
      and (.id | IN($taken[]) | not))] as $eligible
  | ($eligible | map(select(.size != null and ((.prepared // "") | ascii_downcase) == "ready")) | sort_by(rank)) as $ready
  | ($eligible | map(select((.size != null and ((.prepared // "") | ascii_downcase) == "ready") | not)) | sort_by(rank)) as $unready
  | {
      eligible: ($eligible | length),
      ready: [$ready[] | pick],
      unready: [$unready[] | pick],
      # Tickets a recent sweep already prepared are not prepared again until --recent-days pass.
      preparable: [$unready[] | select(.id | IN($swept[]) | not) | pick]
    }' "$tmp/queue.jsonl" > "$tmp/sets.json"

ready_n="$(jq '.ready | length' "$tmp/sets.json")"
unready_ids="$(jq -r '[.preparable[].id] | sort | join(" ")' "$tmp/sets.json")"
counts="$(jq -c '{eligible, ready: (.ready | length), unready: (.unready | length), preparable: (.preparable | length)}' "$tmp/sets.json")"

finding() { # mode, key hash, summary
  jq -c --arg mode "$1" --arg key "cycle-sweep:$1:$2" --arg summary "$3" --argjson max "$max" --argjson counts "$counts" \
    '{findings: [{key: $key, severity: "info", summary: $summary, mode: $mode,
                  tickets: (if $mode == "deliver" then .ready else .preparable end)[0:$max]}],
      counts: $counts, sources: {linear: "ok", docket: "ok"}}' "$tmp/sets.json"
  exit 3
}
hash() { printf '%s' "$1" | sha256sum | cut -c1-12; }

if [ "$ready_n" -gt 0 ]; then
  picked="$(jq -r --argjson max "$max" '[.ready[0:$max][].id] | join(" ")' "$tmp/sets.json")"
  finding deliver "$(hash "$picked")" "Deliver $picked: ready, eligible cycle tickets for yolo-ticket ($ready_n ready)"
fi

[ -n "$unready_ids" ] || idle "nothing to work on: no eligible ticket is ready or left to prepare" "{\"counts\": $counts}"

fingerprint="$(hash "$unready_ids")"
last="$(jq -r '.idleFingerprint // ""' "$state" 2>/dev/null || true)"
if [ "$fingerprint" = "$last" ]; then
  idle "nothing to work on: the unready eligible tickets are unchanged since the last sweep ($fingerprint)" "{\"counts\": $counts}"
fi
if ! $dry; then
  mkdir -p "$(dirname "$state")"
  jq -n --arg fp "$fingerprint" --arg ids "$unready_ids" --arg at "$(date -u +%FT%TZ)" \
    '{idleFingerprint: $fp, recordedAt: $at, unready: ($ids | split(" "))}' > "$state.tmp"
  mv "$state.tmp" "$state"
fi
picked="$(jq -r --argjson max "$max" '[.preparable[0:$max][].id] | join(" ")' "$tmp/sets.json")"
finding prepare "$fingerprint" "Prepare $picked: nothing is ready, so get unready eligible cycle tickets ready ($(jq '.preparable | length' "$tmp/sets.json") unready)"
