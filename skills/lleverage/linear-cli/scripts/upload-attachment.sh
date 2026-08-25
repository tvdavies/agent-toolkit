#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_check-deps.sh"

# upload-attachment: Upload a LOCAL FILE and attach it to a Linear issue.
#
# linear-cli's `attachments create` can only link an existing --url; it cannot
# upload a local file. Linear file uploads go through the `fileUpload` GraphQL
# mutation, which returns a presigned (GCS-backed) upload URL + the final
# uploads.linear.app asset URL. This script does the full flow:
#   1. fileUpload mutation  -> presigned uploadUrl + assetUrl + required headers
#   2. PUT the file to uploadUrl with those EXACT headers
#   3. linear-cli attachments create --url <assetUrl>
#
# Usage: upload-attachment.sh ISSUE FILE [OPTIONS]
#   -T, --title TITLE        Attachment title       [default: file basename]
#   -s, --subtitle TEXT      Attachment subtitle/description
#   -c, --content-type CT    MIME type              [default: guessed from extension]
#   --json                   Output created attachment as JSON
#   --help                   Show this help
#
# Requires: curl, jq, and an api_key in ~/.config/linear-cli/config.toml
#           (or the LINEAR_API_KEY env var).
#
# Examples:
#   upload-attachment.sh LLE-10575 ./plan.md
#   upload-attachment.sh LLE-123 ./report.pdf -T "QA report" -s "Run 42"

usage() { sed -n '5,24p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

ISSUE=""
FILE=""
TITLE=""
SUBTITLE=""
CONTENT_TYPE=""
JSON_OUTPUT=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    -T|--title)        TITLE="$2"; shift 2 ;;
    -s|--subtitle)     SUBTITLE="$2"; shift 2 ;;
    -c|--content-type) CONTENT_TYPE="$2"; shift 2 ;;
    --json)            JSON_OUTPUT=true; shift ;;
    -h|--help)         usage 0 ;;
    -*)                echo "Unknown option: $1" >&2; usage 1 ;;
    *)
      if [ -z "$ISSUE" ]; then ISSUE="$1"
      elif [ -z "$FILE" ]; then FILE="$1"
      else echo "Unexpected argument: $1" >&2; usage 1
      fi
      shift ;;
  esac
done

[ -n "$ISSUE" ] && [ -n "$FILE" ] || { echo "ERROR: ISSUE and FILE are required." >&2; usage 1; }
[ -f "$FILE" ] || { echo "ERROR: file not found: $FILE" >&2; exit 1; }
command -v curl >/dev/null || { echo "ERROR: curl is required." >&2; exit 1; }
command -v jq   >/dev/null || { echo "ERROR: jq is required." >&2; exit 1; }

# Resolve API key: env var wins, else linear-cli config.toml
API_KEY="${LINEAR_API_KEY:-}"
if [ -z "$API_KEY" ]; then
  CFG="${XDG_CONFIG_HOME:-$HOME/.config}/linear-cli/config.toml"
  [ -f "$CFG" ] && API_KEY=$(grep -E '^[[:space:]]*api_key' "$CFG" | sed -E 's/^[^=]*=[[:space:]]*"?([^"]+)"?.*/\1/' | head -1)
fi
[ -n "$API_KEY" ] || { echo "ERROR: no API key (set LINEAR_API_KEY or api_key in config.toml)." >&2; exit 1; }

FILENAME=$(basename "$FILE")
[ -n "$TITLE" ] || TITLE="$FILENAME"
SIZE=$(stat -c%s "$FILE" 2>/dev/null || stat -f%z "$FILE")

# Guess content type from extension if not provided
if [ -z "$CONTENT_TYPE" ]; then
  case "${FILENAME##*.}" in
    md|markdown) CONTENT_TYPE="text/markdown" ;;
    txt)  CONTENT_TYPE="text/plain" ;;
    json) CONTENT_TYPE="application/json" ;;
    csv)  CONTENT_TYPE="text/csv" ;;
    pdf)  CONTENT_TYPE="application/pdf" ;;
    png)  CONTENT_TYPE="image/png" ;;
    jpg|jpeg) CONTENT_TYPE="image/jpeg" ;;
    gif)  CONTENT_TYPE="image/gif" ;;
    svg)  CONTENT_TYPE="image/svg+xml" ;;
    html) CONTENT_TYPE="text/html" ;;
    zip)  CONTENT_TYPE="application/zip" ;;
    *)    CONTENT_TYPE="application/octet-stream" ;;
  esac
fi

GQL='mutation FileUpload($contentType:String!,$filename:String!,$size:Int!){fileUpload(contentType:$contentType,filename:$filename,size:$size){success uploadFile{uploadUrl assetUrl headers{key value}}}}'
REQ=$(jq -n --arg ct "$CONTENT_TYPE" --arg fn "$FILENAME" --argjson sz "$SIZE" --arg q "$GQL" \
  '{query:$q, variables:{contentType:$ct,filename:$fn,size:$sz}}')

RESP=$(curl -sS -X POST https://api.linear.app/graphql \
  -H "Authorization: $API_KEY" -H "Content-Type: application/json" -d "$REQ")

if [ "$(echo "$RESP" | jq -r '.data.fileUpload.success // false')" != "true" ]; then
  echo "ERROR: fileUpload mutation failed:" >&2
  echo "$RESP" | jq -r '.errors // .' >&2
  exit 1
fi

UPLOAD_URL=$(echo "$RESP" | jq -r '.data.fileUpload.uploadFile.uploadUrl')
ASSET_URL=$(echo "$RESP" | jq -r '.data.fileUpload.uploadFile.assetUrl')

# Build the PUT header list from the headers Linear returned (these are
# REQUIRED, e.g. x-goog-content-length-range and Content-Disposition), plus
# the Content-Type.
HDR_ARGS=()
while IFS=$'\t' read -r k v; do
  [ -n "$k" ] && HDR_ARGS+=( -H "$k: $v" )
done < <(echo "$RESP" | jq -r '.data.fileUpload.uploadFile.headers[]? | [.key,.value] | @tsv')
HDR_ARGS+=( -H "Content-Type: $CONTENT_TYPE" )

HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT "${HDR_ARGS[@]}" --upload-file "$FILE" "$UPLOAD_URL")
if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "204" ]; then
  echo "ERROR: storage upload failed (HTTP $HTTP_CODE)." >&2
  exit 1
fi

ARGS=( attachments create "$ISSUE" --title "$TITLE" --url "$ASSET_URL"
       --output json --compact --no-pager --quiet )
[ -n "$SUBTITLE" ] && ARGS+=( --subtitle "$SUBTITLE" )

if [ "$JSON_OUTPUT" = true ]; then
  linear-cli "${ARGS[@]}"
else
  linear-cli "${ARGS[@]}" >/dev/null
  echo "✓ Attached '$TITLE' ($CONTENT_TYPE, ${SIZE} bytes) to $ISSUE"
  echo "  $ASSET_URL"
fi
