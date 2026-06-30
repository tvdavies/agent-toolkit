#!/usr/bin/env bash
set -euo pipefail

# Agent Toolkit — one-shot installer.
#
# Does the lot, idempotently: package setup (deps, skill links, Pi package),
# the resident-agent daemon and Brain daemon as systemd --user services, a
# heartbeat systemd timer, and lingering so it survives logout/reboot.
#
# Usage:
#   scripts/install.sh                  # everything
#   scripts/install.sh --no-service     # extensions only (no daemon/timer/brain service)
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
enable_or_restart_unit() {
  local unit="$1"
  systemctl --user reset-failed "$unit" 2>/dev/null || true
  systemctl --user enable "$unit"
  if systemctl --user is-active --quiet "$unit"; then
    systemctl --user restart "$unit"
  else
    systemctl --user start "$unit"
  fi
}
shell_quote() { printf '%q' "$1"; }
need node; need pi; need git; need npm
[ -d "$REPO/brain" ] && need bun
command -v rg   >/dev/null 2>&1 || echo "warning: ripgrep (rg) not found — brain recall needs it" >&2
command -v tadu >/dev/null 2>&1 || echo "note: tadu not found — work-store visibility is optional" >&2

NODE_BIN="$(command -v node)"
RUNTIME=("$NODE_BIN" --experimental-transform-types --no-warnings)

echo "==> Agent Toolkit install (repo: $REPO)"

# 1. Package setup: deps, skill links, Pi package, third-party packages.
echo "==> [1/6] package setup"
"$REPO/scripts/bootstrap.sh"

# Saved workflows: discovered in-repo from .pi/workflows; copy to the user
# workflow dir so /debug-issue, /implement-ticket, /review-pr work from any repo.
if [ -d "$REPO/.pi/workflows" ]; then
  WF_DIR="$HOME/.pi/agent/workflows"
  mkdir -p "$WF_DIR"
  cp "$REPO/.pi/workflows/"*.ts "$WF_DIR/" 2>/dev/null && echo "==> synced saved workflows -> $WF_DIR"
fi

if [ "$WITH_SERVICE" != true ]; then
  echo "==> Done (extensions only). Run /reload in a Pi session to load them."
  exit 0
fi

# 2. Render the daemon unit, launcher, and 0600 env file (paths baked in).
echo "==> [2/6] daemon artefacts -> $CONFIG"
"${RUNTIME[@]}" "$REPO/bin/toolkit-daemon.ts" --write-units >/dev/null
chmod 0755 "$CONFIG/launch.sh"
mkdir -p "$UNITDIR"
cp "$CONFIG/$INSTANCE.service" "$UNITDIR/$INSTANCE.service"

# write-units preserves an existing env file (to protect secrets), so ensure the
# node/pi paths are present even on a pre-existing serve.env — without them the
# service cannot find pi under systemd's minimal PATH.
if ! grep -q "AGENT_TOOLKIT_PI_BIN" "$CONFIG/serve.env" 2>/dev/null; then
  printf 'export PATH=%s:$PATH\nexport AGENT_TOOLKIT_PI_BIN=%s\n' "$(shell_quote "$(dirname "$NODE_BIN")")" "$(shell_quote "$(command -v pi)")" >> "$CONFIG/serve.env"
  chmod 600 "$CONFIG/serve.env"
fi
if [ -x "$REPO/bin/brain" ] && ! grep -q "AGENT_TOOLKIT_BRAIN_BIN" "$CONFIG/serve.env" 2>/dev/null; then
  printf 'export AGENT_TOOLKIT_BRAIN_BIN=%s\n' "$(shell_quote "$REPO/bin/brain")" >> "$CONFIG/serve.env"
  chmod 600 "$CONFIG/serve.env"
fi

# 3. Brain daemon service. The Pi memory extension talks to Brain via the CLI,
# while this worker drains extraction/maintenance queues in the background.
echo "==> [3/6] brain daemon unit"
if [ -x "$REPO/bin/brain" ]; then
  cat > "$UNITDIR/$INSTANCE-brain.service" <<EOF
[Unit]
Description=Agent Toolkit Brain daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO
ExecStart=/usr/bin/env bash -lc 'source "$CONFIG/serve.env" 2>/dev/null || true; exec "$REPO/bin/brain" daemon run'
Restart=always
RestartSec=2
NoNewPrivileges=yes
MemoryMax=2G
TasksMax=256

[Install]
WantedBy=default.target
EOF
else
  echo "warning: bundled Brain wrapper missing at $REPO/bin/brain; brain daemon service skipped" >&2
  systemctl --user disable --now "$INSTANCE-brain.service" 2>/dev/null || true
  rm -f "$UNITDIR/$INSTANCE-brain.service"
fi

# 4. Heartbeat schedule via a systemd user timer (no crontab needed).
if [ "$WITH_SCHEDULE" = true ]; then
  # The timer interval (OnCalendar) drives the heartbeat frequency; keep it in
  # step with the heartbeat job's schedule in extensions/cron/jobs.ts.
  echo "==> [4/6] heartbeat timer (every 30 min)"
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
# Fire on the dot — the gate's min-interval is the cadence control, so timer
# jitter must not nudge a tick across the interval boundary.
AccuracySec=1s
Persistent=true
[Install]
WantedBy=timers.target
EOF
else
  echo "==> [4/6] heartbeat timer skipped (--no-schedule)"
fi

# 5. Survive logout/reboot (the only sudo).
if [ "$WITH_LINGER" = true ]; then
  echo "==> [5/6] enable-linger (sudo)"
  sudo loginctl enable-linger "$USER" || echo "warning: enable-linger failed; the service will not persist across logout"
else
  echo "==> [5/6] linger skipped (--no-linger)"
fi

# 6. Enable + start.
echo "==> [6/6] enable + start"
systemctl --user daemon-reload
enable_or_restart_unit "$INSTANCE.service"
[ -f "$UNITDIR/$INSTANCE-brain.service" ] && enable_or_restart_unit "$INSTANCE-brain.service"
[ "$WITH_SCHEDULE" = true ] && systemctl --user enable --now "$INSTANCE-heartbeat.timer"

cat <<EOF

==> Agent Toolkit is running.
   Status   : systemctl --user status $INSTANCE.service
   Brain    : systemctl --user status $INSTANCE-brain.service
   Logs     : journalctl --user -u $INSTANCE.service -f
   Dashboard: http://127.0.0.1:8788
   Trigger  : ${RUNTIME[*]} $REPO/bin/toolkit-trigger.ts "summarise my open PRs"

   Add secrets (Slack, AGENT_TOOLKIT_DAILY_CAP_USD) to $CONFIG/serve.env
   (keep it chmod 600), then: systemctl --user restart $INSTANCE.service

   In a Pi session, run /reload to load the extensions there too.
EOF
