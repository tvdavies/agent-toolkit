#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_check-deps.sh"

# issue-document: Create a Linear document attached to an issue from a local
# Markdown file, and print its URL. Use it for ticket evidence, long
# investigation detail and the reporter's original words, so the description
# stays short (see the workstream skill's references/issues.md, Writing tickets).
# The document is Linear-hosted and visible only inside the workspace.
#
# Usage: issue-document.sh ISSUE FILE [OPTIONS]
#   -T, --title TITLE   Document title   [default: "ISSUE evidence"]
#   --json              Output the created document as JSON
#   --help              Show this help
#
# Examples:
#   issue-document.sh LLE-123 ./evidence.md
#   issue-document.sh LLE-123 ./report.md -T "LLE-123 original report"

usage() { sed -n '5,18p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

ISSUE=""
FILE=""
TITLE=""
JSON_OUTPUT=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    -T|--title) TITLE="$2"; shift 2 ;;
    --json)     JSON_OUTPUT=true; shift ;;
    -h|--help)  usage 0 ;;
    -*)         echo "Unknown option: $1" >&2; usage 1 ;;
    *)
      if [ -z "$ISSUE" ]; then ISSUE="$(echo "$1" | tr '[:lower:]' '[:upper:]')"
      elif [ -z "$FILE" ]; then FILE="$1"
      else echo "Unexpected argument: $1" >&2; usage 1
      fi
      shift ;;
  esac
done

[ -n "$ISSUE" ] && [ -n "$FILE" ] || { echo "ERROR: ISSUE and FILE are required." >&2; usage 1; }
[ -f "$FILE" ] || { echo "ERROR: file not found: $FILE" >&2; exit 1; }
[ -s "$FILE" ] || { echo "ERROR: file is empty: $FILE" >&2; exit 1; }
command -v jq >/dev/null || { echo "ERROR: jq is required." >&2; exit 1; }
[ -n "$TITLE" ] || TITLE="$ISSUE evidence"

lq() { linear-cli api query "$@" --output json --compact --quiet; }
lm() { linear-cli api mutate "$@" --output json --compact --quiet; }

issue_id="$(lq 'query($id:String!){ issue(id:$id){ id } }' -v id="$ISSUE" | jq -r '(.data // .).issue.id // empty')"
[ -n "$issue_id" ] || { echo "ERROR: issue $ISSUE not found." >&2; exit 1; }

input="$(jq -n --arg i "$issue_id" --arg t "$TITLE" --rawfile c "$FILE" '{issueId:$i, title:$t, content:$c}')"
out="$(lm 'mutation($input: DocumentCreateInput!){ documentCreate(input:$input){ success document{ id title url } } }' \
  -v input="$input" | jq -c '.data // .')"
[ "$(echo "$out" | jq -r '.documentCreate.success // false')" = true ] || { echo "ERROR: documentCreate failed: $out" >&2; exit 1; }

if [ "$JSON_OUTPUT" = true ]; then
  echo "$out" | jq -c '.documentCreate.document'
else
  echo "$out" | jq -r --arg issue "$ISSUE" '.documentCreate.document | "✓ Created \"\(.title)\" on \($issue)\n  \(.url)"'
fi
