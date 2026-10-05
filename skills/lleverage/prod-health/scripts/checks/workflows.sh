#!/usr/bin/env bash
# Workflow failures from ClickHouse default.activity_v1 (production only).
# Usage: workflows.sh [--env production] [--window 30m] [--end ISO] [--json] [--raw]
# Counts production workflow_completed terminals with status error/aborted/timeout
# by failure category, by category/code (including platform_interrupted and
# api_execution_uncertain) and by organisation, plus the overall failure rate.
# Credentials: CLAUDE_CH_USERNAME / CLAUDE_CH_PASSWORD from the environment (fish
# config fallback). They are passed to curl on stdin, never on the command line.
set -uo pipefail
. "$(dirname "$0")/../lib/common.sh"
. "$(dirname "$0")/../lib/pgro.sh"
[[ " $* " == *" -h "* || " $* " == *" --help "* ]] && { ph_usage "$0"; exit 0; }
ph_parse_common "$@"
ph_result_init workflows
CH_URL="${PH_CH_URL:-https://i0rxmo2j4u.europe-west4.gcp.clickhouse.cloud:8443/}"

[ "$PH_ENV" = production ] || ph_bail "workflow activity lives in the production ClickHouse only; no staging source"
CH_USER="$(ph_secret CLAUDE_CH_USERNAME)"; CH_PASS="$(ph_secret CLAUDE_CH_PASSWORD)"
[ -n "$CH_PASS" ] || ph_bail "CLAUDE_CH_PASSWORD not set (env or fish config)"

chq() {
  case "$(tr '[:lower:]' '[:upper:]' <<<"$1" | sed 's/^[[:space:]]*//')" in SELECT*|WITH*) ;; *) echo "read-only queries only" >&2; return 1 ;; esac
  printf 'user = "%s:%s"\n' "${CH_USER:-default}" "$CH_PASS" \
    | curl -fsS --max-time 60 -K - "$CH_URL" --data-binary "$1 FORMAT JSONEachRow"
}

# FINAL deduplicates the ReplacingMergeTree (workflow-debugger guidance). Only the
# flattened eventError column is parsed, never the full eventData, to stay inside
# ClickHouse's memory limit.
WHERE="runtimeKind = 'workflow' AND environment = 'production' AND eventType = 'workflow_completed'
  AND timestamp > toDateTime64($PH_START_S, 3) AND timestamp <= toDateTime64($PH_END_S, 3)"
FAILED="eventStatus IN ('error', 'aborted', 'timeout')"
CAT="if(JSONExtractString(eventError, 'category') = '', concat('status:', ifNull(eventStatus, '?')), JSONExtractString(eventError, 'category'))"
CODE="JSONExtractString(eventError, 'code')"

totals="$(chq "SELECT count() AS total, countIf($FAILED) AS failed, uniqExactIf(organisationId, $FAILED) AS orgs
  FROM default.activity_v1 FINAL WHERE $WHERE")" || ph_bail "ClickHouse query failed (credentials, network or memory)"
total="$(jq -r .total <<<"$totals")"; failed="$(jq -r .failed <<<"$totals")"; forgs="$(jq -r .orgs <<<"$totals")"
ph_series wf.total "$total" "workflow completions" '{"rules":["drop"],"drop_hint":"sev2","drop_min_expected":60}'
ph_series wf.failed "$failed" "workflow failure rate" '{"ratio_of":"wf.total","min_spike":10,"hint":"sev2"}'

bycat="$(chq "SELECT $CAT AS cat, count() AS n, uniqExact(organisationId) AS orgs, groupUniqArray(5)(organisationId) AS sample_orgs
  FROM default.activity_v1 FINAL WHERE $WHERE AND $FAILED GROUP BY cat ORDER BY n DESC")" || ph_unavailable "category query failed"
while read -r c; do
  [ -n "$c" ] || continue
  cat="$(jq -r .cat <<<"$c")"
  hint=sev3
  case "$cat" in platform_error|platform_interrupted|unknown|status:*) hint=sev2 ;; esac
  [ "$(jq -r .orgs <<<"$c")" -ge 5 ] && [[ "$cat" == platform_* ]] && hint=sev1
  ph_series "wf.category:$cat" "$(jq -r .n <<<"$c")" "workflow failures category=$cat across $(jq -r .orgs <<<"$c") org(s)" \
    "$(jq -c --arg h "$hint" '{rules:["new","spike"], min_new:5, min_spike:8, hint:$h, evidence:{orgs:.orgs, sample_orgs:.sample_orgs}}' <<<"$c")"
done <<<"$bycat"

bycode="$(chq "SELECT $CAT AS cat, $CODE AS code, count() AS n, uniqExact(organisationId) AS orgs,
    any(substring(JSONExtractString(eventError, 'message'), 1, 160)) AS msg
  FROM default.activity_v1 FINAL WHERE $WHERE AND $FAILED GROUP BY cat, code ORDER BY n DESC LIMIT 40")" || ph_unavailable "code query failed"
while read -r c; do
  [ -n "$c" ] || continue
  key="$(jq -r '"\(.cat)/\(.code)"' <<<"$c")"
  hint=sev3; [[ "$key" =~ platform_|api_execution_uncertain|stale_run_reaper ]] && hint=sev2
  ph_series "wf.code:$key" "$(jq -r .n <<<"$c")" "workflow failures $key across $(jq -r .orgs <<<"$c") org(s)" \
    "$(jq -c --arg h "$hint" '{rules:["new","spike"], min_new:5, min_spike:8, hint:$h, evidence:{orgs:.orgs, sample:.msg}}' <<<"$c")"
done <<<"$bycode"

byorg="$(chq "SELECT organisationId AS org, countIf($FAILED) AS failed, count() AS total,
    topKIf(3)($CAT, $FAILED) AS cats
  FROM default.activity_v1 FINAL WHERE $WHERE GROUP BY org HAVING failed > 0 ORDER BY failed DESC LIMIT 25")" || ph_unavailable "org query failed"
while read -r o; do
  [ -n "$o" ] || continue
  ph_series "wf.org:$(jq -r .org <<<"$o")" "$(jq -r .failed <<<"$o")" "workflow failures in $(jq -r '"\(.org): \(.failed)/\(.total) runs (\(.cats | join(",")))"' <<<"$o")" \
    "$(jq -c '{rules:["new","spike"], min_new:10, min_spike:15, hint:"sev3", evidence:{total:.total, categories:.cats}}' <<<"$o")"
done <<<"$byorg"

# Org names for the report (cached, read-only app DB via the cloud-sql-proxy sidecar).
if ph_have_kube; then
  ph_org_names >/dev/null 2>&1 || ph_note "org names unavailable (app DB port-forward failed); showing ids"
fi

ph_data summary "$(jq -nc --arg t "$total" --arg f "$failed" --arg o "$forgs" \
  --arg top "$(echo "$bycat" | jq -rs 'map("\(.cat)=\(.n)") | .[:5] | join(" ")')" \
  '"\($f)/\($t) production runs failed across \($o) org(s): \($top)"')"
ph_emit
