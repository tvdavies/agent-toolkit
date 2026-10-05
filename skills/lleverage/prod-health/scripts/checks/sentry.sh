#!/usr/bin/env bash
# Sentry: new issues and event-rate spikes per project in the window (read-only API).
# Usage: sentry.sh [--env production|staging] [--window 30m] [--end ISO] [--json] [--raw]
# Token: SENTRY_AUTH_TOKEN, else the [auth] token in ~/.sentryclirc. Never printed.
# Org lleverage (region de.sentry.io). Sentry environments: production (+ legacy
# "prod") and staging. Content-security-policy reports ("Blocked '...' from ...")
# are excluded: the app project is dominated by them.
set -uo pipefail
. "$(dirname "$0")/../lib/common.sh"
[[ " $* " == *" -h "* || " $* " == *" --help "* ]] && { ph_usage "$0"; exit 0; }
ph_parse_common "$@"
ph_result_init sentry
ORG="${SENTRY_ORG:-lleverage}"; API="${SENTRY_API:-https://de.sentry.io/api/0}"

TOKEN="${SENTRY_AUTH_TOKEN:-}"
[ -n "$TOKEN" ] || TOKEN="$(sed -n 's/^[[:space:]]*token[[:space:]]*=[[:space:]]*//p' "$HOME/.sentryclirc" 2>/dev/null | head -1)"
[ -n "$TOKEN" ] || ph_bail "no Sentry token (SENTRY_AUTH_TOKEN or ~/.sentryclirc)"
sentry() { printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -fsS --max-time 30 -K - -G "$API$1" "${@:2}"; }

case "$PH_ENV" in production) ENVQ='environment:[production,prod]' ;; *) ENVQ="environment:$PH_ENV" ;; esac
NOCSP='!title:"Blocked *"'
T=(--data-urlencode "start=$PH_START_ISO" --data-urlencode "end=$PH_END_ISO")

# Events per project and per issue in the window (Discover, errors dataset).
byissue="$(sentry "/organizations/$ORG/events/" --data-urlencode dataset=errors \
  --data-urlencode field=issue --data-urlencode field=title --data-urlencode field=project --data-urlencode 'field=count()' \
  --data-urlencode 'field=count_unique(user)' --data-urlencode "query=$ENVQ $NOCSP" --data-urlencode 'sort=-count()' \
  --data-urlencode per_page=50 "${T[@]}")" || ph_bail "Sentry events API failed (token scope or network)"
byproj="$(sentry "/organizations/$ORG/events/" --data-urlencode dataset=errors --data-urlencode field=project \
  --data-urlencode 'field=count()' --data-urlencode "query=$ENVQ" --data-urlencode per_page=50 "${T[@]}")" \
  || ph_unavailable "Sentry per-project totals failed"

projects="$(sentry "/organizations/$ORG/projects/" 2>/dev/null | jq -c '[.[].slug]')" || { ph_unavailable "Sentry project list failed; per-project volume skipped"; projects='[]'; }
# Every project gets a series, including zero, so "went quiet" is detectable -
# but only when the totals query itself succeeded (a failed query is not zero).
jq -e '.data | type == "array"' <<<"${byproj:-null}" >/dev/null 2>&1 || projects='[]'
for p in $(jq -r '.[]' <<<"$projects"); do
  n="$(jq -r --arg p "$p" '[.data[]? | select(.project == $p) | .["count()"]] | add // 0' <<<"$byproj")"
  ph_series "sentry.events:$p" "$n" "Sentry events in project $p (incl. CSP)" '{"rules":["spike","drop"],"min_spike":50,"hint":"sev3","drop_hint":"sev3"}'
done

while read -r i; do
  [ -n "$i" ] || continue
  ph_series "sentry.issue:$(jq -r '.["issue"]' <<<"$i")" "$(jq -r '.["count()"]' <<<"$i")" \
    "Sentry $(jq -r '"\(.project) \(.issue): \(.title[0:120])"' <<<"$i")" \
    "$(jq -c '{rules:["new","spike"], min_new:5, min_spike:10, hint:"sev3", evidence:{users:.["count_unique(user)"]}}' <<<"$i")"
done < <(jq -c '.data[]?' <<<"$byissue")

# Issues first seen inside the window (any count): always worth a look.
new="$(sentry "/organizations/$ORG/issues/" --data-urlencode "query=is:unresolved firstSeen:>=$PH_START_ISO firstSeen:<=$PH_END_ISO $ENVQ $NOCSP" \
  --data-urlencode limit=25 --data-urlencode statsPeriod=24h)" || ph_unavailable "Sentry issues API failed"
while read -r i; do
  [ -n "$i" ] || continue
  ph_finding sev3 "sentry.new:$(jq -r .shortId <<<"$i")" \
    "$(jq -r '"new Sentry issue \(.shortId) in \(.project.slug): \(.title[0:120]) (\(.count) events, \(.userCount) users)"' <<<"$i")" \
    "$(jq -c '{link: .permalink, level, firstSeen, culprit: (.culprit // "")[0:120]}' <<<"$i")"
done < <(jq -c '.[]?' <<<"${new:-[]}")

ph_data summary "$(jq -nc --argjson p "${byproj:-{\}}" --argjson n "${new:-[]}" \
  '"events by project: " + ([$p.data[]? | "\(.project)=\(.["count()"])"] | join(" ") | if . == "" then "none" else . end)
   + "; new issues: \($n | length)"')"
ph_emit
