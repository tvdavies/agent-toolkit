#!/usr/bin/env bash
# Pause and resume Lleverage deployments at the Argo CD level.
#
# Deploys flow: merge to main -> Cloud Build image -> update-infra-repo.sh bumps
# the overlay in lleverage-ai/infrastructure -> Argo CD auto-sync rolls it out.
# Freezing removes `automated` from the ApplicationSet templates, so the
# generated Applications stop auto-syncing. CI keeps building and bumping the
# infra repo; on resume Argo syncs every app to the latest commit, so nothing
# merged during the freeze is lost.
#
# Patching Applications directly does not work: the ApplicationSet controller
# reverts them. The ApplicationSets themselves are applied by hand (kubectl),
# not by Argo, so a patch on them sticks until the next manual apply.
set -euo pipefail

SELF=$(realpath "$0")
INFRA_DIR=${INFRA_DIR:-$HOME/dev/lleverage-ai/infrastructure}
ANN=lleverage.ai/deploy-freeze-automated
ANN_REASON=lleverage.ai/deploy-freeze-reason
ANN_UNTIL=lleverage.ai/deploy-freeze-until
ENV=production

usage() {
  cat <<'EOF'
Usage: deploy-freeze.sh <command> [--env production|staging] [options]

Commands:
  status                     Show freeze state of each ApplicationSet and app auto-sync counts
  pause [--until HH:MM|"YYYY-MM-DD HH:MM"] [--reason TEXT]
                             Remove auto-sync from every ApplicationSet template.
                             --until schedules `resume` with a systemd user timer (local time).
  resume                     Restore the saved auto-sync policy and cancel any scheduled resume
  sync <application>         One-off sync of a single app during a freeze (urgent fixes)

Env: INFRA_DIR (default ~/dev/lleverage-ai/infrastructure) for generated/<env>/kubeconfig.
EOF
}

die() { echo "error: $*" >&2; exit 1; }

CMD=${1:-}; [ -n "$CMD" ] || { usage; exit 1; }; shift
UNTIL="" REASON="" APP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV=$2; shift 2 ;;
    --until) UNTIL=$2; shift 2 ;;
    --reason) REASON=$2; shift 2 ;;
    --from-timer) FROM_TIMER=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) APP=$1; shift ;;
  esac
done
case "$ENV" in production|staging) ;; *) die "--env must be production or staging" ;; esac

export KUBECONFIG=${KUBECONFIG_OVERRIDE:-$INFRA_DIR/generated/$ENV/kubeconfig}
[ -f "$KUBECONFIG" ] || die "kubeconfig not found: $KUBECONFIG"
K() { kubectl -n argocd "$@"; }
UNIT=deploy-freeze-resume-$ENV

appsets() { K get applicationsets -o json; }

status() {
  echo "Environment: $ENV"
  appsets | jq -r --arg a "$ANN" --arg r "$ANN_REASON" --arg u "$ANN_UNTIL" '
    .items[] | [ .metadata.name,
      (if .metadata.annotations[$a] then "FROZEN" else "live" end),
      "auto=" + (.spec.template.spec.syncPolicy.automated | tostring),
      "until=" + (.metadata.annotations[$u] // "-"),
      "reason=" + (.metadata.annotations[$r] // "-") ] | @tsv' | column -t -s $'\t'
  K get applications -o json | jq -r '
    (.items | length) as $all
    | ([.items[] | select(.spec.syncPolicy.automated != null)] | length) as $auto
    | "Applications with auto-sync: \($auto)/\($all)"'
  if systemctl --user list-timers --all --no-legend "$UNIT.timer" 2>/dev/null | grep -q .; then
    echo "Scheduled resume:"; systemctl --user list-timers --all --no-legend "$UNIT.timer"
  else
    echo "Scheduled resume: none"
  fi
}

schedule_resume() {
  local when=$1
  [[ $when =~ ^[0-9]{1,2}:[0-9]{2}$ ]] && when="$(date +%F) $when"
  local epoch; epoch=$(date -d "$when" +%s) || die "cannot parse --until '$1'"
  [ "$epoch" -gt "$(date +%s)" ] || die "--until '$when' is in the past"
  systemctl --user stop "$UNIT.timer" 2>/dev/null || true
  systemd-run --user --unit="$UNIT" --on-calendar="$(date -d "@$epoch" '+%F %T')" \
    --timer-property=AccuracySec=1s \
    --setenv=PATH="$PATH" --setenv=INFRA_DIR="$INFRA_DIR" \
    "$SELF" resume --env "$ENV" --from-timer >/dev/null
  echo "Resume scheduled for $(date -d "@$epoch" '+%F %T %Z') (systemd user unit $UNIT; logs: journalctl --user -u $UNIT)"
}

pause() {
  local until_label=""
  [ -n "$UNTIL" ] && until_label="$UNTIL"
  local names; names=$(appsets | jq -r '.items[].metadata.name')
  [ -n "$names" ] || die "no ApplicationSets found in $ENV"
  for name in $names; do
    local as; as=$(K get applicationset "$name" -o json)
    if jq -e --arg a "$ANN" '.metadata.annotations[$a]' <<<"$as" >/dev/null; then
      echo "$name: already frozen"; continue
    fi
    local saved; saved=$(jq -c '.spec.template.spec.syncPolicy.automated' <<<"$as")
    local patch; patch=$(jq -nc --arg a "$ANN" --arg s "$saved" --arg r "$ANN_REASON" --arg rv "$REASON" \
      --arg u "$ANN_UNTIL" --arg uv "$until_label" '
      {metadata: {annotations: ({($a): $s}
        + (if $rv != "" then {($r): $rv} else {} end)
        + (if $uv != "" then {($u): $uv} else {} end))},
       spec: {template: {spec: {syncPolicy: {automated: null}}}}}')
    K patch applicationset "$name" --type merge -p "$patch" >/dev/null
    echo "$name: frozen (saved automated=$saved)"
  done
  [ -n "$UNTIL" ] && schedule_resume "$UNTIL"
  echo "Waiting for the ApplicationSet controller to propagate..."
  for _ in $(seq 1 12); do
    local n; n=$(K get applications -o json | jq '[.items[] | select(.metadata.ownerReferences[0].kind == "ApplicationSet" and .spec.syncPolicy.automated != null)] | length')
    [ "$n" = 0 ] && { echo "All ApplicationSet-generated apps have auto-sync off."; break; }
    sleep 5
  done
  status
}

resume() {
  local names; names=$(appsets | jq -r --arg a "$ANN" '.items[] | select(.metadata.annotations[$a]) | .metadata.name')
  for name in $names; do
    local saved; saved=$(K get applicationset "$name" -o json | jq -r --arg a "$ANN" '.metadata.annotations[$a]')
    local patch; patch=$(jq -nc --arg a "$ANN" --arg r "$ANN_REASON" --arg u "$ANN_UNTIL" --argjson s "$saved" '
      {metadata: {annotations: {($a): null, ($r): null, ($u): null}},
       spec: {template: {spec: {syncPolicy: {automated: $s}}}}}')
    K patch applicationset "$name" --type merge -p "$patch" >/dev/null
    echo "$name: resumed (automated=$saved)"
  done
  [ -n "$names" ] || echo "Nothing frozen in $ENV."
  if [ "${FROM_TIMER:-0}" != 1 ]; then
    systemctl --user stop "$UNIT.timer" 2>/dev/null && echo "Cancelled scheduled resume." || true
  fi
  sleep 10
  status
}

sync_app() {
  [ -n "$APP" ] || die "sync needs an application name"
  K get application "$APP" >/dev/null || die "application $APP not found"
  K patch application "$APP" --type merge -p \
    '{"operation":{"initiatedBy":{"username":"deploy-freeze"},"sync":{"syncStrategy":{"hook":{}}}}}' >/dev/null
  echo "Sync requested for $APP. Watch: kubectl -n argocd get application $APP -w"
}

case "$CMD" in
  status) status ;;
  pause) pause ;;
  resume) resume ;;
  sync) sync_app ;;
  -h|--help|help) usage ;;
  *) usage; exit 1 ;;
esac
