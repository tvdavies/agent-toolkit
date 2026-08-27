#!/usr/bin/env bash
#
# post-review.sh — Post PR review body comment + optional inline review comments.
#
# Usage:
#   post-review.sh --body FILE --verdict VERDICT [--inline FILE] [--pr NUMBER] [--dry-run]
#   post-review.sh --body FILE --edit-last [--pr NUMBER] [--dry-run]
#
# Arguments:
#   --body FILE       Path to markdown file for the body comment (required)
#   --verdict VERDICT Review verdict: APPROVE | APPROVE_WITH_SUGGESTIONS |
#                     CHANGES_SUGGESTED | REQUEST_CHANGES (required unless
#                     --edit-last). This script alone maps the verdict to the
#                     GitHub review event; callers never choose the event.
#   --inline FILE     Path to JSON file with inline comments (optional)
#   --pr NUMBER       Target a specific PR number (otherwise auto-detected from current branch)
#   --edit-last       Update the most recent comment instead of posting new.
#                     Comment-only: rejected with a verdict that maps to a
#                     review event (APPROVE, APPROVE_WITH_SUGGESTIONS,
#                     REQUEST_CHANGES) — post a fresh review for those.
#   --dry-run         Print what would be posted without actually posting
#
# Environment:
#   PRSMASH_TRUSTED_AUTHORS      Comma/space separated GitHub logins matched
#                                case-insensitively. When set, only untrusted
#                                authors at or above the changed-line limit need
#                                human approval.
#   PRSMASH_APPROVAL_LINE_LIMIT  First additions + deletions count requiring an
#                                untrusted author to get human approval (default:
#                                1001). The legacy PRSMASH_APPROVAL_MAX_LINES alias
#                                is also accepted.
#   PRSMASH_AUTO_APPROVE_ALL     Set to true to bypass author and size gating for
#                                APPROVE events. Accepts true/false only.
#   PRSMASH_REVIEW_RESULT_FILE   Optional path for an atomic machine-readable
#                                posting result consumed by prsmash.
#   PRSMASH_REVIEW_EXPECTED_HEAD When set, refuse to post if the PR moved beyond
#                                the commit that was actually reviewed.
#
# Dependencies: bash, gh, jq, python3

set -euo pipefail

# --- Argument parsing ---

BODY_FILE=""
INLINE_FILE=""
VERDICT=""
EVENT=""
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
        --verdict)  VERDICT="$2"; shift 2 ;;
        --event)
            echo "Error: --event was removed. Pass --verdict (APPROVE | APPROVE_WITH_SUGGESTIONS | CHANGES_SUGGESTED | REQUEST_CHANGES); this script owns the GitHub review event." >&2
            exit 1 ;;
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

# --- Verdict → GitHub event mapping ---
#
# The caller states the review VERDICT; this script alone decides which GitHub
# event that becomes. Reviewers never talk to the review API directly, so an
# approval verdict cannot end up as a plain comment (or the reverse) through a
# caller mistake.
#
#   APPROVE                  -> APPROVE          (real GitHub approval)
#   APPROVE_WITH_SUGGESTIONS -> APPROVE          (real GitHub approval)
#   CHANGES_SUGGESTED        -> COMMENT          (non-blocking issue comment)
#   REQUEST_CHANGES          -> REQUEST_CHANGES  (blocking review)

if [[ "$EDIT_LAST" == true && -z "$VERDICT" ]]; then
    EVENT="COMMENT"
else
    case "$VERDICT" in
        APPROVE|APPROVE_WITH_SUGGESTIONS) EVENT="APPROVE" ;;
        CHANGES_SUGGESTED)                EVENT="COMMENT" ;;
        REQUEST_CHANGES)                  EVENT="REQUEST_CHANGES" ;;
        "")
            echo "Error: --verdict is required (APPROVE | APPROVE_WITH_SUGGESTIONS | CHANGES_SUGGESTED | REQUEST_CHANGES)." >&2
            exit 1 ;;
        *)
            echo "Error: Unknown verdict '$VERDICT'. Valid: APPROVE | APPROVE_WITH_SUGGESTIONS | CHANGES_SUGGESTED | REQUEST_CHANGES." >&2
            exit 1 ;;
    esac
fi

# --edit-last only edits an existing comment body — it can never submit a
# review event. Accepting a review-event verdict here would silently discard
# the event and recreate the approval-in-writing-only failure mode, so refuse
# the combination outright.
if [[ "$EDIT_LAST" == true && -n "$VERDICT" && "$EVENT" != "COMMENT" ]]; then
    echo "Error: --edit-last only edits an existing comment; it cannot carry a review-event verdict (${VERDICT}). Post a fresh review instead." >&2
    exit 1
fi

# --- Detect PR context ---

if [[ -n "$PR_NUMBER_ARG" ]]; then
    # Explicit PR number provided — look it up directly
    PR_JSON=$(gh pr view "$PR_NUMBER_ARG" --json number,headRefOid,url,additions,deletions,author 2>/dev/null || true)
    if [[ -z "$PR_JSON" ]]; then
        echo "Error: PR #${PR_NUMBER_ARG} not found." >&2
        exit 1
    fi
else
    # Auto-detect from current branch
    PR_JSON=$(gh pr view --json number,headRefOid,url,additions,deletions,author 2>/dev/null || true)
    if [[ -z "$PR_JSON" ]]; then
        echo "Error: No open PR found for the current branch." >&2
        exit 1
    fi
fi

PR_NUMBER=$(echo "$PR_JSON" | jq -r '.number')
COMMIT_SHA=$(echo "$PR_JSON" | jq -r '.headRefOid')
PR_URL=$(echo "$PR_JSON" | jq -r '.url')
PR_ADDITIONS=$(echo "$PR_JSON" | jq -r '.additions // empty')
PR_DELETIONS=$(echo "$PR_JSON" | jq -r '.deletions // empty')
PR_AUTHOR=$(echo "$PR_JSON" | jq -r '.author.login // empty')

# Extract owner/repo from PR URL (https://github.com/OWNER/REPO/pull/N)
OWNER_REPO=$(echo "$PR_URL" | sed -E 's|https://github.com/([^/]+/[^/]+)/pull/[0-9]+|\1|')

if [[ -n "${PRSMASH_REVIEW_EXPECTED_HEAD:-}" && "$COMMIT_SHA" != "$PRSMASH_REVIEW_EXPECTED_HEAD" ]]; then
    echo "Error: PR head moved from reviewed commit ${PRSMASH_REVIEW_EXPECTED_HEAD} to ${COMMIT_SHA}; refusing to post a stale review." >&2
    exit 1
fi

echo "PR #${PR_NUMBER} | commit ${COMMIT_SHA:0:8} | ${OWNER_REPO}"

write_prsmash_result() {
    local posting=$1 submitted_event=$2 target tmp
    target="${PRSMASH_REVIEW_RESULT_FILE:-}"
    [[ -n "$target" ]] || return 0
    mkdir -p "$(dirname "$target")"
    tmp=$(mktemp "${target}.tmp.XXXXXX")
    if jq -n \
        --arg repo "$OWNER_REPO" \
        --argjson pr "$PR_NUMBER" \
        --arg head "$COMMIT_SHA" \
        --arg posting "$posting" \
        --arg event "$submitted_event" \
        --argjson manualApprovalRequired "$MANUAL_APPROVAL_REQUIRED" \
        --arg postedAt "$(date -Is)" \
        '{repo: $repo, pr: $pr, head: $head, posting: $posting, event: $event,
          manualApprovalRequired: $manualApprovalRequired, postedAt: $postedAt}' \
        > "$tmp"; then
        mv "$tmp" "$target"
    else
        rm -f "$tmp"
        return 1
    fi
}

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

# --- Body ↔ verdict consistency guard ---
#
# The body's verdict heading is written by the reviewer; the --verdict flag
# drives the GitHub event. If they disagree, one of them is wrong — refuse to
# post rather than publish an approval body without an approval event (or the
# reverse). The check is lenient: a body whose first heading carries no
# recognisable verdict wording is accepted as-is.
if [[ -n "$VERDICT" ]]; then
    BODY_HEADING=$(printf '%s\n' "$BODY_CONTENT" | grep -m1 '^#' || true)
    BODY_HEADING_LC=$(printf '%s' "$BODY_HEADING" | tr '[:upper:]' '[:lower:]')
    BODY_VERDICT=""
    if [[ -n "$BODY_HEADING_LC" ]]; then
        if [[ "$BODY_HEADING_LC" == *"changes requested"* ]]; then
            BODY_VERDICT="REQUEST_CHANGES"
        elif [[ "$BODY_HEADING_LC" == *"changes suggested"* ]]; then
            BODY_VERDICT="CHANGES_SUGGESTED"
        elif [[ "$BODY_HEADING_LC" == *"approved with suggestions"* ]]; then
            BODY_VERDICT="APPROVE_WITH_SUGGESTIONS"
        elif [[ "$BODY_HEADING_LC" == *"approve"* ]]; then
            BODY_VERDICT="APPROVE"
        fi
    fi
    if [[ -n "$BODY_VERDICT" && "$BODY_VERDICT" != "$VERDICT" ]]; then
        echo "Error: --verdict ${VERDICT} contradicts the body's verdict heading (${BODY_HEADING} reads as ${BODY_VERDICT}). Fix the body or the flag; refusing to post." >&2
        exit 1
    fi
fi

MANUAL_APPROVAL_REQUIRED=false
MANUAL_APPROVAL_REASON=""
MANUAL_APPROVAL_REASON_CODE=""
MANUAL_APPROVAL_BANNER_META=""

# Human approval is required only for large PRs by untrusted authors. The global
# override bypasses both checks, but never changes COMMENT or REQUEST_CHANGES.
TRUSTED_AUTHORS="${PRSMASH_TRUSTED_AUTHORS:-}"
APPROVAL_LINE_LIMIT="${PRSMASH_APPROVAL_LINE_LIMIT:-${PRSMASH_APPROVAL_MAX_LINES:-1001}}"
AUTO_APPROVE_ALL=$(printf '%s' "${PRSMASH_AUTO_APPROVE_ALL:-false}" | tr '[:upper:]' '[:lower:]')

# Only an approval can be gated, so the override is only validated when it can act.
if [[ "$EVENT" == "APPROVE" && "$AUTO_APPROVE_ALL" != true && "$AUTO_APPROVE_ALL" != false ]]; then
    echo "Error: PRSMASH_AUTO_APPROVE_ALL must be true or false." >&2
    exit 1
fi

if [[ "$EVENT" == "APPROVE" && "$AUTO_APPROVE_ALL" == false ]]; then
    if ! [[ "$APPROVAL_LINE_LIMIT" =~ ^[0-9]+$ ]] || [[ "$APPROVAL_LINE_LIMIT" -le 0 ]]; then
        echo "Error: PRSMASH_APPROVAL_LINE_LIMIT must be a positive integer." >&2
        exit 1
    fi
fi

if [[ "$EVENT" == "APPROVE" && "$AUTO_APPROVE_ALL" == false &&
      -n "${TRUSTED_AUTHORS//[[:space:],;]/}" ]]; then
    if [[ -z "$PR_AUTHOR" ]]; then
        echo "Error: Could not read PR author for the approval policy." >&2
        exit 1
    fi
    if ! [[ "$PR_ADDITIONS" =~ ^[0-9]+$ ]] || ! [[ "$PR_DELETIONS" =~ ^[0-9]+$ ]]; then
        echo "Error: Could not read PR additions/deletions for the approval policy." >&2
        exit 1
    fi

    AUTHOR_TRUSTED=false
    PR_AUTHOR_LC=$(printf '%s' "$PR_AUTHOR" | tr '[:upper:]' '[:lower:]')
    while IFS= read -r candidate; do
        [[ -n "$candidate" ]] || continue
        if [[ "$candidate" == "$PR_AUTHOR_LC" ]]; then
            AUTHOR_TRUSTED=true
            break
        fi
    done < <(printf '%s\n' "$TRUSTED_AUTHORS" | tr '[:upper:]' '[:lower:]' | tr ',;[:space:]' '\n')

    PR_CHANGED_LINES=$((PR_ADDITIONS + PR_DELETIONS))
    if [[ "$AUTHOR_TRUSTED" != true && "$PR_CHANGED_LINES" -ge "$APPROVAL_LINE_LIMIT" ]]; then
        MANUAL_APPROVAL_REQUIRED=true
        MANUAL_APPROVAL_REASON_CODE="untrusted-author-over-line-limit"
        MANUAL_APPROVAL_REASON="${PR_CHANGED_LINES} changed lines (${PR_ADDITIONS} additions, ${PR_DELETIONS} deletions) from an untrusted author requires final human sign-off"
        MANUAL_APPROVAL_BANNER_META="reason=untrusted-author-over-line-limit author=${PR_AUTHOR} limit=${APPROVAL_LINE_LIMIT} changed_lines=${PR_CHANGED_LINES} additions=${PR_ADDITIONS} deletions=${PR_DELETIONS}"
    fi
fi

if [[ "$MANUAL_APPROVAL_REQUIRED" == true ]]; then
    EVENT="COMMENT"
    BODY_CONTENT=$(printf '<!-- manual-approval-required source=automated-review %s -->\n\n> ⚠️ **Awaiting human approval:** this automated review found nothing merge-blocking. A human reviewer makes the final approval call.\n\n%s' \
        "$MANUAL_APPROVAL_BANNER_META" \
        "$BODY_CONTENT")
    TEMP_BODY_FILE=$(mktemp)
    printf '%s\n' "$BODY_CONTENT" > "$TEMP_BODY_FILE"
    EFFECTIVE_BODY_FILE="$TEMP_BODY_FILE"
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
        write_prsmash_result issue-comment COMMENT
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
    write_prsmash_result github-review "$EVENT"
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
            echo "PRSMASH_MANUAL_APPROVAL_REASON_CODE=${MANUAL_APPROVAL_REASON_CODE}"
        fi
        if [[ "$VALID_COUNT" != "0" ]]; then
            echo "Inline comments: $VALID_COUNT"
        fi
        exit 0
    fi

    gh pr comment "$PR_NUMBER" --body-file "$EFFECTIVE_BODY_FILE"
    write_prsmash_result issue-comment COMMENT
    echo "Posted new PR comment."
    if [[ "$MANUAL_APPROVAL_REQUIRED" == true ]]; then
        echo "Manual approval required: $MANUAL_APPROVAL_REASON"
        echo "PRSMASH_MANUAL_APPROVAL_REQUIRED=true"
        echo "PRSMASH_MANUAL_APPROVAL_REASON_CODE=${MANUAL_APPROVAL_REASON_CODE}"
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

    # A COMMENT posting means this review concluded nothing blocks the merge.
    # A previous CHANGES_REQUESTED review from us would keep blocking regardless,
    # so dismiss it — otherwise the PR deadlocks on a stale verdict.
    if [[ "$MANUAL_APPROVAL_REQUIRED" != true ]]; then
        MY_LOGIN=$(gh api user --jq .login 2>/dev/null || true)
        if [[ -n "$MY_LOGIN" ]]; then
            STALE_BLOCKING_IDS=$(gh api --paginate --slurp "repos/${OWNER_REPO}/pulls/${PR_NUMBER}/reviews" 2>/dev/null \
                | jq -r --arg me "$MY_LOGIN" '
                    [.[] | .[] | select(.user.login == $me)] as $mine
                    | ($mine | map(select(.state == "APPROVED" or .state == "CHANGES_REQUESTED")) | last) as $effective
                    | if $effective != null and $effective.state == "CHANGES_REQUESTED"
                      then $effective.id else empty end' || true)
            for review_id in $STALE_BLOCKING_IDS; do
                if gh api "repos/${OWNER_REPO}/pulls/${PR_NUMBER}/reviews/${review_id}/dismissals" \
                    --method PUT \
                    -f message="Superseded: re-review found no merge-blocking issues (see latest non-blocking comment)." \
                    -f event="DISMISS" >/dev/null 2>&1; then
                    echo "Dismissed stale blocking review ${review_id}."
                else
                    echo "Warning: could not dismiss stale blocking review ${review_id}."
                fi
            done
        fi
    fi
fi
