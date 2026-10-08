#!/usr/bin/env bash
# Run every prod-health check in parallel, compare with the baseline, and print a
# compact report. Read-only; unreachable sources are reported and skipped.
# Usage: prod-health.sh [--env production|staging] [--window 30m] [--end ISO]
#                       [--json] [--only a,b] [--skip a,b] [--no-baseline]
#                       [--results] [--timeout SECONDS] [--extra FILE]
#   --json        machine-readable report (findings, sources, deploys, raw results)
#   --only/--skip check names: k8s alerts loki-errors http workflows sentry posthog deploys dispatch
#   --no-baseline report absolute findings only (no comparison)
#   --results     print the raw check results (JSONL) instead of a report
#   --extra FILE  bash snippet sourced after the report; it can use $LOKI (logcli
#                 base command with --since), $KUBECONFIG and $WIN (text mode only)
#   --state FILE  mark each finding new, escalated, reraise or unchanged against
#                 earlier runs that used the same file (shared by every cadence)
#   --watch       for unattended watchers: compact JSON findings {key, severity,
#                 summary, status, first_seen, last_raised, ...} and per-source
#                 status; implies --state
#                 (default <state>/<env>/watch-state.json). See references/watching.md
#   --reraise-hours N        re-raise a finding still present after N hours (6)
#   --unavailable-minutes N  report a source unavailable this long as an item (60)
# Exit: 0 healthy, 3 findings present, 4 nothing found but some sources were not
# checked (verdict "incomplete"), 2 usage error. With --watch: 0 no items, 3 items,
# anything else means the run failed.
# Baselines: scripts/baseline.sh. Procedure: SKILL.md.
set -uo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
. "$HERE/lib/common.sh"
. "$HERE/lib/pgro.sh"
[[ " $* " == *" -h "* || " $* " == *" --help "* ]] && { ph_usage "$0"; exit 0; }
ph_parse_common "$@"
ALL="k8s alerts loki-errors http workflows sentry posthog deploys dispatch"
ONLY=""; SKIP=""; NOBASE=0; RESULTS=0; TMO=180; EXTRA=""; WATCH=(); STATE=""
set -- "${PH_ARGS[@]+"${PH_ARGS[@]}"}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2//,/ }"; shift 2 ;;
    --skip) SKIP="${2//,/ }"; shift 2 ;;
    --no-baseline) NOBASE=1; shift ;;
    --results) RESULTS=1; shift ;;
    --timeout) TMO="$2"; shift 2 ;;
    --extra) EXTRA="$2"; shift 2 ;;
    --state) [ -n "${2:-}" ] || ph_die "--state needs a file"; STATE="$2"; shift 2 ;;
    --watch) WATCH+=(--watch); PH_JSON=1; shift ;;
    --reraise-hours|--unavailable-minutes) [ -n "${2:-}" ] || ph_die "$1 needs a number"; WATCH+=("$1" "$2"); shift 2 ;;
    *) ph_die "unknown argument $1 (see --help)" ;;
  esac
done
checks=()
for c in ${ONLY:-$ALL}; do
  [[ " $ALL " == *" $c "* ]] || ph_die "unknown check '$c'"
  [[ " $SKIP " == *" $c "* ]] || checks+=("$c")
done
[ "$PH_ENV" = staging ] && [[ " ${checks[*]} " == *" workflows "* ]] && [ -z "$ONLY" ] && \
  checks=("${checks[@]/workflows}")   # production-only source; skip quietly on staging
mkdir -p "$PH_STATE_DIR"; chmod 700 "$PH_STATE_ROOT" "$PH_STATE_DIR" 2>/dev/null

# Shared tunnels, opened once in this shell and inherited by every check.
if ph_have_kube; then
  ph_ensure_loki || true
  ph_ensure_vm || true
  [ "$PH_LIVE" = 1 ] && { ph_ensure_am || true; }
  ph_org_names >/dev/null 2>&1 || true
fi

out="$(ph_tmp)/results"; mkdir -p "$out"
# Stop running checks (and, through their own traps, their tunnels) if we are interrupted.
CHILDREN=()
trap 'for p in "${CHILDREN[@]}"; do kill -TERM "$p" 2>/dev/null; done; wait 2>/dev/null; ph_cleanup' EXIT
common=(--raw --env "$PH_ENV" --window "$PH_WINDOW" --end "$PH_END_ISO")
for c in "${checks[@]}"; do
  [ -n "$c" ] || continue
  timeout "$TMO" "$HERE/checks/$c.sh" "${common[@]}" >"$out/$c.json" 2>"$out/$c.err" &
  CHILDREN+=("$!")
done
wait

results="$(ph_tmp)/all.jsonl"; : >"$results"
for c in "${checks[@]}"; do
  [ -n "$c" ] || continue
  if jq -e '.check' "$out/$c.json" >/dev/null 2>&1; then
    jq -c . "$out/$c.json" >>"$results"
  else
    err="$(tail -c 300 "$out/$c.err" 2>/dev/null | tr '\n' ' ')"
    jq -nc --arg c "$c" --arg e "check failed or timed out after ${TMO}s: ${err:-no output}" --arg w "$PH_WINDOW" \
      --arg s "$PH_START_ISO" --arg en "$PH_END_ISO" --argjson ws "$PH_WIN_S" \
      '{check:$c, status:"unavailable", window:$w, start:$s, end:$en, window_s:$ws, findings:[], series:[], notes:[$e], data:{}}' >>"$results"
  fi
done

if [ "$RESULTS" = 1 ]; then cat "$results"; exit 0; fi
args=(--env "$PH_ENV" --save-last --exit-code); [ "$PH_JSON" = 1 ] && args+=(--json); [ "$NOBASE" = 1 ] && args+=(--no-baseline)
[ -n "$STATE" ] && args+=(--state "$STATE"); args+=("${WATCH[@]+"${WATCH[@]}"}")
report="$(python3 "$PH_LIB_DIR/assess.py" "${args[@]}" "$results")"; rc=$?
case "$rc" in 0|3|4) ;; *) ph_die "assessment failed (exit $rc)" ;; esac
echo "$report"

if [ -n "$EXTRA" ] && [ "$PH_JSON" = 0 ]; then
  echo "-- extra checks ($EXTRA)"
  # Compatibility with workstream health-extra snippets.
  WIN="$PH_WINDOW"; LOKI="logcli --addr=${PH_LOKI_URL:-} query --quiet --output=raw --since=$PH_WINDOW"
  export WIN LOKI
  # shellcheck disable=SC1090
  . "$EXTRA"
fi

exit "$rc"
