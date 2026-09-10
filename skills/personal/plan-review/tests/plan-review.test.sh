#!/usr/bin/env bash
# Offline CLI regression tests: fake curl, isolated HOME, no real credentials.
set -euo pipefail
SKILL_DIR=$(cd "$(dirname "$0")/.." && pwd)
PLAN_SH="$SKILL_DIR/scripts/plan.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/home" "$TMP/config/myslop-plans"
export HOME="$TMP/home" XDG_CONFIG_HOME="$TMP/config"
export MYSLOP_PLANS_TOKEN=msp_offline-test-only
export MYSLOP_PLANS_URL=https://plans.myslop.app
export TEST_RECORD="$TMP/requests" TEST_RESPONSE="$TMP/response" TEST_HTTP=200
unset MYSLOP_APPS_TOKEN
export PATH="$TMP/bin:$PATH"
cat > "$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
method=GET url="" body=null auth=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method=$2; shift 2 ;;
    -H) case "$2" in Authorization:*) auth=$2 ;; esac; shift 2 ;;
    --max-time|-w) shift 2 ;;
    -d) [ "$2" = @- ]; body=$(cat); shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
jq -cn --arg method "$method" --arg url "$url" --arg auth "$auth" --argjson body "$body" \
  '{method:$method,url:$url,auth:$auth,body:$body}' >> "$TEST_RECORD"
if [[ "$url" = */comments ]]; then
  printf '{"comments":[]}'
else
  cat "$TEST_RESPONSE"
fi
printf '\n%s' "$TEST_HTTP"
MOCK
chmod +x "$TMP/bin/curl"
printf '{"ok":true,"version":3,"current_version":3,"status":"approved"}' > "$TEST_RESPONSE"

reset_requests() { : > "$TEST_RECORD"; }
assert_request() { jq -es "$1" "$TEST_RECORD" > /dev/null; }
run_failure() {
  local expected=$1; shift
  local code=0
  bash "$PLAN_SH" "$@" > "$TMP/out" 2> "$TMP/err" || code=$?
  [ "$code" -eq "$expected" ] || { echo "expected exit $expected, got $code: $*" >&2; exit 1; }
}

reset_requests
note=$'Rollback "checked"\nSecond line'
bash "$PLAN_SH" approve https://plans.myslop.app/p/0123456789 --version 3 --note "$note" > "$TMP/out"
assert_request 'length == 1 and .[0].method == "POST" and .[0].url == "https://plans.myslop.app/api/agent/plans/0123456789/review" and .[0].body.version == 3 and .[0].body.verdict == "approved"'
jq -es --arg note "$note" '.[0].body.note == $note' "$TEST_RECORD" >/dev/null

for command in request-changes reject; do
  reset_requests
  bash "$PLAN_SH" "$command" 0123456789 --version 3 --note "Add rollback" > "$TMP/out"
  assert_request 'length == 1 and .[0].body.verdict == "changes_requested" and .[0].method == "POST"'
done
reset_requests
bash "$PLAN_SH" review 0123456789 --version 3 --verdict changes_requested > "$TMP/out"
assert_request 'length == 1 and .[0].body == {version:3,verdict:"changes_requested"}'

reset_requests
for version in 0 -1 1.5 1e0 01 nope ''; do
  run_failure 2 approve 0123456789 --version "$version"
done
run_failure 2 approve 0123456789
run_failure 2 approve 0123456789 --version
run_failure 2 review 0123456789 --version 3
run_failure 2 review 0123456789 --version 3 --verdict rejected
run_failure 2 approve 0123456789 --version 3 --verdict changes_requested
run_failure 2 review 0123456789 --version 3 --verdict approved --unknown value
[ ! -s "$TEST_RECORD" ]

# Each failure makes exactly one request; never refreshes/replays a verdict.
for spec in 401:3 403:4 409:5 500:1; do
  export TEST_HTTP=${spec%:*}
  reset_requests
  printf '{"error":"test failure","required_permission":"plans:review","current_version":4}' > "$TEST_RESPONSE"
  run_failure "${spec#*:}" approve 0123456789 --version 3
  assert_request 'length == 1 and .[0].body.version == 3'
  if [ "$TEST_HTTP" = 403 ]; then
    grep -q "existing key's Permissions" "$TMP/err"
    ! grep -q setup.sh "$TMP/err"
  elif [ "$TEST_HTTP" = 409 ]; then
    grep -q 'Do not replay' "$TMP/err"
  fi
done
export TEST_HTTP=200

# The same existing local token file remains the fallback; never rotate it.
unset MYSLOP_PLANS_TOKEN
printf 'msp_existing-file-test' > "$XDG_CONFIG_HOME/myslop-plans/token"
printf '{"ok":true,"token":{"id":"key-id","name":"Existing"},"permissions":["plans:read"]}' > "$TEST_RESPONSE"
reset_requests
bash "$PLAN_SH" verify > "$TMP/out"
assert_request 'length == 1 and .[0].method == "GET" and .[0].url == "https://plans.myslop.app/api/verify" and .[0].auth == "Authorization: Bearer msp_existing-file-test"'
grep -q 'key-id' "$TMP/out"
[ "$(<"$XDG_CONFIG_HOME/myslop-plans/token")" = msp_existing-file-test ]
export MYSLOP_PLANS_TOKEN=msp_explicit-env-test
reset_requests
bash "$PLAN_SH" verify > "$TMP/out"
assert_request '.[0].auth == "Authorization: Bearer msp_explicit-env-test"'

# Review actor identity survives the canonical snapshot; absent metadata stays unknown.
cat > "$TEST_RESPONSE" <<'JSON'
{"id":"0123456789","url":"https://plans.myslop.app/p/0123456789","title":"Test","status":"approved","current_version":3,"unresolved_comment_count":0,"reviews":[{"version":3,"verdict":"approved","by":"Agent · Oracle","created_at":2,"author":{"type":"agent","id":"key-id","name":"Agent · Oracle"}},{"version":2,"verdict":"approved","by":"Legacy","created_at":1}]}
JSON
reset_requests
bash "$PLAN_SH" snapshot 0123456789 > "$TMP/out"
assert_request 'length == 2 and all(.[]; .method == "GET")'
jq -e '.reviews[0].author == null and .reviews[1].author.type == "agent" and .reviews[1].author.id == "key-id"' "$TMP/out" > /dev/null
printf 'PASS: explicit review/approve/request-changes/reject, pinned versions, no retries, existing credentials, permission errors, and snapshot attribution\n'
