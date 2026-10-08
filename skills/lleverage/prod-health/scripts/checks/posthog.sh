#!/usr/bin/env bash
# PostHog: browser exceptions in the window, which server logs never see
# (#7395 broke every public app for ~15h with clean server logs).
# Usage: posthog.sh [--env production|staging] [--window 30m] [--end ISO] [--json] [--raw]
# Project 62494 on eu.posthog.com; key POSTHOG_PERSONAL_API_KEY (env, else fish
# config). Production is host app.lleverage.ai, staging app.staging.llev.dev.
# Exceptions are grouped by type, masked message and masked path; pageviews are
# tracked so a sudden drop (blank page, broken bundle) is visible too.
set -uo pipefail
. "$(dirname "$0")/../lib/common.sh"
[[ " $* " == *" -h "* || " $* " == *" --help "* ]] && { ph_usage "$0"; exit 0; }
ph_parse_common "$@"
ph_result_init posthog
HOST="${POSTHOG_HOST:-https://eu.posthog.com}"; PROJECT="${POSTHOG_PROJECT_ID:-62494}"
case "$PH_ENV" in production) APPHOST=app.lleverage.ai ;; staging) APPHOST=app.staging.llev.dev ;; esac
KEY="$(ph_secret POSTHOG_PERSONAL_API_KEY)"
[ -n "$KEY" ] || ph_bail "POSTHOG_PERSONAL_API_KEY not set (env or fish config)"

hogql() {
  local body; body="$(jq -nc --arg q "$1" '{query: {kind: "HogQLQuery", query: $q}}')"
  printf 'header = "Authorization: Bearer %s"\n' "$KEY" | curl -fsS --max-time 60 -K - \
    -H 'Content-Type: application/json' --data-binary "$body" "$HOST/api/projects/$PROJECT/query/" | jq -c '.results'
}
RANGE="timestamp > toDateTime($PH_START_S) AND timestamp <= toDateTime($PH_END_S) AND properties.\$host = '$APPHOST'"

vol="$(hogql "SELECT countIf(event = '\$pageview'), countIf(event = '\$exception'), uniqIf(distinct_id, event = '\$exception')
  FROM events WHERE $RANGE AND event IN ('\$pageview', '\$exception')")" || ph_bail "PostHog query API failed"
pv="$(jq -r '.[0][0]' <<<"$vol")"; ex="$(jq -r '.[0][1]' <<<"$vol")"; exu="$(jq -r '.[0][2]' <<<"$vol")"
# A window with no pageviews is either a quiet hour or broken capture (or a
# broken query); a zero is never reported as "ok". Look at the newest pageview in
# the last day, and how many arrived in the last two hours, to tell them apart.
last="$(hogql "SELECT count(), max(timestamp), countIf(timestamp > toDateTime($PH_END_S) - INTERVAL 2 HOUR)
  FROM events WHERE event = '\$pageview' AND properties.\$host = '$APPHOST'
  AND timestamp > toDateTime($PH_END_S) - INTERVAL 1 DAY AND timestamp <= toDateTime($PH_END_S)")" \
  || ph_bail "PostHog query API failed (last pageview)"
pv24="$(jq -r '.[0][0] // 0' <<<"$last")"; lastpv="$(jq -r '.[0][1] // ""' <<<"$last")"; pv2h="$(jq -r '.[0][2] // 0' <<<"$last")"
# Working hours in the Netherlands (Mon-Fri, end time 10:00-17:59, so the whole
# two-hour lookback is inside 08:00-18:00): production is never empty for 2h then.
workhours=0; d="$(TZ=Europe/Amsterdam date -d "@$PH_END_S" '+%u %H' 2>/dev/null)"
[ -n "$d" ] && [ "${d% *}" -le 5 ] && [ "$((10#${d#* }))" -ge 10 ] && [ "$((10#${d#* }))" -le 17 ] && workhours=1
quiet=""
silent_q="SELECT count(), max(timestamp) FROM events WHERE event = '\$pageview' AND properties.\$host = '$APPHOST' AND timestamp > now() - INTERVAL 1 DAY"
if [ "${pv24:-0}" = 0 ]; then
  # Nothing for a whole day on production means capture or this query is broken:
  # the exception counts can't be trusted either, so this source is not checked.
  ph_finding sev2 posthog.silent "no PostHog pageviews from $APPHOST in the 24h before $PH_END_ISO: capture or the query is broken" \
    "$(jq -nc --arg h "$APPHOST" --arg q "$silent_q" '{host:$h, lookback:"24h", query:$q}')"
  ph_unavailable "no pageviews from $APPHOST in 24h, so a quiet window can't be told from lost capture"
elif [ "$PH_ENV" = production ] && [ "$workhours" = 1 ] && [ "${pv2h:-0}" = 0 ]; then
  # Same key as the 24h case, so a silence that lasts escalates sev3 -> sev2.
  ph_finding sev3 posthog.silent "no PostHog pageviews from $APPHOST in the 2h before $PH_END_ISO (working hours); last at ${lastpv:0:19}Z: capture or the query may be broken" \
    "$(jq -nc --arg h "$APPHOST" --arg q "$silent_q" --arg l "${lastpv:0:19}Z" --argjson n "${pv24:-0}" '{host:$h, lookback:"2h", last_pageview:$l, pageviews_24h:$n, query:$q}')"
  ph_unavailable "no pageviews from $APPHOST in the last 2h of working hours"
elif [ "${pv:-0}" = 0 ]; then
  quiet=" (quiet window; last pageview ${lastpv:0:19}Z, $pv24 in 24h)"
  # Capture worked recently, but an empty window can't prove the frontend is
  # healthy now, so the source is partial rather than ok.
  ph_unavailable "no pageviews in the window, so browser health can't be confirmed; the newest in the last 24h was at ${lastpv:0:19}Z ($pv24 in 24h)"
fi
ph_series posthog.pageviews "$pv" "PostHog pageviews on $APPHOST" '{"rules":["drop"],"drop_hint":"sev2","drop_min_expected":60}'
ph_series posthog.exceptions "$ex" "browser exceptions on $APPHOST" '{"rules":["spike"],"min_spike":30,"hint":"sev2"}'

rows="$(hogql "SELECT coalesce(properties.\$exception_types[1], properties.\$exception_type, '?') AS t,
    substring(coalesce(properties.\$exception_values[1], properties.\$exception_message, ''), 1, 200) AS m,
    coalesce(properties.\$pathname, '') AS p, count() AS c, uniq(distinct_id) AS u
  FROM events WHERE $RANGE AND event = '\$exception' GROUP BY t, m, p ORDER BY c DESC LIMIT 300")" \
  || ph_unavailable "PostHog exception breakdown failed"

agg="$(jq -c '.[]?' <<<"${rows:-[]}" | python3 -c '
import json, sys
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
from normalise import mask, route
agg = {}
for line in sys.stdin:
    t, m, p, c, u = json.loads(line)
    key = (t or "?", mask(m, 100), route(p))
    a = agg.setdefault(key, {"type": key[0], "msg": key[1], "path": key[2], "n": 0, "users": 0, "sample": m[:200]})
    a["n"] += c
    a["users"] += u
for a in sorted(agg.values(), key=lambda a: -a["n"]):
    print(json.dumps(a))
' "$PH_LIB_DIR")"
while read -r a; do
  [ -n "$a" ] || continue
  # Public workflow apps (/<org>/w/<slug>) matter most: anonymous users, no other signal.
  hint="$(jq -r 'if (.path | test("^/:org/w/")) then "sev2" else "sev3" end' <<<"$a")"
  ph_series "posthog.exc:$(jq -r '"\(.type)|\(.msg)|\(.path)"' <<<"$a")" "$(jq -r .n <<<"$a")" \
    "$(jq -r '"browser \(.type) on \(.path): \(.msg)"' <<<"$a")" \
    "$(jq -c --arg h "$hint" '{rules:["new","spike"], min_new:5, min_spike:10, hint:$h, evidence:{users, sample}}' <<<"$a")"
done <<<"$agg"

ph_data summary "$(jq -nc --arg pv "$pv" --arg ex "$ex" --arg u "$exu" --arg h "$APPHOST" \
  --arg top "$(head -3 <<<"$agg" | jq -rs 'map("\(.type) \(.msg[0:50]) x\(.n)") | join("; ")')" \
  --arg q "$quiet" '"\($h): \($pv) pageviews\($q), \($ex) browser exceptions" + (if $ex != "0" then " from \($u) users" else "" end) + (if $top != "" then " (top: \($top))" else "" end)')"
ph_emit
