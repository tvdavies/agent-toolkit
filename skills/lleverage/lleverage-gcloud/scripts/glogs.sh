#!/usr/bin/env bash
set -euo pipefail

# GCP Cloud Logging wrapper for retained Lleverage GCP services only.
# Kubernetes/app/pod logs are in Loki in the bare-metal Talos clusters.

SCRIPT_NAME="$(basename "$0")"
PROJECT="lleverage"
LIMIT=100
GCLOUD_ACCOUNT=""
FROM=""
TO=""
COMMAND=""
RAW_FILTER=""
BUILD_ID=""
DATABASE_ID="lleverage"

usage() {
    cat <<EOF
Usage: $SCRIPT_NAME <command> [options]

Retained-GCP commands:
  logging-service            Cloud Run logging-service logs
  cloudsql                   Cloud SQL Postgres logs
  cloudbuild                 Cloud Build / CI logs
  query "<filter>"           Raw GCP Logging filter for retained GCP services

Options:
  --staging                  Use lleverage-staging project (default: lleverage)
  --from "<time>"            Start time: relative ("2h ago", "30m ago") or ISO 8601
  --to "<time>"              End time (default: now)
  --limit <n>                Max results (default: 100)
  --account <email>          gcloud account (default: the active account, sal-agent in agent sessions)
  --build-id <id>            Restrict cloudbuild logs to a specific build ID
  --database-id <id>         Restrict cloudsql logs to a database ID substring (default: lleverage)
  -h, --help                 Show this help

Important:
  This wrapper is NOT for Kubernetes namespace, pod, workflow-service, or app logs.
  Lleverage staging/production Kubernetes runs on Talos Linux on Scaleway, not GKE.
  Use the loki-logs skill in git@github.com:lleverage-ai/infrastructure.git for app/pod logs.
EOF
    exit 0
}

die() {
    echo "Error: $1" >&2
    exit 1
}

require_value() {
    local flag="$1"
    local value="${2-}"

    [[ -n "$value" && ! "$value" =~ ^-- ]] || die "$flag requires a value"
}

parse_relative_time() {
    local input="$1"
    if [[ "$input" =~ ^([0-9]+)([mhd])\ *ago$ ]]; then
        local amount="${BASH_REMATCH[1]}"
        local unit="${BASH_REMATCH[2]}"
        case "$unit" in
            m) date -u -d "-${amount} minutes" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
               || date -u -v-"${amount}M" +"%Y-%m-%dT%H:%M:%SZ" ;;
            h) date -u -d "-${amount} hours" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
               || date -u -v-"${amount}H" +"%Y-%m-%dT%H:%M:%SZ" ;;
            d) date -u -d "-${amount} days" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
               || date -u -v-"${amount}d" +"%Y-%m-%dT%H:%M:%SZ" ;;
        esac
    elif [[ "$input" == "now" ]]; then
        date -u +"%Y-%m-%dT%H:%M:%SZ"
    else
        echo "$input"
    fi
}

[[ $# -eq 0 ]] && usage

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage ;;
        --staging) PROJECT="lleverage-staging"; shift ;;
        --from)
            require_value "$1" "${2-}"
            FROM="$2"
            shift 2
            ;;
        --to)
            require_value "$1" "${2-}"
            TO="$2"
            shift 2
            ;;
        --limit)
            require_value "$1" "${2-}"
            LIMIT="$2"
            shift 2
            ;;
        --account)
            require_value "$1" "${2-}"
            GCLOUD_ACCOUNT="$2"
            shift 2
            ;;
        --build-id)
            require_value "$1" "${2-}"
            BUILD_ID="$2"
            shift 2
            ;;
        --database-id)
            require_value "$1" "${2-}"
            DATABASE_ID="$2"
            shift 2
            ;;
        logging-service|cloudsql|cloudbuild)
            COMMAND="$1"
            shift
            ;;
        query)
            COMMAND="$1"
            shift
            [[ $# -gt 0 && ! "$1" =~ ^-- ]] || die "Filter expression required for query"
            RAW_FILTER="$1"
            shift
            ;;
        errors|restarts|events|autoscaler)
            die "'$1' was an old GKE logging command. Kubernetes logs are now in Loki; use the loki-logs skill in the infrastructure repo."
            ;;
        *) die "Unknown argument: $1" ;;
    esac
done

[[ -z "$COMMAND" ]] && die "No command specified. Run with --help for usage."

if [[ -z "$FROM" ]]; then
    FROM_TS="$(parse_relative_time "1h ago")"
else
    FROM_TS="$(parse_relative_time "$FROM")"
fi

if [[ -z "$TO" ]]; then
    TO_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
else
    TO_TS="$(parse_relative_time "$TO")"
fi

TIME_FILTER="timestamp >= \"$FROM_TS\" AND timestamp <= \"$TO_TS\""

case "$COMMAND" in
    logging-service)
        FILTER="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"logging-service\" AND $TIME_FILTER"
        ;;
    cloudsql)
        FILTER="resource.type=\"cloudsql_database\" AND resource.labels.database_id:\"$DATABASE_ID\" AND $TIME_FILTER"
        ;;
    cloudbuild)
        if [[ -n "$BUILD_ID" ]]; then
            FILTER="resource.type=\"build\" AND resource.labels.build_id=\"$BUILD_ID\" AND $TIME_FILTER"
        else
            FILTER="resource.type=\"build\" AND $TIME_FILTER"
        fi
        ;;
    query)
        FILTER="($RAW_FILTER) AND $TIME_FILTER"
        ;;
esac

ACCOUNT_ARGS=()
[[ -n "$GCLOUD_ACCOUNT" ]] && ACCOUNT_ARGS=(--account="$GCLOUD_ACCOUNT")

if ! gcloud auth print-access-token ${ACCOUNT_ARGS[@]+"${ACCOUNT_ARGS[@]}"} &>/dev/null; then
    echo "gcloud is not authenticated (CLOUDSDK_CONFIG=${CLOUDSDK_CONFIG:-default})." >&2
    echo "Run the lleverage-gcloud skill's scripts/setup.sh, or pass --account for an authenticated account." >&2
    exit 1
fi

echo "# Project: $PROJECT"
echo "# Time: $FROM_TS -> $TO_TS"
echo "# Command: $COMMAND"
echo "# Note: Kubernetes app/pod logs are in Loki, not GCP Cloud Logging."
echo "---"

gcloud logging read "$FILTER" \
    --project="$PROJECT" \
    ${ACCOUNT_ARGS[@]+"${ACCOUNT_ARGS[@]}"} \
    --format=json \
    --limit="$LIMIT" \
    --order=asc \
    | jq -r '
if length == 0 then "No results found."
else .[] |
    (.timestamp // "?") as $ts_raw |
    ($ts_raw | split(".")[0] + "Z") as $ts |
    ((.severity // "DEFAULT")[:7]) as $sev |
    .resource as $res |
    ($res.type // "?") as $res_type |
    ($res.labels // {}) as $labels |
    (if .textPayload then .textPayload | gsub("^\\s+|\\s+$"; "")
     elif .jsonPayload then
       if .jsonPayload.message then .jsonPayload.message
       elif .jsonPayload.error then .jsonPayload.error
       else .jsonPayload | tostring
       end
     elif .protoPayload then
       "[" + (.protoPayload.methodName // "?") + "] " + (.protoPayload.status.message // "")
     else "(no payload)"
     end) as $msg_raw |
    (if ($msg_raw | length) > 700 then $msg_raw[:697] + "..." else $msg_raw end) as $msg |
    (if $res_type == "cloud_run_revision" then "cloud-run/" + ($labels.service_name // "?")
     elif $res_type == "cloudsql_database" then "cloudsql/" + ($labels.database_id // "?")
     elif $res_type == "build" then "cloudbuild/" + ($labels.build_id // "?")
     else $res_type
     end) as $location |
    "[\($ts)] \($sev) \($location): \($msg)"
end'
