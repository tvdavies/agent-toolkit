#!/usr/bin/env bash
#
# fetch-conversation.sh must not hide evidence an author already posted.
# lleverage#7250: the author's PostgreSQL results were in a 47K-character PR
# comment, cut to 400 characters, and the review asked for them again.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT="$ROOT/scripts/fetch-conversation.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
fail() { echo "FAIL: $*" >&2; exit 1; }

evidence="PostgreSQL run at 638a9f7: 41 passed. $(printf 'x%.0s' $(seq 1 3000)) END-OF-EVIDENCE"
bot_summary="Walkthrough $(printf 'y%.0s' $(seq 1 800))"
jq -n --arg evidence "$evidence" --arg bot "$bot_summary" '{data:{repository:{pullRequest:{
  reviewThreads:{totalCount:0,nodes:[]},
  reviews:{totalCount:1,nodes:[{fullDatabaseId:1,author:{login:"tvdavies"},state:"COMMENTED",
    body:"short verdict",createdAt:"2026-10-01T10:00:00Z"}]},
  comments:{totalCount:3,nodes:[
    {author:{login:"coderabbitai"},body:$bot,createdAt:"2026-10-01T09:00:00Z"},
    {author:{login:"jefftheai"},body:$evidence,createdAt:"2026-10-01T11:00:00Z"},
    {author:{login:"jefftheai"},body:"The CronJob is on the infrastructure card.",createdAt:"2026-10-01T12:00:00Z"}]}
}}}}' > "$TMP/conversation.json"
cat > "$TMP/bin/gh" <<GH
#!/usr/bin/env bash
cat "$TMP/conversation.json"
GH
chmod +x "$TMP/bin/gh"

run() { PATH="$TMP/bin:$PATH" bash "$SCRIPT" --pr 7250 --repo example/widgets "$@"; }

# Without --full-dir: a person's comment gets a long excerpt and says it was cut.
out=$(run)
line=$(grep '^- \*\*jefftheai\*\* (2026-10-01): PostgreSQL' <<<"$out")
[[ ${#line} -gt 1500 ]] || fail "person excerpt is too short (${#line})"
grep -q '… \[truncated from 3054 chars\]$' <<<"$line" || fail "truncation not marked: ${line: -80}"
bot_line=$(grep '^- \*\*coderabbitai\*\*' <<<"$out")
grep -q 'truncated from 812 chars\]$' <<<"$bot_line" || fail "bot excerpt not cut at the bot limit"
[[ ${#bot_line} -lt 500 ]] || fail "bot excerpt was not kept short"
grep -q 'The CronJob is on the infrastructure card.$' <<<"$out" || fail "short comment altered"
grep -q 'short verdict$' <<<"$out" || fail "short review altered"

# With --full-dir: the complete text is saved and the excerpt points at it.
out=$(run --full-dir "$TMP/full")
grep -q "full text: $TMP/full/comment-1.md\]$" <<<"$out" || fail "excerpt does not name the full file"
grep -q 'END-OF-EVIDENCE' "$TMP/full/comment-1.md" || fail "full evidence not saved"
grep -q '^<!-- jefftheai 2026-10-01T11:00:00Z -->$' "$TMP/full/comment-1.md" || fail "full file lacks author/time"
[[ -f "$TMP/full/comment-0.md" ]] || fail "long bot comment not saved"
[[ ! -e "$TMP/full/comment-2.md" && ! -e "$TMP/full/review-0.md" ]] || fail "short entries were saved"

echo "fetch-conversation tests passed"
