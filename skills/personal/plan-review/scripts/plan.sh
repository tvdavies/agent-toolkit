#!/usr/bin/env bash
# plans.myslop.app agent-API CLI. Owns token resolution and error translation
# so callers never pre-verify anything: run the command you need and surface
# its error. `snapshot` output is the canonical review state hashed by both the
# planner's seeded plan_feedback wait and the Dispatch reconciler probe.
set -euo pipefail

BASE_URL=${MYSLOP_PLANS_URL:-https://plans.myslop.app}
token=""

usage() {
  cat >&2 <<'USAGE'
Usage: plan.sh COMMAND [ARGS]

  create   --title TITLE [--md FILE]     Create a plan (v1); markdown from FILE or stdin
  revise   PLAN [--note NOTE] [--title TITLE] [--md FILE]
                                         Publish the next version (full markdown)
  status   PLAN                          Status summary: status, versions, reviews,
                                         unresolved_comment_count
  comments PLAN [--since MS]             Comments with authors and block excerpts
  comment  PLAN --body TEXT [--reply-to COMMENT_ID | --block BLOCK_ID]
                                         Agent comment, threaded reply, or block comment
  resolve  PLAN COMMENT_ID               Mark a thread addressed
  markdown PLAN [--version N]            Stored markdown, no token required
  snapshot PLAN                          Canonical review snapshot for wait fingerprints

PLAN is a https://plans.myslop.app/p/<id> URL or bare plan id.
USAGE
  exit 2
}

plan_id() {
  local target=${1:-}
  if [[ "$target" =~ ^https?://[^/]+/p/([A-Za-z0-9_-]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  elif [[ "$target" =~ ^[A-Za-z0-9_-]+$ ]]; then
    printf '%s' "$target"
  else
    echo "plan.sh: unrecognised plan reference: ${target:-<empty>}" >&2
    exit 2
  fi
}

resolve_token() {
  token="${MYSLOP_PLANS_TOKEN:-}"
  if [ -z "$token" ]; then
    local file="${XDG_CONFIG_HOME:-$HOME/.config}/myslop-plans/token"
    if [ -f "$file" ]; then
      token=$(<"$file")
    fi
  fi
  if [ -z "$token" ]; then
    echo "plan.sh: no myslop-plans token. A valid API token is required: set MYSLOP_PLANS_TOKEN, or have the user run in an interactive terminal: curl -fsS $BASE_URL/setup.sh | bash" >&2
    exit 3
  fi
}

api() { # METHOD PATH [--body]   (JSON body on stdin when --body is given)
  local method=$1 path=$2 send_body=${3:-}
  local args=(-sS --max-time 60 -X "$method" -H "Authorization: Bearer $token" -w $'\n%{http_code}')
  if [ "$send_body" = "--body" ]; then
    args+=(-H "Content-Type: application/json" -d @-)
  fi
  local response http body
  response=$(curl "${args[@]}" "$BASE_URL$path") || {
    echo "plan.sh: network failure calling $BASE_URL$path" >&2
    exit 1
  }
  http=${response##*$'\n'}
  body=${response%$'\n'*}
  case "$http" in
    2*) printf '%s\n' "$body" ;;
    401)
      echo "plan.sh: the plan-service API token was rejected (401 unauthorized). It is missing, mistyped, or revoked; mint a valid one: curl -fsS $BASE_URL/setup.sh | bash" >&2
      exit 3
      ;;
    *)
      echo "plan.sh: $method $path failed (HTTP $http): $body" >&2
      exit 1
      ;;
  esac
}

cmd_create() {
  local title="" md_file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --title) title=${2:?}; shift 2 ;;
      --md) md_file=${2:?}; shift 2 ;;
      *) usage ;;
    esac
  done
  [ -n "$title" ] || usage
  resolve_token
  jq -n --arg title "$title" --rawfile md "${md_file:-/dev/stdin}" \
    '{title: $title, markdown: $md}' \
    | api POST /api/agent/plans --body
}

cmd_revise() {
  local id note="" title="" md_file=""
  id=$(plan_id "${1:-}"); shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --note) note=${2:?}; shift 2 ;;
      --title) title=${2:?}; shift 2 ;;
      --md) md_file=${2:?}; shift 2 ;;
      *) usage ;;
    esac
  done
  resolve_token
  jq -n --arg note "$note" --arg title "$title" --rawfile md "${md_file:-/dev/stdin}" \
    '{markdown: $md}
     + (if $note != "" then {note: $note} else {} end)
     + (if $title != "" then {title: $title} else {} end)' \
    | api PUT "/api/agent/plans/$id" --body
}

cmd_status() {
  local id
  id=$(plan_id "${1:-}")
  resolve_token
  api GET "/api/agent/plans/$id"
}

cmd_comments() {
  local id since=""
  id=$(plan_id "${1:-}"); shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --since) since=${2:?}; shift 2 ;;
      *) usage ;;
    esac
  done
  resolve_token
  api GET "/api/agent/plans/$id/comments${since:+?since=$since}"
}

cmd_comment() {
  local id body="" reply_to="" block=""
  id=$(plan_id "${1:-}"); shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --body) body=${2:?}; shift 2 ;;
      --reply-to) reply_to=${2:?}; shift 2 ;;
      --block) block=${2:?}; shift 2 ;;
      *) usage ;;
    esac
  done
  [ -n "$body" ] || usage
  if [ -n "$reply_to" ] && [ -n "$block" ]; then
    echo "plan.sh: --reply-to and --block are mutually exclusive" >&2
    exit 2
  fi
  resolve_token
  jq -n --arg body "$body" --arg to "$reply_to" --arg block "$block" \
    '{body: $body}
     + (if $to != "" then {reply_to: $to} else {} end)
     + (if $block != "" then {block_id: $block} else {} end)' \
    | api POST "/api/agent/plans/$id/comments" --body
}

cmd_resolve() {
  local id cid=${2:-}
  id=$(plan_id "${1:-}")
  [ -n "$cid" ] || usage
  resolve_token
  printf '{}' | api POST "/api/agent/plans/$id/comments/$cid/resolve" --body
}

cmd_markdown() {
  local id version=""
  id=$(plan_id "${1:-}"); shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) version=${2:?}; shift 2 ;;
      *) usage ;;
    esac
  done
  curl -fsS --max-time 60 "$BASE_URL/p/$id/md?plain=1${version:+&v=$version}"
}

cmd_snapshot() {
  local id
  id=$(plan_id "${1:-}")
  resolve_token
  local status_json comments_json
  status_json=$(api GET "/api/agent/plans/$id")
  comments_json=$(api GET "/api/agent/plans/$id/comments")
  # Canonical subset only: stable ordering, no volatile presentation fields.
  jq -n --argjson status "$status_json" --argjson comments "$comments_json" '{
    plan: {
      id: $status.id,
      url: $status.url,
      title: $status.title,
      status: $status.status,
      current_version: $status.current_version,
      unresolved_comment_count: $status.unresolved_comment_count
    },
    reviews: ([$status.reviews[]? | {version, verdict, by, created_at}]
      | sort_by(.created_at, .version, .by, .verdict)),
    comments: ([$comments.comments[]?
      | {id, version, block_id, parent_id, author, body, resolved}]
      | sort_by(.id))
  }'
}

command=${1:-}
[ -n "$command" ] || usage
shift
case "$command" in
  create) cmd_create "$@" ;;
  revise) cmd_revise "$@" ;;
  status) cmd_status "$@" ;;
  comments) cmd_comments "$@" ;;
  comment) cmd_comment "$@" ;;
  resolve) cmd_resolve "$@" ;;
  markdown) cmd_markdown "$@" ;;
  snapshot) cmd_snapshot "$@" ;;
  *) usage ;;
esac
