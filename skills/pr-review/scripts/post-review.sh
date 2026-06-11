#!/usr/bin/env bash
#
# post-review.sh — Post PR review body comment + optional inline review comments.
#
# Usage:
#   post-review.sh --body FILE [--inline FILE] [--event EVENT] [--pr NUMBER] [--edit-last] [--dry-run]
#
# Arguments:
#   --body FILE      Path to markdown file for the body comment (required)
#   --inline FILE    Path to JSON file with inline comments (optional)
#   --event EVENT    Review event: REQUEST_CHANGES | COMMENT | APPROVE (default: COMMENT)
#   --pr NUMBER      Target a specific PR number (otherwise auto-detected from current branch)
#   --edit-last      Update the most recent comment instead of posting new
#   --dry-run        Print what would be posted without actually posting
#
# Environment:
#   PRSMASH_APPROVAL_LINE_LIMIT  When set, APPROVE events for PRs with additions
#                                + deletions >= this value are posted as comments
#                                so a human can approve manually.
#
# Dependencies: bash, gh, jq, python3

set -euo pipefail

# --- Argument parsing ---

BODY_FILE=""
INLINE_FILE=""
EVENT="COMMENT"
PR_NUMBER_ARG=""
EDIT_LAST=false
DRY_RUN=false
TEMP_BODY_FILE=""

cleanup() {
    if [[ -n "$TEMP_BODY_FILE" ]]; then
        rm -f "$TEMP_BODY_FILE"
    fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
    case "$1" in
        --body)     BODY_FILE="$2"; shift 2 ;;
        --inline)   INLINE_FILE="$2"; shift 2 ;;
        --event)    EVENT="$2"; shift 2 ;;
        --pr)       PR_NUMBER_ARG="$2"; shift 2 ;;
        --edit-last) EDIT_LAST=true; shift ;;
        --dry-run)  DRY_RUN=true; shift ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$BODY_FILE" ]]; then
    echo "Error: --body FILE is required" >&2
    exit 1
fi

if [[ ! -f "$BODY_FILE" ]]; then
    echo "Error: Body file not found: $BODY_FILE" >&2
    exit 1
fi

# --- Detect PR context ---

if [[ -n "$PR_NUMBER_ARG" ]]; then
    # Explicit PR number provided — look it up directly
    PR_JSON=$(gh pr view "$PR_NUMBER_ARG" --json number,headRefOid,url,additions,deletions 2>/dev/null || true)
    if [[ -z "$PR_JSON" ]]; then
        echo "Error: PR #${PR_NUMBER_ARG} not found." >&2
        exit 1
    fi
else
    # Auto-detect from current branch
    PR_JSON=$(gh pr view --json number,headRefOid,url,additions,deletions 2>/dev/null || true)
    if [[ -z "$PR_JSON" ]]; then
        echo "Error: No open PR found for the current branch." >&2
        exit 1
    fi
fi

PR_NUMBER=$(echo "$PR_JSON" | jq -r '.number')
COMMIT_SHA=$(echo "$PR_JSON" | jq -r '.headRefOid')
PR_URL=$(echo "$PR_JSON" | jq -r '.url')
PR_ADDITIONS=$(echo "$PR_JSON" | jq -r '.additions // 0')
PR_DELETIONS=$(echo "$PR_JSON" | jq -r '.deletions // 0')

# Extract owner/repo from PR URL (https://github.com/OWNER/REPO/pull/N)
OWNER_REPO=$(echo "$PR_URL" | sed -E 's|https://github.com/([^/]+/[^/]+)/pull/[0-9]+|\1|')

echo "PR #${PR_NUMBER} | commit ${COMMIT_SHA:0:8} | ${OWNER_REPO}"

# --- Determine posting strategy ---
#
# For APPROVE and REQUEST_CHANGES, always submit a proper GitHub review so the
# approval/request-changes state is set atomically. The body markdown becomes
# the review body. Inline comments (if any) are included in the same review.
#
# For COMMENT events, post a plain issue comment (more prominent in the timeline)
# and then submit inline comments as a separate review if present.
#
# This prevents the situation where the body is posted as a comment but the
# review event is never submitted because there are no inline comments.

BODY_CONTENT=$(cat "$BODY_FILE")
EFFECTIVE_BODY_FILE="$BODY_FILE"
MANUAL_APPROVAL_REQUIRED=false
MANUAL_APPROVAL_REASON=""

APPROVAL_LINE_LIMIT="${PRSMASH_APPROVAL_LINE_LIMIT:-${PRSMASH_APPROVAL_MAX_LINES:-}}"
if [[ "$EVENT" == "APPROVE" && -n "$APPROVAL_LINE_LIMIT" ]]; then
    if ! [[ "$APPROVAL_LINE_LIMIT" =~ ^[0-9]+$ ]] || [[ "$APPROVAL_LINE_LIMIT" -le 0 ]]; then
        echo "Error: PRSMASH_APPROVAL_LINE_LIMIT must be a positive integer." >&2
        exit 1
    fi

    if ! [[ "$PR_ADDITIONS" =~ ^[0-9]+$ ]] || ! [[ "$PR_DELETIONS" =~ ^[0-9]+$ ]]; then
        echo "Error: Could not read PR additions/deletions for approval size check." >&2
        exit 1
    fi

    PR_CHANGED_LINES=$((PR_ADDITIONS + PR_DELETIONS))
    if [[ "$PR_CHANGED_LINES" -ge "$APPROVAL_LINE_LIMIT" ]]; then
        MANUAL_APPROVAL_REQUIRED=true
        MANUAL_APPROVAL_REASON="${PR_CHANGED_LINES} changed lines (${PR_ADDITIONS} additions, ${PR_DELETIONS} deletions) meets or exceeds the automated approval limit of < ${APPROVAL_LINE_LIMIT} lines."
        EVENT="COMMENT"
        BODY_CONTENT=$(printf '<!-- manual-approval-required source=automated-review limit=%s changed_lines=%s additions=%s deletions=%s -->\n\n> ⚠️ **Manual approval required:** %s This automated review is posting its approval verdict as a comment only; a human reviewer must approve manually.\n\n%s' \
            "$APPROVAL_LINE_LIMIT" \
            "$PR_CHANGED_LINES" \
            "$PR_ADDITIONS" \
            "$PR_DELETIONS" \
            "$MANUAL_APPROVAL_REASON" \
            "$BODY_CONTENT")
        TEMP_BODY_FILE=$(mktemp)
        printf '%s\n' "$BODY_CONTENT" > "$TEMP_BODY_FILE"
        EFFECTIVE_BODY_FILE="$TEMP_BODY_FILE"
    fi
fi

IS_REVIEW_EVENT=false
if [[ "$EVENT" == "APPROVE" || "$EVENT" == "REQUEST_CHANGES" ]]; then
    IS_REVIEW_EVENT=true
fi

# --- Step 1: Handle --edit-last ---

if [[ "$EDIT_LAST" == true ]]; then
    if [[ "$DRY_RUN" == true ]]; then
        echo ""
        echo "=== DRY RUN: Update last comment ==="
        echo "Body size: ${#BODY_CONTENT} chars"
    else
        gh pr comment "$PR_NUMBER" --edit-last --body-file "$EFFECTIVE_BODY_FILE"
        echo "Updated existing PR comment."
    fi
    echo "Skipping inline comments (--edit-last mode)."
    exit 0
fi

# --- Step 2: Collect inline comments (if any) ---

VALIDATED_COMMENTS="[]"
VALID_COUNT=0

if [[ -n "$INLINE_FILE" && -f "$INLINE_FILE" ]]; then
    COMMENT_COUNT=$(jq '.comments | length' "$INLINE_FILE" 2>/dev/null || echo "0")

    if [[ "$COMMENT_COUNT" != "0" ]]; then
        echo ""
        echo "Processing ${COMMENT_COUNT} inline comment(s)..."

        # Fetch PR diff and extract valid ranges
        DIFF=$(gh api "repos/${OWNER_REPO}/pulls/${PR_NUMBER}" \
            -H "Accept: application/vnd.github.v3.diff" 2>/dev/null || true)

        if [[ -n "$DIFF" ]]; then
            VALID_RANGES=$(echo "$DIFF" | python3 -c '
import sys, json, re

diff = sys.stdin.read()
ranges = {}
current_file = None

for line in diff.split("\n"):
    m = re.match(r"^\+\+\+ b/(.+)$", line)
    if m:
        current_file = m.group(1)
        if current_file not in ranges:
            ranges[current_file] = []
        continue

    m = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", line)
    if m and current_file:
        start = int(m.group(1))
        count = int(m.group(2)) if m.group(2) else 1
        end = start + count - 1
        ranges[current_file].append([start, end])

print(json.dumps(ranges))
' 2>/dev/null || echo "{}")

            if [[ "$VALID_RANGES" != "{}" ]]; then
                VALIDATED_COMMENTS=$(python3 -c "
import json, sys

with open('$INLINE_FILE') as f:
    data = json.load(f)

ranges = json.loads('''$VALID_RANGES''')
valid = []
skipped = 0

for c in data.get('comments', []):
    path = c.get('path', '')
    line = c.get('line', 0)
    start_line = c.get('start_line')

    if path not in ranges:
        print(f'  Skipped: {path}:{line} — file not in diff', file=sys.stderr)
        skipped += 1
        continue

    in_range = False
    for r_start, r_end in ranges[path]:
        if r_start <= line <= r_end:
            in_range = True
            break

    if not in_range:
        print(f'  Skipped: {path}:{line} — line not in diff hunk', file=sys.stderr)
        skipped += 1
        continue

    comment = {
        'path': path,
        'line': line,
        'side': 'RIGHT',
        'body': c['body']
    }

    if start_line and start_line != line:
        comment['start_line'] = start_line
        comment['start_side'] = 'RIGHT'

    valid.append(comment)

if skipped:
    print(f'  {skipped} comment(s) skipped (outside diff)', file=sys.stderr)

print(json.dumps(valid))
" 2>/dev/null)

                VALID_COUNT=$(echo "$VALIDATED_COMMENTS" | jq 'length' 2>/dev/null || echo "0")
                echo "${VALID_COUNT} inline comment(s) validated."
            else
                echo "Warning: Could not parse diff ranges — skipping inline comments."
            fi
        else
            echo "Warning: Could not fetch PR diff — skipping inline comments."
        fi
    fi
fi

# --- Step 3: Post ---

if [[ "$IS_REVIEW_EVENT" == true ]]; then
    # APPROVE / REQUEST_CHANGES: submit as a single GitHub review (body + inline + event)
    REVIEW_PAYLOAD=$(jq -n \
        --arg event "$EVENT" \
        --arg commit "$COMMIT_SHA" \
        --arg body "$BODY_CONTENT" \
        --argjson comments "$VALIDATED_COMMENTS" \
        '{
            event: $event,
            commit_id: $commit,
            body: $body,
            comments: $comments
        }')

    if [[ "$DRY_RUN" == true ]]; then
        echo ""
        echo "=== DRY RUN: Review ==="
        echo "Event: $EVENT"
        echo "Commit: ${COMMIT_SHA:0:8}"
        echo "Body size: ${#BODY_CONTENT} chars"
        echo "Inline comments: $VALID_COUNT"
        if [[ "$VALID_COUNT" != "0" ]]; then
            echo "$REVIEW_PAYLOAD" | jq '.comments[] | {path, line, start_line}'
        fi
        exit 0
    fi

    RESPONSE=$(echo "$REVIEW_PAYLOAD" | gh api \
        "repos/${OWNER_REPO}/pulls/${PR_NUMBER}/reviews" \
        --method POST \
        --input - 2>&1) || {
        echo ""
        echo "Warning: Review submission failed."
        echo "  $RESPONSE"
        exit 1
    }

    REVIEW_URL=$(echo "$RESPONSE" | jq -r '.html_url // empty' 2>/dev/null || true)
    if [[ -n "$REVIEW_URL" ]]; then
        echo "$REVIEW_URL"
    fi
    echo "Posted ${EVENT} review with ${VALID_COUNT} inline comment(s)."

else
    # COMMENT event: post body as issue comment, then inline comments as separate review
    if [[ "$DRY_RUN" == true ]]; then
        echo ""
        echo "=== DRY RUN: Comment ==="
        echo "Body size: ${#BODY_CONTENT} chars"
        if [[ "$MANUAL_APPROVAL_REQUIRED" == true ]]; then
            echo "Manual approval required: $MANUAL_APPROVAL_REASON"
            echo "PRSMASH_MANUAL_APPROVAL_REQUIRED=true"
        fi
        if [[ "$VALID_COUNT" != "0" ]]; then
            echo "Inline comments: $VALID_COUNT"
        fi
        exit 0
    fi

    gh pr comment "$PR_NUMBER" --body-file "$EFFECTIVE_BODY_FILE"
    echo "Posted new PR comment."
    if [[ "$MANUAL_APPROVAL_REQUIRED" == true ]]; then
        echo "Manual approval required: $MANUAL_APPROVAL_REASON"
        echo "PRSMASH_MANUAL_APPROVAL_REQUIRED=true"
    fi

    if [[ "$VALID_COUNT" != "0" ]]; then
        REVIEW_PAYLOAD=$(jq -n \
            --arg event "COMMENT" \
            --arg commit "$COMMIT_SHA" \
            --argjson comments "$VALIDATED_COMMENTS" \
            '{
                event: $event,
                commit_id: $commit,
                body: "",
                comments: $comments
            }')

        RESPONSE=$(echo "$REVIEW_PAYLOAD" | gh api \
            "repos/${OWNER_REPO}/pulls/${PR_NUMBER}/reviews" \
            --method POST \
            --input - 2>&1) || {
            echo ""
            echo "Warning: Inline review submission failed."
            echo "  $RESPONSE"
            echo "  Body comment was already posted. All findings are visible there."
            exit 0
        }

        echo "Posted inline review with ${VALID_COUNT} comment(s)."
    fi
fi
