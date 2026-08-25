#!/usr/bin/env bash
set -euo pipefail

HOST="${POSTHOG_HOST:-https://eu.posthog.com}"
PROJECT_ID="${POSTHOG_PROJECT_ID:-62494}"

api_key() {
  if [[ -n "${POSTHOG_PERSONAL_API_KEY:-}" ]]; then
    printf '%s' "$POSTHOG_PERSONAL_API_KEY"
    return
  fi
  if command -v fish >/dev/null 2>&1; then
    fish -lc 'printf %s "$POSTHOG_PERSONAL_API_KEY"'
  fi
}

KEY="$(api_key)"
if [[ -z "$KEY" ]]; then
  echo "POSTHOG_PERSONAL_API_KEY is not set in this shell or fish config" >&2
  exit 1
fi

usage() {
  cat <<'EOF'
Usage: posthog-debug.sh <command> [args]

Commands:
  whoami                         Check PostHog API access
  ticket <LLE-123>               Read Linear ticket and extract PostHog URLs
  recording <recording-id>       Fetch session recording metadata
  replay <posthog-replay-url>    Fetch recording metadata from URL and query nearby events if possible
  hogql <query>                  Run a HogQL query

Defaults:
  POSTHOG_HOST=https://eu.posthog.com
  POSTHOG_PROJECT_ID=62494
EOF
}

curl_api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" \
      -H "Authorization: Bearer $KEY" \
      -H "Content-Type: application/json" \
      --data "$body" \
      "$HOST$path"
  else
    curl -sS -X "$method" \
      -H "Authorization: Bearer $KEY" \
      -H "Content-Type: application/json" \
      "$HOST$path"
  fi
}

json_string() {
  if command -v jq >/dev/null 2>&1; then
    jq -Rn --arg v "$1" '$v'
  else
    python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
  fi
}

extract_recording_id() {
  local input="$1"
  if [[ "$input" =~ /replay/([^/?#]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    printf '%s' "$input"
  fi
}

extract_t_offset() {
  local input="$1"
  if [[ "$input" =~ [\?\&]t=([0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

run_hogql() {
  local query="$1"
  local q
  q="$(json_string "$query")"
  curl_api POST "/api/projects/$PROJECT_ID/query/" "{\"query\":{\"kind\":\"HogQLQuery\",\"query\":$q}}"
}

command="${1:-}"
case "$command" in
  whoami)
    curl_api GET "/api/users/@me/"
    ;;
  ticket)
    ticket_id="${2:-}"
    if [[ -z "$ticket_id" ]]; then usage; exit 1; fi
    issue_json="$(linear-cli issues get "$ticket_id" --output json --compact --no-pager --quiet)"
    printf '%s\n' "$issue_json"
    printf '\n--- PostHog URLs ---\n'
    printf '%s' "$issue_json" | grep -Eo 'https://eu\.posthog\.com[^] )>"\\]+' || true
    ;;
  recording)
    id="${2:-}"
    if [[ -z "$id" ]]; then usage; exit 1; fi
    curl_api GET "/api/projects/$PROJECT_ID/session_recordings/$id/"
    ;;
  replay)
    url="${2:-}"
    if [[ -z "$url" ]]; then usage; exit 1; fi
    id="$(extract_recording_id "$url")"
    offset="$(extract_t_offset "$url")"
    echo "Recording ID: $id"
    if [[ -n "$offset" ]]; then echo "Replay offset seconds: $offset"; fi
    echo "--- Recording metadata ---"
    metadata="$(curl_api GET "/api/projects/$PROJECT_ID/session_recordings/$id/")"
    printf '%s\n' "$metadata"

    if command -v jq >/dev/null 2>&1; then
      session_id="$(printf '%s' "$metadata" | jq -r '.session_id // .recording_id // .id // empty')"
      distinct_id="$(printf '%s' "$metadata" | jq -r '.distinct_id // .person.distinct_ids[0] // empty')"
      start_time="$(printf '%s' "$metadata" | jq -r '.start_time // .startTime // empty')"
      if [[ -n "$session_id" ]]; then
        echo "--- Events for session ---"
        run_hogql "select timestamp, event, distinct_id, properties.\$current_url, properties.url, properties.path, properties.status, properties.status_code, properties.response_status, properties.\$exception_message from events where properties.\$session_id = '$session_id' order by timestamp asc limit 200"
      elif [[ -n "$distinct_id" && -n "$start_time" ]]; then
        echo "--- Events for distinct_id near recording start ---"
        run_hogql "select timestamp, event, distinct_id, properties.\$current_url, properties.url, properties.path, properties.status, properties.status_code, properties.response_status, properties.\$exception_message from events where distinct_id = '$distinct_id' and timestamp >= toDateTime('$start_time') - interval 10 minute and timestamp <= toDateTime('$start_time') + interval 2 hour order by timestamp asc limit 200"
      fi
    fi
    ;;
  hogql)
    query="${2:-}"
    if [[ -z "$query" ]]; then usage; exit 1; fi
    run_hogql "$query"
    ;;
  *)
    usage
    exit 1
    ;;
esac
