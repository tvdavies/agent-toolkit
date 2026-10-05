#!/usr/bin/env bash
# Workflow dispatch health from the session DB (read-only): dispatches that failed
# in the window by failure code (api_execution_uncertain, LLE-14217), and
# dispatches stuck pending/published or holding an expired lease.
# Usage: dispatch.sh [--env production|staging] [--window 30m] [--end ISO] [--json] [--raw]
# Access: port-forward of a session-service pod's cloud-sql-proxy sidecar, URL from
# secret session-service/service-secrets (SESSION_DATABASE_URL), PGOPTIONS
# default_transaction_read_only=on. The URL is never printed or written to disk.
set -uo pipefail
. "$(dirname "$0")/../lib/common.sh"
. "$(dirname "$0")/../lib/pgro.sh"
[[ " $* " == *" -h "* || " $* " == *" --help "* ]] && { ph_usage "$0"; exit 0; }
ph_parse_common "$@"
ph_result_init dispatch
ph_have_kube || ph_bail "kubectl cannot reach the $PH_ENV cluster"

S="to_timestamp($PH_START_S)"; E="to_timestamp($PH_END_S)"
sql="SELECT 'failed', coalesce(failure_code, '?'), environment, count(*), count(DISTINCT organisation_id)
       FROM workflow_dispatches WHERE failed_at > $S AND failed_at <= $E GROUP BY 2, 3
     UNION ALL
     SELECT 'created', status::text, environment, count(*), count(DISTINCT organisation_id)
       FROM workflow_dispatches WHERE created_at > $S AND created_at <= $E GROUP BY 2, 3"
rows="$(ph_pg_query session-service session-service-deployment SESSION_DATABASE_URL "$sql" 2>"$(ph_tmp)/pg.err")" \
  || ph_bail "session DB query failed: $(head -c 200 "$(ph_tmp)/pg.err")"
created=0
while IFS=$'\t' read -r kind code envn n orgs; do
  [ -n "$kind" ] || continue
  if [ "$kind" = failed ]; then
    hint=sev3; [ "$code" = api_execution_uncertain ] && hint=sev2
    ph_series "dispatch.failed:$code|$envn" "$n" "dispatches failed ($code, $envn) across $orgs org(s)" \
      "$(jq -nc --arg h "$hint" --argjson o "$orgs" '{rules:["new","spike"], min_new:3, min_spike:5, hint:$h, evidence:{orgs:$o}}')"
  else
    created=$(( created + n ))
  fi
done <<<"$rows"
ph_series dispatch.created "$created" "dispatches created" '{"rules":["drop"],"drop_hint":"sev3","drop_min_expected":60}'

if [ "$PH_LIVE" = 1 ]; then
  stuck="$(ph_pg_query session-service session-service-deployment SESSION_DATABASE_URL "
    SELECT status::text, count(*), min(created_at)::text FROM workflow_dispatches
     WHERE (status IN ('pending', 'published') AND created_at < now() - interval '10 minutes' AND created_at > now() - interval '2 days')
        OR (status = 'accepted' AND lease_expires_at < now() - interval '5 minutes')
     GROUP BY 1" 2>/dev/null)" || ph_unavailable "stuck-dispatch query failed"
  while IFS=$'\t' read -r st n oldest; do
    [ -n "$st" ] || continue
    ph_finding sev2 "dispatch.stuck:$st" "$n dispatch(es) stuck in $st (oldest created $oldest)" "$(jq -nc --arg s "$st" --argjson n "$n" '{status:$s, count:$n}')"
  done <<<"$stuck"
fi

ph_data summary "$(jq -nc --arg c "$created" --arg f "$(awk -F'\t' '$1=="failed"{s+=$4} END{print s+0}' <<<"$rows")" \
  --arg top "$(awk -F'\t' '$1=="failed"{print $2"="$4}' <<<"$rows" | head -4 | paste -sd' ')" \
  '"\($c) dispatches created, \($f) failed" + (if $top != "" then " (\($top))" else "" end)')"
ph_emit
