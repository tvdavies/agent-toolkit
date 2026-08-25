#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=false
PURGE_CONFIG=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --purge-config) PURGE_CONFIG=true ;;
    -h|--help)
      echo "Usage: remove-legacy-runtime.sh [--dry-run] [--purge-config]"
      echo "Stops, disables, and removes the retired Agent Toolkit user services."
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

INSTANCE="${AGENT_TOOLKIT_INSTANCE:-agent-toolkit}"
UNIT_DIR="$HOME/.config/systemd/user"
CONFIG_DIR="$HOME/.config/$INSTANCE"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
units=(
  "$INSTANCE.service"
  "$INSTANCE-brain.service"
  "$INSTANCE-heartbeat.timer"
  "$INSTANCE-heartbeat.service"
)

run() {
  if [ "$DRY_RUN" = true ]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

if command -v "$SYSTEMCTL_BIN" >/dev/null 2>&1; then
  for unit in "${units[@]}"; do
    if [ "$DRY_RUN" = true ]; then
      run "$SYSTEMCTL_BIN" --user disable --now "$unit"
    else
      "$SYSTEMCTL_BIN" --user disable --now "$unit" 2>/dev/null || true
    fi
  done
else
  echo "warning: systemctl is unavailable; removing unit files only" >&2
fi

for unit in "${units[@]}"; do
  [ -e "$UNIT_DIR/$unit" ] || continue
  run rm -f "$UNIT_DIR/$unit"
done

if [ "$PURGE_CONFIG" = true ]; then
  [ -e "$CONFIG_DIR" ] && run rm -rf "$CONFIG_DIR"
else
  for artifact in launch.sh "$INSTANCE.service" "$INSTANCE-brain.service" "$INSTANCE-heartbeat.service" "$INSTANCE-heartbeat.timer"; do
    [ -e "$CONFIG_DIR/$artifact" ] && run rm -f "$CONFIG_DIR/$artifact"
  done
  [ -f "$CONFIG_DIR/serve.env" ] && echo "Preserved $CONFIG_DIR/serve.env (use --purge-config to remove it)."
fi

if command -v "$SYSTEMCTL_BIN" >/dev/null 2>&1; then
  if [ "$DRY_RUN" = true ]; then run "$SYSTEMCTL_BIN" --user daemon-reload
  else "$SYSTEMCTL_BIN" --user daemon-reload 2>/dev/null || true
  fi
fi

echo "Legacy Agent Toolkit runtime removal complete."
