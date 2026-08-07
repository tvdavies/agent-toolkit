#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT="$ROOT/scripts/post-review.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$1 $2" == "pr view" ]]; then
  printf '%s\n' "$GH_PR_JSON"
elif [[ "$1 $2" == "pr comment" ]]; then
  [[ -n "${GH_CALL_LOG:-}" ]] && echo comment >> "$GH_CALL_LOG"
  if [[ -n "${GH_COMMENT_BODY_CAPTURE:-}" ]]; then
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--body-file" ]]; then
        cp "$2" "$GH_COMMENT_BODY_CAPTURE"
        break
      fi
      shift
    done
  fi
  echo 'https://github.com/lleverage-ai/lleverage/pull/5938#issuecomment-123'
elif [[ "$1 $2 $3" == "api user --jq" ]]; then
  echo tvdavies
elif [[ "$1" == "api" ]]; then
  has_input=false
  for arg in "$@"; do
    [[ "$arg" == "--input" ]] && has_input=true
  done
  if [[ "$has_input" == true ]]; then
    [[ -n "${GH_CALL_LOG:-}" ]] && echo review >> "$GH_CALL_LOG"
    if [[ -n "${GH_REVIEW_PAYLOAD_CAPTURE:-}" ]]; then
      cat > "$GH_REVIEW_PAYLOAD_CAPTURE"
    else
      cat >/dev/null
    fi
    echo '{"html_url":"https://github.com/lleverage-ai/lleverage/pull/5938#pullrequestreview-123"}'
  else
    echo '[]'
  fi
else
  echo "unexpected gh call: $*" >&2
  exit 1
fi
GH
chmod +x "$TMP/bin/gh"
printf 'Review body\n' > "$TMP/body.md"

result="$TMP/result.json"
call_log="$TMP/gh-calls.log"
captured_body="$TMP/comment-body.md"
review_payload="$TMP/review-payload.json"
stdout_file="$TMP/stdout.log"
stderr_file="$TMP/stderr.log"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pr_json() {
  local author=$1 additions=$2 deletions=$3
  jq -nc \
    --arg author "$author" \
    --argjson additions "$additions" \
    --argjson deletions "$deletions" \
    '{number: 5938,
      headRefOid: "3fe402e15f8fe7403b4edd8d6975b807c369068e",
      url: "https://github.com/lleverage-ai/lleverage/pull/5938",
      additions: $additions,
      deletions: $deletions,
      author: {login: $author}}'
}

run_with_json() {
  local event=$1 json=$2
  shift 2
  rm -f "$result" "$call_log" "$captured_body" "$review_payload" "$stdout_file" "$stderr_file"
  env \
    -u PRSMASH_TRUSTED_AUTHORS \
    -u PRSMASH_APPROVAL_LINE_LIMIT \
    -u PRSMASH_APPROVAL_MAX_LINES \
    -u PRSMASH_AUTO_APPROVE_ALL \
    PATH="$TMP/bin:$PATH" \
    GH_PR_JSON="$json" \
    GH_CALL_LOG="$call_log" \
    GH_COMMENT_BODY_CAPTURE="$captured_body" \
    GH_REVIEW_PAYLOAD_CAPTURE="$review_payload" \
    PRSMASH_REVIEW_RESULT_FILE="$result" \
    "$@" \
    "$SCRIPT" --body "$TMP/body.md" --event "$event" --pr 5938 \
    >"$stdout_file" 2>"$stderr_file"
}

run_case() {
  local event=$1 author=$2 additions=$3 deletions=$4
  shift 4
  run_with_json "$event" "$(pr_json "$author" "$additions" "$deletions")" "$@"
}

assert_approved() {
  jq -e '
    .repo == "lleverage-ai/lleverage"
    and .pr == 5938
    and .head == "3fe402e15f8fe7403b4edd8d6975b807c369068e"
    and .posting == "github-review"
    and .event == "APPROVE"
    and .manualApprovalRequired == false
  ' "$result" >/dev/null || fail "expected an automatic approval result"
  [[ "$(<"$call_log")" == review ]] || fail "expected a GitHub review posting"
  jq -e '.event == "APPROVE"' "$review_payload" >/dev/null \
    || fail "expected APPROVE review payload"
}

assert_manual_approval() {
  jq -e '.posting == "issue-comment" and .event == "COMMENT" and .manualApprovalRequired == true' "$result" >/dev/null \
    || fail "expected a manual-approval issue comment result"
  [[ "$(<"$call_log")" == comment ]] || fail "expected an issue comment posting"
  rg -q 'A human reviewer makes the final approval call' "$captured_body" \
    || fail "manual-approval banner was not posted"
  rg -q 'PRSMASH_MANUAL_APPROVAL_REASON_CODE=untrusted-author-over-line-limit' "$stdout_file" \
    || fail "combined manual-approval reason was not reported"
  if rg -qi 'trusted author|untrusted author|configured set of authors|not approving.*because' "$captured_body"; then
    fail "manual sign-off comment exposes the author-gating reason"
  fi
}

policy=(PRSMASH_TRUSTED_AUTHORS=alice PRSMASH_APPROVAL_LINE_LIMIT=1001)

run_case APPROVE alice 11 6 "${policy[@]}"
assert_approved

run_case APPROVE ALICE 1000 1 "${policy[@]}"
assert_approved

run_case APPROVE beth 700 300 "${policy[@]}"
assert_approved

run_case APPROVE beth 700 301 "${policy[@]}"
assert_manual_approval
rg -q 'reason=untrusted-author-over-line-limit author=beth limit=1001 changed_lines=1001' "$captured_body" \
  || fail "manual-approval marker lacks policy diagnostics"

# The previous prsmash version passed both line-limit variables as empty. Keep
# the skill safe during a staggered rollout by applying the default threshold.
run_case APPROVE beth 700 301 \
  PRSMASH_TRUSTED_AUTHORS=alice \
  PRSMASH_APPROVAL_LINE_LIMIT= \
  PRSMASH_APPROVAL_MAX_LINES=
assert_manual_approval

run_case APPROVE beth 700 301 "${policy[@]}" PRSMASH_AUTO_APPROVE_ALL=
assert_manual_approval

run_case APPROVE beth 5000 5000 \
  PRSMASH_TRUSTED_AUTHORS=alice \
  PRSMASH_APPROVAL_LINE_LIMIT=invalid \
  PRSMASH_AUTO_APPROVE_ALL=TrUe
assert_approved

override_without_policy_metadata=$(jq -nc '{number: 5938,
  headRefOid: "3fe402e15f8fe7403b4edd8d6975b807c369068e",
  url: "https://github.com/lleverage-ai/lleverage/pull/5938"}')
run_with_json APPROVE "$override_without_policy_metadata" \
  PRSMASH_TRUSTED_AUTHORS=alice \
  PRSMASH_APPROVAL_LINE_LIMIT=invalid \
  PRSMASH_AUTO_APPROVE_ALL=true
assert_approved

run_case APPROVE beth 700 301 \
  PRSMASH_TRUSTED_AUTHORS=alice \
  PRSMASH_APPROVAL_MAX_LINES=1001
assert_manual_approval

run_case APPROVE beth 700 301 \
  PRSMASH_TRUSTED_AUTHORS=alice \
  PRSMASH_APPROVAL_LINE_LIMIT=2000 \
  PRSMASH_APPROVAL_MAX_LINES=1001
assert_approved

run_case APPROVE beth 5000 5000 \
  PRSMASH_TRUSTED_AUTHORS= \
  PRSMASH_APPROVAL_LINE_LIMIT=1001
assert_approved

run_case COMMENT beth 5000 5000 "${policy[@]}" PRSMASH_AUTO_APPROVE_ALL=invalid
jq -e '.posting == "issue-comment" and .event == "COMMENT" and .manualApprovalRequired == false' "$result" >/dev/null \
  || fail "COMMENT verdict was changed by approval policy"

run_case REQUEST_CHANGES beth 5000 5000 "${policy[@]}" PRSMASH_AUTO_APPROVE_ALL=invalid
jq -e '.posting == "github-review" and .event == "REQUEST_CHANGES" and .manualApprovalRequired == false' "$result" >/dev/null \
  || fail "REQUEST_CHANGES verdict was changed by approval policy"
jq -e '.event == "REQUEST_CHANGES"' "$review_payload" >/dev/null \
  || fail "expected REQUEST_CHANGES review payload"

if run_case APPROVE beth 11 6 "${policy[@]}" PRSMASH_AUTO_APPROVE_ALL=yes; then
  fail "invalid auto-approval override was accepted"
fi
[[ ! -e "$result" ]] || fail "invalid override wrote a result"
[[ ! -e "$call_log" ]] || fail "invalid override posted to GitHub"

if run_case APPROVE beth 11 6 \
    PRSMASH_TRUSTED_AUTHORS=alice \
    PRSMASH_APPROVAL_LINE_LIMIT=invalid; then
  fail "invalid approval line limit was accepted"
fi
[[ ! -e "$result" ]] || fail "invalid line limit wrote a result"
[[ ! -e "$call_log" ]] || fail "invalid line limit posted to GitHub"

if run_case APPROVE beth 11 6 \
    PRSMASH_TRUSTED_AUTHORS= \
    PRSMASH_APPROVAL_LINE_LIMIT=invalid; then
  fail "invalid approval line limit was ignored with an empty trusted-author list"
fi
[[ ! -e "$result" ]] || fail "invalid line limit with empty trusted list wrote a result"
[[ ! -e "$call_log" ]] || fail "invalid line limit with empty trusted list posted to GitHub"

missing_author=$(jq -nc '{number: 5938,
  headRefOid: "3fe402e15f8fe7403b4edd8d6975b807c369068e",
  url: "https://github.com/lleverage-ai/lleverage/pull/5938",
  additions: 700,
  deletions: 301}')
if run_with_json APPROVE "$missing_author" "${policy[@]}"; then
  fail "missing PR author was accepted while policy was active"
fi
[[ ! -e "$result" ]] || fail "missing author wrote a result"
[[ ! -e "$call_log" ]] || fail "missing author posted to GitHub"

missing_stats=$(jq -nc '{number: 5938,
  headRefOid: "3fe402e15f8fe7403b4edd8d6975b807c369068e",
  url: "https://github.com/lleverage-ai/lleverage/pull/5938",
  author: {login: "beth"}}')
if run_with_json APPROVE "$missing_stats" "${policy[@]}"; then
  fail "missing PR line statistics were accepted while policy was active"
fi
[[ ! -e "$result" ]] || fail "missing line statistics wrote a result"
[[ ! -e "$call_log" ]] || fail "missing line statistics posted to GitHub"

stale_json=$(pr_json beth 11 6)
if run_with_json COMMENT "$stale_json" \
    PRSMASH_REVIEW_EXPECTED_HEAD=4fe402e15f8fe7403b4edd8d6975b807c369068e; then
  fail "post-review accepted a head that moved after analysis"
fi
[[ ! -e "$result" ]] || fail "stale-head attempt wrote a result"
[[ ! -e "$call_log" ]] || fail "stale-head attempt posted to GitHub"

echo "post-review result tests passed"
