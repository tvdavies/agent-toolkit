#!/usr/bin/env bash
# HTTP: 5xx and unexpected 4xx (401/403/404/429) by service and by route.
# Usage: http.sh [--env production|staging] [--window 30m] [--end ISO] [--json] [--raw]
# Sources:
#   - Hubble L7 metrics in VictoriaMetrics (hubble_http_requests_total): status by
#     destination namespace/workload for ingress traffic. No paths.
#   - Loki structured request logs: JSON lines with status/statusCode plus
#     endpoint/url/path/route (app, credential-service, gotenberg, ...), and
#     uvicorn access lines ("GET /path HTTP/1.1" 401). Routes are normalised.
# Health checks, metrics scrapes and kube probes are excluded.
set -uo pipefail
. "$(dirname "$0")/../lib/common.sh"
[[ " $* " == *" -h "* || " $* " == *" --help "* ]] && { ph_usage "$0"; exit 0; }
ph_parse_common "$@"
ph_result_init http
ph_have_kube || ph_bail "kubectl cannot reach the $PH_ENV cluster"
W="${PH_WIN_S}s"

# --- Hubble: status by destination ------------------------------------------------
if ph_ensure_vm; then
  hub="$(ph_vm_query "sum by (destination_namespace, destination_workload, status) (increase(hubble_http_requests_total{status=~\"4..|5..\"}[$W])) >= 1")"
  tot="$(ph_vm_query "sum by (destination_namespace) (increase(hubble_http_requests_total[$W]))")"
  if [ -n "$hub" ]; then
    while IFS='|' read -r n ns wl st; do
      [ -n "$ns" ] || continue
      case "$st" in 5*) cls="$st"; o='{"min_new":5,"min_spike":10,"hint":"sev2"}' ;;
        401|403|404|429) cls="$st"; o='{"min_new":20,"min_spike":30,"hint":"sev3"}' ;;
        *) cls=4xx; o='{"min_new":30,"min_spike":50,"hint":"sev3"}' ;; esac
      ph_series "http.svc:$ns${wl:+/$wl}|$cls" "$n" "HTTP $cls to $ns${wl:+/$wl} (hubble)" \
        "$(jq -c --arg ns "$ns" '. + {rules:["new","spike"], namespace:$ns}' <<<"$o")"
    done < <(echo "$hub" | jq -r '.[] | "\(.value[1] | tonumber | round)|\(.metric.destination_namespace // "")|\(.metric.destination_workload // "")|\(.metric.status)"' \
      | awk -F'|' '{ k=$2 FS $3 FS (($4 ~ /^5/ || $4=="401" || $4=="403" || $4=="404" || $4=="429") ? $4 : "4xx"); s[k]+=$1 } END { for (k in s) print s[k] FS k }' | sort -rn)
    ph_data hubble_5xx "$(echo "$hub" | jq '[.[] | select(.metric.status | startswith("5")) | .value[1] | tonumber] | add // 0 | round')"
    ph_data hubble_total "$(echo "$tot" | jq '[.[].value[1] | tonumber] | add // 0 | round')"
  else
    ph_unavailable "hubble_http_requests_total query failed"
  fi
else
  ph_unavailable "VictoriaMetrics port-forward failed"
fi

# --- Loki: routes ------------------------------------------------------------------
if ph_ensure_loki; then
  SEL='{job="loki.source.kubernetes.pod_logs", namespace!~"loki|monitoring|kube-system"}'
  PROBE='(?i)"(url|path|endpoint|uri)":"/(health|healthz|ready|readyz|live|livez|metrics)[/"?]'
  json_q="sum by (namespace, method, endpoint, url, path, route, uri, status, statusCode) (count_over_time($SEL |~ \`\"(status|statusCode)\":\\s*\"?[45][0-9]{2}\\b\` !~ \`$PROBE\` | json method=\"method\", endpoint=\"endpoint\", url=\"url\", path=\"path\", route=\"route\", uri=\"uri\", status=\"status\", statusCode=\"statusCode\" | __error__=\"\" [$W]))"
  acc_q="sum by (namespace, method, path, status) (count_over_time($SEL |~ \`\" [45][0-9]{2} \` !~ \`/(health|metrics|ready|live)\` | regexp \`\"(?P<method>[A-Z]+) (?P<path>\\S+) HTTP/[0-9.]+\" (?P<status>[45][0-9]{2})\` | __error__=\"\" [$W]))"
  rows="$(ph_tmp)/routes.tsv"
  {
    ph_loki_metric "$json_q" | jq -r '.[] | .metric as $m | [($m.namespace // ""), ($m.method // ""),
        ($m.endpoint // $m.route // $m.path // $m.url // $m.uri // "?"), ($m.status // $m.statusCode // ""), (.value[1])] | @tsv' \
      || ph_unavailable "Loki structured request-log query failed"
    ph_loki_metric "$acc_q" | jq -r '.[] | .metric as $m | [($m.namespace // ""), ($m.method // ""), ($m.path // "?"), ($m.status // ""), (.value[1])] | @tsv' \
      || ph_unavailable "Loki access-log query failed"
  } >"$rows"
  agg="$(python3 - "$rows" "$PH_LIB_DIR" <<'PY'
import sys, json
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[2])
from normalise import route
agg = {}
for line in open(sys.argv[1], encoding="utf-8"):
    parts = line.rstrip("\n").split("\t")
    if len(parts) != 5 or not parts[3] or parts[3][0] not in "45":
        continue
    ns, method, path, status, n = parts
    cls = "org-*" if ns.startswith("org-") else ns
    a = agg.setdefault((cls, method, route(path), status), {"n": 0, "nss": {}})
    a["n"] += int(float(n))
    a["nss"][ns] = a["nss"].get(ns, 0) + int(float(n))
for (cls, method, r, status), a in sorted(agg.items(), key=lambda kv: -kv[1]["n"]):
    top = max(a["nss"], key=a["nss"].get)
    print(json.dumps({"cls": cls, "ns": top, "nss": a["nss"], "method": method, "route": r, "status": status, "n": a["n"]}))
PY
)"
  nroutes=0
  while read -r a; do
    [ -n "$a" ] || continue
    nroutes=$((nroutes + 1))
    st="$(jq -r .status <<<"$a")"; ns="$(jq -r .ns <<<"$a")"; cls="$(jq -r .cls <<<"$a")"
    # Auth failures on one route are usually a broken client or capability flow (LLE-13962).
    case "$st" in 5*) o='{"min_new":5,"min_spike":10,"hint":"sev2"}' ;; 401|403) o='{"min_new":20,"min_spike":30,"hint":"sev2"}' ;;
      *) o='{"min_new":20,"min_spike":30,"hint":"sev3"}' ;; esac
    ph_series "http.route:$cls|$(jq -r '"\(.method) \(.route)|\(.status)"' <<<"$a" | sed 's/^ //')" "$(jq -r .n <<<"$a")" \
      "$(jq -r '"HTTP \(.status) on \(if (.nss | length) > 1 then "\(.cls) (\(.nss | length) ns)" else .ns end) \(.method) \(.route)"' <<<"$a" | sed 's/  / /')" \
      "$(jq -c --arg ns "$ns" --arg q "{namespace=\"$ns\"} |= \"$(jq -r .route <<<"$a" | sed 's#/:.*##')\" |~ \"$st\"" --argjson nss "$(jq -c .nss <<<"$a")" \
        '. + {rules:["new","spike"], namespace:$ns, evidence:{query:$q, namespaces:$nss}}' <<<"$o")"
  done <<<"$agg"
  ph_data routes "$(echo "$agg" | jq -sc '.[:15]')"
else
  ph_unavailable "Loki port-forward failed; route-level view skipped"
fi

ph_data summary "$(jq -nc --argjson d "$(cat "$PH_DATA")" --arg r "${nroutes:-0}" \
  '"hubble: \($d.hubble_5xx // "?") 5xx of \($d.hubble_total // "?") requests; logged 4xx/5xx routes: \($r)" +
   (if ($d.routes // []) | length > 0 then " (top: " + ([$d.routes[:3][] | "\(.status) \(.route) x\(.n)"] | join(", ")) + ")" else "" end)')"
ph_emit
