#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${AGENT_TOOLS_DIR:-$HOME/agent-skills}"
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"

if ! command -v pi >/dev/null 2>&1; then
  echo "pi is not installed or not on PATH" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed or not on PATH" >&2
  exit 1
fi

ensure_skill_link() {
  local target="$1"
  local link_path="$2"
  local parent
  parent="$(dirname "$link_path")"
  mkdir -p "$parent"

  if [ -e "$link_path" ] && [ ! -L "$link_path" ]; then
    echo "$link_path exists and is not a symlink; refusing to overwrite" >&2
    exit 1
  fi

  ln -sfn "$target" "$link_path"
}

# Install runtime dependencies used by local extensions. Git installs run npm install
# automatically; local-path installs need this explicit step.
if [ -f "$REPO_DIR/package-lock.json" ]; then
  npm ci --omit=dev --prefix "$REPO_DIR"
else
  npm install --omit=dev --prefix "$REPO_DIR"
fi

mkdir -p "$HOME/.pi/agent"
ensure_skill_link "$REPO_DIR/skills" "$HOME/.claude/skills"
ensure_skill_link "$REPO_DIR/skills" "$HOME/.agents/skills"

# Install this repo as a local Pi package for live development.
pi install "$REPO_DIR"

# Install third-party Pi packages from the manifest.
"$REPO_DIR/scripts/sync-pi-packages.sh" --no-update

echo "Agent tooling bootstrap complete."
