#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: get-ticket.sh TEAM-1234" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
issue_id="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
[[ "$issue_id" =~ ^([A-Z][A-Z0-9]*)-([0-9]+)$ ]] || {
  echo "Invalid Linear issue identifier '$1' (expected e.g. LLE-1234)." >&2
  exit 2
}
team_key="${BASH_REMATCH[1]}"
issue_number="${BASH_REMATCH[2]}"

command -v linear-cli >/dev/null 2>&1 || {
  echo "linear-cli is required but was not found on PATH." >&2
  exit 127
}
command -v jq >/dev/null 2>&1 || {
  echo "jq is required but was not found on PATH." >&2
  exit 127
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

direct_out="$tmp_dir/direct.json"
direct_err="$tmp_dir/direct.err"
if linear-cli issues get --comments --retry 3 --no-cache \
  --output json --compact --no-pager --quiet -- "$issue_id" \
  >"$direct_out" 2>"$direct_err"; then
  candidate="$(jq -c --arg id "$issue_id" '
    first(
      (if type == "array" then .[] else . end)
      | select((.id | type) == "string" and ((.identifier // "") | ascii_upcase) == $id)
    ) // empty
  ' "$direct_out" 2>/dev/null || true)"
  if [[ -n "$candidate" ]]; then
    printf '%s\n' "$candidate"
    exit 0
  fi
fi

query='query($number: Float!, $teamKey: String!) {
  issues(
    filter: { number: { eq: $number }, team: { key: { eq: $teamKey } } }
    first: 1
  ) {
    nodes {
      id
      identifier
      title
      description
      url
      branchName
      priorityLabel
      state { name }
      assignee { name email }
      comments { nodes { body createdAt user { name email } } }
    }
  }
}'
fallback_out="$tmp_dir/fallback.json"
fallback_err="$tmp_dir/fallback.err"
if linear-cli api query \
  --variable "number=$issue_number" \
  --variable "teamKey=$team_key" \
  --retry 3 --no-cache --output json --compact --no-pager --quiet \
  -- "$query" >"$fallback_out" 2>"$fallback_err"; then
  candidate="$(jq -c --arg id "$issue_id" '
    first(
      .data.issues.nodes[]?
      | select((.id | type) == "string" and ((.identifier // "") | ascii_upcase) == $id)
    ) // empty
  ' "$fallback_out" 2>/dev/null || true)"
  if [[ -n "$candidate" ]]; then
    printf '%s\n' "$candidate"
    exit 0
  fi
fi

{
  echo "Could not fetch Linear issue $issue_id."
  if [[ -s "$direct_err" ]]; then
    echo "Direct lookup:"
    cat "$direct_err"
  elif [[ -s "$direct_out" ]]; then
    echo "Direct lookup returned malformed or non-matching JSON."
  fi
  echo "Exact identifier fallback also failed."
  if [[ -s "$fallback_err" ]]; then
    cat "$fallback_err"
  elif [[ -s "$fallback_out" ]]; then
    echo "Fallback returned malformed or non-matching JSON."
  fi
} >&2
exit 1
