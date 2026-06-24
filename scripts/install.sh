#!/usr/bin/env bash
set -euo pipefail

# Agent Toolkit — one-shot installer.
#
# Does the lot, idempotently: package setup (deps, skill links, Pi package),
# the resident-agent daemon as a systemd --user service, a heartbeat systemd
# timer, and lingering so it survives logout/reboot.
#
# Usage:
#   scripts/install.sh                  # everything
#   scripts/install.sh --no-service     # extensions only (no daemon/timer)
#   scripts/install.sh --no-schedule    # daemon, but no heartbeat timer
#   scripts/install.sh --no-linger      # skip the one sudo (enable-linger)
#
# Secrets (Slack, spend cap) are NOT required — the daemon runs without them.
# Add them to ~/.config/agent-toolkit/serve.env afterwards and restart.

WITH_SERVICE=true
WITH_SCHEDULE=true
WITH_LINGER=true
for arg in "$@"; do
  case "$arg" in
    --no-service) WITH_SERVICE=false ;;
    --no-schedule) WITH_SCHEDULE=false ;;
    --no-linger) WITH_LINGER=false ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd -P)"
INSTANCE=agent-toolkit
CONFIG="$HOME/.config/$INSTANCE"
UNITDIR="$HOME/.config/systemd/user"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }; }
need node; need pi; need git; need npm
command -v rg   >/dev/null 2>&1 || echo "warning: ripgrep (rg) not found — brain recall needs it" >&2
command -v tadu >/dev/null 2>&1 || echo "note: tadu not found — work-store visibility is optional" >&2

NODE_BIN="$(command -v node)"
RUNTIME=("$NODE_BIN" --experimental-transform-types --no-warnings)

echo "==> Agent Toolkit install (repo: $REPO)"

# 1. Package setup: deps, skill links, Pi package, third-party packages.
echo "==> [1/5] package setup"
"$REPO/scripts/bootstrap.sh"

if [ "$WITH_SERVICE" != true ]; then
  echo "==> Done (extensions only). Run /reload in a Pi session to load them."
  exit 0
fi

# 2. Render the daemon unit, launcher, and 0600 env file (paths baked in).
echo "==> [2/5] daemon artefacts -> $CONFIG"
"${RUNTIME[@]}" "$REPO/bin/toolkit-daemon.ts" --write-units >/dev/null
chmod 0755 "$CONFIG/launch.sh"
mkdir -p "$UNITDIR"
cp "$CONFIG/$INSTANCE.service" "$UNITDIR/$INSTANCE.service"

# 3. Heartbeat schedule via a systemd user timer (no crontab needed).
if [ "$WITH_SCHEDULE" = true ]; then
  echo "==> [3/5] heartbeat timer (every 30 min)"
  cat > "$UNITDIR/$INSTANCE-heartbeat.service" <<EOF
[Unit]
Description=Agent Toolkit heartbeat trigger
[Service]
Type=oneshot
ExecStart=/usr/bin/env bash -lc 'source $CONFIG/serve.env 2>/dev/null; exec $NODE_BIN --experimental-transform-types --no-warnings $REPO/bin/toolkit-trigger.ts --cron-job heartbeat'
EOF
  cat > "$UNITDIR/$INSTANCE-heartbeat.timer" <<EOF
[Unit]
Description=Agent Toolkit heartbeat every 30 min
[Timer]
OnCalendar=*:0/30
Persistent=true
[Install]
WantedBy=timers.target
EOF
else
  echo "==> [3/5] heartbeat timer skipped (--no-schedule)"
fi

# 4. Survive logout/reboot (the only sudo).
if [ "$WITH_LINGER" = true ]; then
  echo "==> [4/5] enable-linger (sudo)"
  sudo loginctl enable-linger "$USER" || echo "warning: enable-linger failed; the service will not persist across logout"
else
  echo "==> [4/5] linger skipped (--no-linger)"
fi

# 5. Enable + start.
echo "==> [5/5] enable + start"
systemctl --user daemon-reload
systemctl --user enable --now "$INSTANCE.service"
[ "$WITH_SCHEDULE" = true ] && systemctl --user enable --now "$INSTANCE-heartbeat.timer"

cat <<EOF

==> Agent Toolkit is running.
   Status   : systemctl --user status $INSTANCE.service
   Logs     : journalctl --user -u $INSTANCE.service -f
   Dashboard: http://127.0.0.1:8788
   Trigger  : ${RUNTIME[*]} $REPO/bin/toolkit-trigger.ts "summarise my open PRs"

   Add secrets (Slack, AGENT_TOOLKIT_DAILY_CAP_USD) to $CONFIG/serve.env
   (keep it chmod 600), then: systemctl --user restart $INSTANCE.service

   In a Pi session, run /reload to load the extensions there too.
EOF
