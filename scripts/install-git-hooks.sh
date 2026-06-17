#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${AGENT_TOOLS_DIR:-$HOME/agent-skills}"
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"
HOOK_DIR="$REPO_DIR/.git/hooks"

if [ ! -d "$HOOK_DIR" ]; then
  echo "Git hook directory not found: $HOOK_DIR" >&2
  exit 1
fi

install_hook() {
  local name="$1"
  local content="$2"
  local hook_path="$HOOK_DIR/$name"

  if [ -e "$hook_path" ] && [ ! -f "$hook_path" ]; then
    echo "$hook_path exists and is not a regular file; refusing to overwrite" >&2
    exit 1
  fi

  if [ -f "$hook_path" ] && ! grep -q "agent-tools after-pull" "$hook_path"; then
    local backup="$hook_path.backup-$(date +%Y%m%d-%H%M%S)"
    cp "$hook_path" "$backup"
    echo "Backed up existing $name hook to $backup"
  fi

  printf '%s\n' "$content" > "$hook_path"
  chmod +x "$hook_path"
  echo "Installed $hook_path"
}

read -r -d '' POST_MERGE <<'HOOK' || true
#!/usr/bin/env bash
# agent-tools after-pull hook
set -u
REPO_DIR="$(git rev-parse --show-toplevel)"
"$REPO_DIR/scripts/after-pull.sh" || {
  status=$?
  echo "agent-tools after-pull hook failed with status $status" >&2
  echo "Run $REPO_DIR/scripts/after-pull.sh --force manually after fixing the issue." >&2
}
exit 0
HOOK

read -r -d '' POST_REWRITE <<'HOOK' || true
#!/usr/bin/env bash
# agent-tools after-pull hook
set -u
case "${1:-}" in
  rebase)
    REPO_DIR="$(git rev-parse --show-toplevel)"
    "$REPO_DIR/scripts/after-pull.sh" || {
      status=$?
      echo "agent-tools after-pull hook failed with status $status" >&2
      echo "Run $REPO_DIR/scripts/after-pull.sh --force manually after fixing the issue." >&2
    }
    ;;
esac
exit 0
HOOK

install_hook post-merge "$POST_MERGE"
install_hook post-rewrite "$POST_REWRITE"

echo "Agent tooling Git hooks installed. They run scripts/after-pull.sh after merge pulls and pull --rebase rewrites."
