#!/usr/bin/env bash
# Firing alerts from the VictoriaMetrics stack (namespace monitoring).
# Usage: alerts.sh [--env production|staging] [--window 30m] [--end ISO] [--json] [--raw]
# Live runs read Alertmanager (silenced and inhibited alerts excluded). Runs with
# --end in the past read the ALERTS series from VictoriaMetrics instead.
# Any firing critical alert is a finding; other alerts are findings only when the
# baseline has not seen them before.
set -uo pipefail
. "$(dirname "$0")/../lib/common.sh"
[[ " $* " == *" -h "* || " $* " == *" --help "* ]] && { ph_usage "$0"; exit 0; }
ph_parse_common "$@"
ph_result_init alerts
ph_have_kube || ph_bail "kubectl cannot reach the $PH_ENV cluster"

IGNORE='^(Watchdog|InfoInhibitor)$'
if [ "$PH_LIVE" = 1 ] && ph_ensure_am; then
  raw="$(curl -fsS --max-time 15 "$PH_AM_URL/api/v2/alerts?active=true&silenced=false&inhibited=false" 2>/dev/null)" \
    || ph_bail "Alertmanager API unreachable"
  alerts="$(echo "$raw" | jq -c '[.[] | {name: .labels.alertname, sev: (.labels.severity // "none"), ns: (.labels.namespace // ""),
      since: .startsAt, summary: ((.annotations.summary // .annotations.description // "")[0:160])}]')"
  src=alertmanager
elif ph_ensure_vm; then
  raw="$(ph_vm_query 'max by (alertname, severity, namespace) (ALERTS{alertstate="firing"})')" || ph_bail "VictoriaMetrics ALERTS query failed"
  alerts="$(echo "$raw" | jq -c '[.[] | {name: .metric.alertname, sev: (.metric.severity // "none"), ns: (.metric.namespace // ""), since: "", summary: ""}]')"
  src="victoriametrics ALERTS at $PH_END_ISO"
else
  ph_bail "neither Alertmanager nor VictoriaMetrics reachable"
fi

alerts="$(echo "$alerts" | jq -c --arg ig "$IGNORE" '[.[] | select(.name | test($ig) | not) | select(.sev != "none" and .sev != "heartbeat")]')"
grouped="$(echo "$alerts" | jq -c 'group_by([.name, .ns, .sev])[] | {name: .[0].name, ns: .[0].ns, sev: .[0].sev, n: length,
    since: ([.[].since] | min), summary: .[0].summary}')"
presence='[]'
while read -r a; do
  [ -n "$a" ] || continue
  name="$(jq -r .name <<<"$a")"; ns="$(jq -r .ns <<<"$a")"; sev="$(jq -r .sev <<<"$a")"
  key="alert:$name|${ns:-cluster}"
  title="$(jq -r '"\(.sev) alert \(.name)\(if .ns != "" then " in " + .ns else "" end)\(if .n > 1 then " x\(.n)" else "" end)\(if .since != "" then " since " + .since[0:16] else "" end): \(.summary)"' <<<"$a")"
  if [ "$sev" = critical ]; then
    ph_finding sev2 "alert.critical:$name|${ns:-cluster}" "$title" "$(jq -c '{severity: .sev, since, summary}' <<<"$a")" "$ns"
  fi
  hint=sev3; [ "$sev" = critical ] && hint=sev2
  [[ "$name" == CloudBuildFailed* ]] && hint=sev2
  presence="$(jq -c --arg k "$key" --arg t "$title" --arg h "$hint" --arg ns "$ns" --argjson a "$a" \
    '. + [{key: $k, title: $t, hint: $h, namespace: $ns, evidence: {severity: $a.sev, since: $a.since}}]' <<<"$presence")"
done <<<"$grouped"

ph_data presence "$presence"
ph_data firing "$alerts"
n="$(jq length <<<"$alerts")"
crit="$(jq '[.[] | select(.sev == "critical")] | length' <<<"$alerts")"
names="$(jq -r '[.[].name] | group_by(.) | map(.[0] + (if length > 1 then "x\(length)" else "" end)) | join(", ")' <<<"$alerts")"
ph_data summary "$(jq -nc --arg s "$n firing ($crit critical) via $src: $names" '$s')"
ph_emit
