#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "pr view" ]]; then
  printf '%s\n' '{"number":5938,"headRefOid":"3fe402e15f8fe7403b4edd8d6975b807c369068e","url":"https://github.com/lleverage-ai/lleverage/pull/5938","additions":11,"deletions":6,"author":{"login":"bethandutton"}}'
elif [[ "$1 $2" == "pr comment" ]]; then
  [[ -n "${GH_CALL_LOG:-}" ]] && echo comment >> "$GH_CALL_LOG"
  if [[ -n "${GH_COMMENT_BODY_CAPTURE:-}" ]]; then
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--body-file" ]]; then cp "$2" "$GH_COMMENT_BODY_CAPTURE"; break; fi
      shift
    done
  fi
  echo 'https://github.com/lleverage-ai/lleverage/pull/5938#issuecomment-123'
elif [[ "$1 $2 $3" == "api user --jq" ]]; then
  echo tvdavies
elif [[ "$1" == "api" ]]; then
  echo '[]'
else
  echo "unexpected gh call: $*" >&2
  exit 1
fi
GH
chmod +x "$TMP/bin/gh"
printf 'Review body\n' > "$TMP/body.md"

result="$TMP/result.json"
PATH="$TMP/bin:$PATH" PRSMASH_REVIEW_RESULT_FILE="$result" \
  "$ROOT/scripts/post-review.sh" --body "$TMP/body.md" --event COMMENT --pr 5938 >/dev/null
jq -e '
  .repo == "lleverage-ai/lleverage"
  and .pr == 5938
  and .head == "3fe402e15f8fe7403b4edd8d6975b807c369068e"
  and .posting == "issue-comment"
  and .event == "COMMENT"
  and .manualApprovalRequired == false
' "$result" >/dev/null

rm "$result"
captured_body="$TMP/comment-body.md"
PATH="$TMP/bin:$PATH" PRSMASH_REVIEW_RESULT_FILE="$result" PRSMASH_TRUSTED_AUTHORS=trusted-user \
  GH_COMMENT_BODY_CAPTURE="$captured_body" \
  "$ROOT/scripts/post-review.sh" --body "$TMP/body.md" --event APPROVE --pr 5938 >/dev/null
jq -e '.posting == "issue-comment" and .manualApprovalRequired == true' "$result" >/dev/null
rg -q 'A human reviewer makes the final approval call' "$captured_body"
if rg -q 'automated approval is limited to a configured set of authors|not approving.*because' "$captured_body"; then
  echo "FAIL: manual sign-off comment exposes the author-gating reason" >&2
  exit 1
fi

rm "$result"
call_log="$TMP/gh-calls.log"
if PATH="$TMP/bin:$PATH" GH_CALL_LOG="$call_log" PRSMASH_REVIEW_RESULT_FILE="$result" \
    PRSMASH_REVIEW_EXPECTED_HEAD=4fe402e15f8fe7403b4edd8d6975b807c369068e \
    "$ROOT/scripts/post-review.sh" --body "$TMP/body.md" --event COMMENT --pr 5938 >/dev/null 2>&1; then
  echo "FAIL: post-review accepted a head that moved after analysis" >&2
  exit 1
fi
[[ ! -e "$result" ]] || { echo "FAIL: stale-head attempt wrote a result" >&2; exit 1; }
[[ ! -e "$call_log" ]] || { echo "FAIL: stale-head attempt posted a comment" >&2; exit 1; }

echo "post-review result tests passed"
