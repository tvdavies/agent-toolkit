#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPO_DIR="${AGENT_TOOLS_DIR:-$DEFAULT_REPO_DIR}"
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"
INSTANCE="${AGENT_TOOLKIT_INSTANCE:-agent-toolkit}"
CONFIG="$HOME/.config/$INSTANCE"
UNITDIR="$HOME/.config/systemd/user"
cd "$REPO_DIR"

FORCE=false
if [ "${1:-}" = "--force" ]; then
  FORCE=true
  shift
fi

OLD_REF="${1:-}"
NEW_REF="${2:-HEAD}"

if [ -z "$OLD_REF" ] && git rev-parse --verify ORIG_HEAD >/dev/null 2>&1; then
  OLD_REF="ORIG_HEAD"
fi

old_ref_is_valid() {
  [ -n "$OLD_REF" ] && git rev-parse --verify "$OLD_REF" >/dev/null 2>&1
}

changed_any() {
  if [ "$FORCE" = true ]; then
    return 0
  fi

  if ! old_ref_is_valid; then
    return 1
  fi

  git diff --name-only "$OLD_REF" "$NEW_REF" -- "$@" | grep -q .
}

run_npm_install() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is not installed or not on PATH; skipping dependency sync" >&2
    return 0
  fi

  if [ -f "$REPO_DIR/package-lock.json" ] && ! changed_any package.json; then
    npm ci --omit=dev --prefix "$REPO_DIR"
  else
    npm install --omit=dev --prefix "$REPO_DIR"
  fi
}

run_brain_install() {
  [ -d "$REPO_DIR/brain" ] || return 0
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun is not installed or not on PATH; skipping bundled Brain dependency sync" >&2
    return 0
  fi

  (
    cd "$REPO_DIR/brain"
    if [ -f bun.lock ]; then
      bun install --frozen-lockfile
    else
      bun install
    fi
  )
}

shell_quote() { printf '%q' "$1"; }

main_service_installed() {
  [ -f "$UNITDIR/$INSTANCE.service" ] && return 0
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user list-unit-files "$INSTANCE.service" >/dev/null 2>&1
}

write_brain_service_unit() {
  [ -x "$REPO_DIR/bin/brain" ] || return 1
  main_service_installed || return 1
  mkdir -p "$CONFIG" "$UNITDIR"
  if [ ! -f "$CONFIG/serve.env" ]; then
    install -m 600 /dev/null "$CONFIG/serve.env"
  fi
  if ! grep -q "AGENT_TOOLKIT_BRAIN_BIN" "$CONFIG/serve.env" 2>/dev/null; then
    printf 'export AGENT_TOOLKIT_BRAIN_BIN=%s\n' "$(shell_quote "$REPO_DIR/bin/brain")" >> "$CONFIG/serve.env"
    chmod 600 "$CONFIG/serve.env"
  fi
  cat > "$UNITDIR/$INSTANCE-brain.service" <<EOF
[Unit]
Description=Agent Toolkit Brain daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=/usr/bin/env bash -lc 'source "$CONFIG/serve.env" 2>/dev/null || true; exec "$REPO_DIR/bin/brain" daemon run'
Restart=always
RestartSec=2
NoNewPrivileges=yes
MemoryMax=2G
TasksMax=256

[Install]
WantedBy=default.target
EOF
}

ensure_skill_link() {
  local target="$1"
  local link_path="$2"
  local parent
  parent="$(dirname "$link_path")"
  mkdir -p "$parent"

  if [ -e "$link_path" ] && [ ! -L "$link_path" ]; then
    echo "$link_path exists and is not a symlink; refusing to overwrite" >&2
    return 1
  fi

  ln -sfn "$target" "$link_path"
}

ensure_pi_package_installed() {
  if ! command -v pi >/dev/null 2>&1; then
    echo "pi is not installed or not on PATH; skipping Pi package sync" >&2
    return 0
  fi

  if pi list 2>/dev/null | grep -Fxq "    $REPO_DIR"; then
    echo "Pi package already points at $REPO_DIR"
  else
    pi install "$REPO_DIR"
  fi
}

needs_reload=false
brain_changed=false

if [ ! -d "$REPO_DIR/node_modules" ] || changed_any package.json package-lock.json; then
  echo "Syncing npm dependencies..."
  run_npm_install
  needs_reload=true
fi

if changed_any brain bin/brain bin/brain-connector-pi-sessions bin/brain-connector-claude-code-sessions; then
  brain_changed=true
fi

if [ -d "$REPO_DIR/brain" ] && { [ ! -d "$REPO_DIR/brain/node_modules" ] || changed_any brain/package.json brain/bun.lock; }; then
  echo "Syncing bundled Brain dependencies..."
  run_brain_install
  needs_reload=true
fi

ensure_skill_link "$REPO_DIR/skills" "$HOME/.claude/skills"
ensure_skill_link "$REPO_DIR/skills" "$HOME/.agents/skills"

ensure_pi_package_installed

if changed_any manifests/pi-packages.json; then
  if [ -x "$REPO_DIR/scripts/sync-pi-packages.sh" ]; then
    echo "Syncing third-party Pi packages..."
    "$REPO_DIR/scripts/sync-pi-packages.sh"
  else
    echo "scripts/sync-pi-packages.sh is missing or not executable; skipping third-party Pi package sync" >&2
  fi
  needs_reload=true
fi

if changed_any extensions skills prompts themes brain bin package.json package-lock.json manifests/pi-packages.json; then
  needs_reload=true
fi

if [ "$brain_changed" = true ] && command -v systemctl >/dev/null 2>&1; then
  if write_brain_service_unit; then
    echo "Ensuring $INSTANCE-brain.service is enabled and restarted to load bundled Brain changes..."
    systemctl --user daemon-reload || true
    systemctl --user enable "$INSTANCE-brain.service" || true
    if systemctl --user is-active --quiet "$INSTANCE-brain.service"; then
      systemctl --user restart "$INSTANCE-brain.service" || echo "warning: could not restart $INSTANCE-brain.service" >&2
    else
      systemctl --user start "$INSTANCE-brain.service" || echo "warning: could not start $INSTANCE-brain.service" >&2
    fi
  fi
fi

if [ "$FORCE" = true ] || ! old_ref_is_valid; then
  echo "Agent tooling sync complete. Run /reload in active Pi sessions to pick up changes."
elif [ "$needs_reload" = true ]; then
  echo "Agent tooling sync complete. Run /reload in active Pi sessions to pick up changes."
else
  echo "Agent tooling sync complete. No Pi reload appears necessary."
fi
