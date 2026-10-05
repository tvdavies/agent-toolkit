#!/usr/bin/env bash
# Loki: error and warn volume by namespace, plus normalised error signatures
# (ids, numbers and hashes masked) so new or sharply increased messages stand out.
# Usage: loki-errors.sh [--env production|staging] [--window 30m] [--end ISO] [--json] [--raw]
#        [--limit N]   max lines fetched per query for signatures (default 5000, Loki's cap)
# Signatures come from lines with a level=error/fatal label plus unlabelled lines
# that look like errors (Error:, Unhandled, Traceback, panic, prisma:error).
set -uo pipefail
. "$(dirname "$0")/../lib/common.sh"
[[ " $* " == *" -h "* || " $* " == *" --help "* ]] && { ph_usage "$0"; exit 0; }
ph_parse_common "$@"
LIMIT=5000
set -- "${PH_ARGS[@]+"${PH_ARGS[@]}"}"
while [ "$#" -gt 0 ]; do case "$1" in --limit) LIMIT="$2"; shift 2 ;; *) shift ;; esac; done
ph_result_init loki-errors
ph_ensure_loki || ph_bail "Loki port-forward failed (cluster unreachable?)"

SEL='job="loki.source.kubernetes.pod_logs"'
EXCL='namespace!~"loki|monitoring"'
W="${PH_WIN_S}s"
ERR_LVL='(?i)(error|err|fatal|crit.*|panic)'

for lvl in error warn; do
  re="$ERR_LVL"; [ "$lvl" = warn ] && re='(?i)(warn|warning)'
  res="$(ph_loki_metric "sum by (namespace) (count_over_time({$SEL, level=~\"$re\"}[$W]))")" \
    || { ph_unavailable "Loki $lvl volume query failed"; continue; }
  while IFS=$'\t' read -r n ns; do
    [ -n "$ns" ] || continue
    if [ "$lvl" = error ]; then o='{"rules":["new","spike"],"min_new":5,"min_spike":10,"hint":"sev3"}'
    else o='{"rules":["new","spike"],"min_new":50,"min_spike":100,"hint":"sev3"}'; fi
    ph_series "loki.$lvl:$ns" "$n" "$lvl lines in $ns" "$(jq -c --arg ns "$ns" '. + {namespace:$ns}' <<<"$o")"
  done < <(echo "$res" | jq -r '.[] | "\(.value[1])\t\(.metric.namespace // "")"' | sort -rn)
  ph_data "by_ns_$lvl" "$(echo "$res" | jq -c 'map({(.metric.namespace // "?"): (.value[1] | tonumber)}) | add // {}')"
done

lines="$(ph_tmp)/lines.jsonl"; : >"$lines"
# Loki caps a query at 5000 lines. When a sample hits its cap it covers only the
# newest part of the window, so each line carries its query's covered span
# (cover) and signature counts are compared at that span.
fetch() {   # fetch NAME LIMIT QUERY [STRICT] [TIMEOUT]
  local out c; out="$(ph_tmp)/q.${1//[^a-z0-9-]/_}.jsonl"; c="$PH_WIN_S"
  ph_loki_lines "$3" "$2" "${5:-90}" >"$out" || { ph_unavailable "Loki $1 sample query failed or timed out"; return; }
  if [ "$(wc -l <"$out")" -ge "$2" ]; then
    c=$(( PH_END_S - $(jq -s 'map(.ts) | min' "$out") )); [ "$c" -lt 60 ] && c=60
    ph_note "$1: sample hit the $2-line cap; its signature counts cover the last $(( c / 60 ))m"
  fi
  jq -c --argjson c "$c" --argjson strict "${4:-false}" '. + {cover: $c, strict: $strict}' "$out" >>"$lines"
}
fetch labelled "$LIMIT" "{$SEL, level=~\"$ERR_LVL\"}"

# Many services log errors without a level label. A cheap literal filter counts
# them per namespace; then each namespace is sampled separately (so one noisy
# namespace cannot crowd out the rest) and normalise.py applies a stricter regex.
ERRLIKE='Error|ERROR|Unhandled|Traceback|panic|FATAL|Exception|prisma:error'
UL="{$SEL, level=\"\", $EXCL, namespace!=\"kube-system\"} |~ \`$ERRLIKE\`"
res="$(ph_loki_metric "sum by (namespace) (count_over_time($UL [$W]))")" || ph_unavailable "Loki unlabelled error volume query failed"
while IFS=$'\t' read -r n ns; do
  [ -n "$ns" ] || continue
  ph_series "loki.errlike:$ns" "$n" "unlabelled error-like lines in $ns" \
    "$(jq -nc --arg ns "$ns" '{rules:["new","spike"], min_new:20, min_spike:50, hint:"sev3", namespace:$ns}')"
done < <(echo "${res:-[]}" | jq -r '.[] | "\(.value[1])\t\(.metric.namespace // "")"' | sort -rn)
# Namespaces whose raw log volume makes line sampling time out are counted only.
SKIP_SAMPLE="${PH_LOKI_SAMPLE_SKIP:-litellm}"
for ns in $(echo "${res:-[]}" | jq -r --arg skip "$SKIP_SAMPLE" '($skip | split(",")) as $s
    | map(select(.metric.namespace as $n | $s | index($n) | not)) | sort_by(-(.value[1] | tonumber)) | .[:10][] | .metric.namespace'); do
  fetch "unlabelled:$ns" 1000 "{$SEL, namespace=\"$ns\", level=\"\"} |~ \`$ERRLIKE\`" true 45 &
done
wait
nlines="$(wc -l <"$lines")"

sigs="$(python3 "$PH_LIB_DIR/normalise.py" loki-signatures <"$lines")"
nsig=0
while read -r s; do
  [ -n "$s" ] || continue
  nsig=$((nsig + 1))
  ns1="$(jq -r '.namespaces | keys_unsorted[0]' <<<"$s")"
  ph_series "loki.sig:$(jq -r .key <<<"$s")" "$(jq -r .count <<<"$s")" \
    "error signature in $(jq -r '.namespaces | keys_unsorted | if length > 3 then (.[:3] | join(",")) + ",+\(length - 3)" else join(",") end' <<<"$s"): $(jq -r .signature <<<"$s")" \
    "$(jq -c --arg ns "$ns1" '{rules:["new","spike"], min_new:3, min_spike:10, window_s:.cover, hint:(if (.namespaces | length) >= 5 then "sev2" else "sev3" end),
        namespace:$ns, evidence:{namespaces:.namespaces, sample:.sample}}' <<<"$s")"
done <<<"$sigs"

ph_data summary "$(jq -nc --arg e "$(jq -r '(.by_ns_error // {}) | to_entries | sort_by(-.value) | .[:6] | map("\(.key)=\(.value)") | join(" ")' "$PH_DATA")" \
  --arg w "$(jq -r '(.by_ns_warn // {}) | to_entries | sort_by(-.value) | .[:4] | map("\(.key)=\(.value)") | join(" ")' "$PH_DATA")" \
  --arg n "$nsig" --arg l "$nlines" '"errors: \($e); warn: \($w); \($n) signatures from \($l) lines"')"
ph_emit
