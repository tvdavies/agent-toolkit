#!/usr/bin/env bash
# <What this does, in one line> (<TASK-ID or ticket>).
#
# Run it from any shell (fish included):
#   bash <absolute path to this file>
#
# Every change asks first and defaults to No. Saying No stops cleanly; run the
# same command again later and finished steps are skipped.
# Rehearse without changing anything: WIZ_DRY_RUN=1 bash <this file>
#
# Worked example: add read paths to staging's external-secrets OpenBao policy.
# Replace the steps, keep the shape: preflight, then detect -> show -> ask ->
# change -> verify for each change. Each wiz_step ID is what Sal declares for
# the step when it serves the script from the office (request_runbook).

# shellcheck source=../scripts/lib/wizard.sh
. "${WIZARD_LIB:-$HOME/.agents/skills/guided-runbook/scripts/lib/wizard.sh}"

ENV=staging
POLICY=external-secrets
NEW_PATHS=(platform/isolate-sandbox/gcp staging/services/isolate-sandbox)

# grants_read FILE PATH: an active (uncommented) stanza for PATH grants read
# and doesn't deny. Checks the permission, not just that the text is there.
grants_read() {
  awk -v want="path \"$2\"" '
    /^[[:space:]]*#/ { next }
    index($0, want) == 1 || index($0, " " want) { inblock = 1; next }
    inblock && /capabilities/ { caps = caps $0 }
    inblock && /^}/ { inblock = 0 }
    END { exit !(caps ~ /"read"/ && caps !~ /"deny"/) }
  ' "$1"
}

wiz_init "Add isolate-sandbox paths to the $ENV $POLICY policy" 3

wiz_step preflight "Preflight"
need_tools kubectl jq op
use_cluster "$ENV"
openbao_root_token ROOT_TOKEN "$ENV"
openbao_connect ROOT_TOKEN

wiz_step policy "Update the $POLICY policy"
bao policy read "$POLICY" >"$WIZ_TMP/before.hcl"
guard_nonempty "$WIZ_TMP/before.hcl" "The $POLICY policy read"
cp "$WIZ_TMP/before.hcl" "$WIZ_TMP/after.hcl"
for p in "${NEW_PATHS[@]}"; do
  for kind in data metadata; do
    grants_read "$WIZ_TMP/before.hcl" "secret/$kind/$p" && continue
    grep -qF "\"secret/$kind/$p\"" "$WIZ_TMP/before.hcl" \
      && die "secret/$kind/$p is already in $POLICY without read; fix that stanza by hand"
    printf '\npath "secret/%s/%s" {\n  capabilities = ["read"]\n}\n' "$kind" "$p" >>"$WIZ_TMP/after.hcl"
  done
done
if guard_additive "$WIZ_TMP/before.hcl" "$WIZ_TMP/after.hcl"; then
  confirm_or_stop "Write the $POLICY policy with the lines above added?"
  bao policy read "$POLICY" >"$WIZ_TMP/recheck.hcl"
  guard_unchanged "$WIZ_TMP/before.hcl" "$WIZ_TMP/recheck.hcl" "The $POLICY policy"
  bao_with_input "$WIZ_TMP/after.hcl" policy write "$POLICY" -
  ok "$POLICY policy written"
else
  skip "$POLICY already has every path"
fi

wiz_step verify "Verify"
bao policy read "$POLICY" >"$WIZ_TMP/live.hcl"
for p in "${NEW_PATHS[@]}"; do
  if grants_read "$WIZ_TMP/live.hcl" "secret/data/$p" && grants_read "$WIZ_TMP/live.hcl" "secret/metadata/$p"; then
    ok "$p readable by $POLICY"
  elif [[ "$WIZ_DRY_RUN" == 1 ]]; then
    skip "$p not in $POLICY yet (dry run)"
  else
    die "$p is missing from the live $POLICY policy"
  fi
done

wiz_done "Next: answer y at the force-sync prompt."
