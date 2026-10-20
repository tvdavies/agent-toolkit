#!/usr/bin/env bash
# Usage: query.sh vm|loki '<query>' [--range 6h] [--step 1m] [--end <ISO time>]
#                 [--limit 100] [--max-series 50] [--env production|staging] [--raw] [--dry-run]
#
# The only way to send an ad-hoc query to Lleverage's VictoriaMetrics (vm, PromQL)
# or Loki (loki, LogQL). Don't curl them or open your own port-forward: on 20 Oct
# 2026 one hand-written range query OOM-killed production vmsingle (LLE-16077), and
# on 14 Oct 2026 one LogQL query OOM-killed production Loki (LLE-15393).
#
# The query is checked before anything is sent (lib/queryguard.py). It is refused,
# with the safe shape in the message, when it has:
#   - a range (--range) over 24h, or more than 1440 points per series (step too small);
#   - a PromQL window over 24h (e.g. [5d]) that isn't aggregated, uses without (...),
#     or groups by pod, instance or another per-pod label; or any window over 7d;
#   - a selector with no metric name or a __name__ pattern;
#   - a LogQL [range] over 24h, a log or metric range over 24h, a stream selector that
#     narrows nothing, or a selector narrowed only by a regex over more than 6h.
#
# Modes:
#   vm, no --range        instant query at --end (default now). Multi-day questions go here:
#                         max(max_over_time(metric[5d])), topk(10, max_over_time(metric[5d])).
#   vm, --range           range query ending at --end; --step defaults to about 360 points.
#   loki, metric query    (it has a [range]) instant at --end, or a range query with --range.
#   loki, log query       lines from the last --range (default 1h), newest first, --limit
#                         lines (default 100, at most 5000).
#
# Output: a vector prints {metric, value} per series; a matrix prints {metric, points,
# min, max, last} per series; logs print {ts, ns, pod, container, line}. At most
# --max-series series (default 50) are printed; --raw prints Loki's or VM's JSON instead.
# --dry-run checks the query and prints the request without contacting the cluster.
#
# Exit status: 0 ran (or dry run passed), 3 refused, 2 usage error, 1 the query failed.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
. "$here/lib/common.sh"

usage() { ph_usage "${BASH_SOURCE[0]}"; }
[ "$#" -ge 1 ] || { usage >&2; exit 2; }
case "$1" in -h|--help) usage; exit 0 ;; esac
backend="$1"; shift
case "$backend" in vm|loki) ;; *) ph_die "first argument must be vm or loki, not '$backend'" ;; esac
[ "$#" -ge 1 ] && [ "${1#--}" = "$1" ] || ph_die "pass the query as the second argument, in single quotes"
query="$1"; shift

range="" step="" end="" limit="" max_series=50 raw=0 dry=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --range|--step|--end|--limit|--max-series|--env) [ "$#" -ge 2 ] && [ -n "$2" ] || ph_die "$1 needs a value" ;;
  esac
  case "$1" in
    --range) range="$2"; shift 2 ;;
    --step) step="$2"; shift 2 ;;
    --end) end="$2"; shift 2 ;;
    --limit) limit="$2"; shift 2 ;;
    --max-series) max_series="$2"; shift 2 ;;
    --env) PH_ENV="$2"; shift 2 ;;
    --raw) raw=1; shift ;;
    --dry-run) dry=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) ph_die "unknown flag '$1' (see --help)" ;;
  esac
done
case "$PH_ENV" in production|staging) ;; prod) PH_ENV=production ;; *) ph_die "--env must be production or staging" ;; esac
[[ "$max_series" =~ ^[0-9]+$ ]] && [ "$max_series" -ge 1 ] && [ "$max_series" -le 500 ] || ph_die "--max-series must be 1 to 500"
[ -z "$limit" ] || [[ "$limit" =~ ^[0-9]+$ ]] || ph_die "--limit must be a number"

args=("$backend" --query "$query")
[ -z "$range" ] || args+=(--range "$range")
[ -z "$step" ] || args+=(--step "$step")
[ -z "$limit" ] || args+=(--limit "$limit")
rc=0; plan="$(python3 "$here/lib/queryguard.py" "${args[@]}")" || rc=$?
[ "$rc" = 0 ] || exit "$rc"

if [ -n "$end" ]; then
  end_s="$(date -u -d "$end" +%s 2>/dev/null)" || ph_die "bad --end '$end'"
else
  end_s="$(date -u +%s)"
fi
mode="$(jq -r .mode <<<"$plan")"
range_s="$(jq -r '.range_s // 0 | floor' <<<"$plan")"
step_s="$(jq -r '.step_s // 0' <<<"$plan")"
limit="$(jq -r '.limit // 0' <<<"$plan")"
start_s=$(( end_s - range_s ))

params=(--data-urlencode "query=$query")
case "$backend/$mode" in
  vm/instant)   path=/api/v1/query; params+=(--data-urlencode "time=$end_s" --data-urlencode "timeout=30s") ;;
  vm/range)     path=/api/v1/query_range; params+=(--data-urlencode "start=$start_s" --data-urlencode "end=$end_s"
                  --data-urlencode "step=$step_s" --data-urlencode "timeout=30s") ;;
  loki/instant) path=/loki/api/v1/query; params+=(--data-urlencode "time=${end_s}000000000") ;;
  loki/range)   path=/loki/api/v1/query_range; params+=(--data-urlencode "start=${start_s}000000000"
                  --data-urlencode "end=${end_s}000000000" --data-urlencode "step=$step_s") ;;
  loki/logs)    path=/loki/api/v1/query_range; params+=(--data-urlencode "start=${start_s}000000000"
                  --data-urlencode "end=${end_s}000000000" --data-urlencode "limit=$limit" --data-urlencode "direction=backward") ;;
  *) ph_die "unexpected plan: $plan" ;;
esac

if [ "$dry" = 1 ]; then
  jq -c --arg env "$PH_ENV" --arg path "$path" --arg start "$(date -u -d "@$start_s" +%FT%TZ)" \
    --arg end "$(date -u -d "@$end_s" +%FT%TZ)" '{dry_run: true, env: $env, path: $path, start: $start, end: $end} + .' <<<"$plan"
  exit 0
fi

export KUBECONFIG="$PH_INFRA_DIR/generated/$PH_ENV/kubeconfig"
ph_tmp >/dev/null; ph_trap_cleanup
if [ "$backend" = vm ]; then
  ph_ensure_vm || ph_die "can't reach VictoriaMetrics in $PH_ENV (kubeconfig $KUBECONFIG)"; url="$PH_VM_URL"
else
  ph_ensure_loki || ph_die "can't reach Loki in $PH_ENV (kubeconfig $KUBECONFIG)"; url="$PH_LOKI_URL"
fi

out="$PH_TMP/result.json"
code="$(curl -sS --max-time 60 -G -o "$out" -w '%{http_code}' "$url$path" "${params[@]}")" || {
  echo "query.sh: request failed or timed out after 60s; don't retry it wider" >&2; exit 1; }
if [ "$code" != 200 ]; then
  echo "query.sh: HTTP $code: $(head -c 500 "$out")" >&2; exit 1
fi
if [ "$raw" = 1 ]; then cat "$out"; echo; exit 0; fi

total="$(jq '.data.result | length' "$out")"
case "$(jq -r .data.resultType "$out")" in
  vector) jq -c --argjson n "$max_series" '.data.result[:$n][] | {metric, value: .value[1]}' "$out" ;;
  matrix) jq -c --argjson n "$max_series" '.data.result[:$n][] | (.values | map(.[1] | tonumber? // .)) as $v
            | {metric, points: ($v | length), min: ($v | min), max: ($v | max), last: $v[-1]}' "$out" ;;
  streams) jq -c '[.data.result[] | .stream as $s | .values[] | {ts: (.[0][0:10] | tonumber | todate), ns: ($s.namespace // ""),
             pod: ($s.pod // ""), container: ($s.container // ""), line: (.[1] | .[0:2000])}] | sort_by(.ts) | reverse | .[]' "$out" ;;
  *) jq -c '.data.result' "$out" ;;
esac
if [ "$total" = 0 ]; then
  echo "query.sh: no results (check the selector's labels before widening the window)" >&2
elif [ "$(jq -r .data.resultType "$out")" != streams ] && [ "$total" -gt "$max_series" ]; then
  echo "query.sh: showing $max_series of $total series; aggregate further or raise --max-series" >&2
fi
