#!/usr/bin/env bash
set -euo pipefail

INSTALL_GIT_HOOKS=false
GROUP_ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-git-hooks) INSTALL_GIT_HOOKS=true; shift ;;
    --groups) GROUP_ARGS=(--groups "${2:-}"); shift 2 ;;
    --groups=*) GROUP_ARGS=("$1"); shift ;;
    -h|--help)
      echo "Usage: bootstrap.sh [--groups general,personal,lleverage] [--install-git-hooks]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPO_DIR="${AGENT_TOOLS_DIR:-$DEFAULT_REPO_DIR}"
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"
export AGENT_TOOLS_DIR="$REPO_DIR"

for tool in node npm pi; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is not installed or not on PATH" >&2; exit 1; }
done

if [ -f "$REPO_DIR/package-lock.json" ]; then
  npm ci --omit=dev --prefix "$REPO_DIR"
else
  npm install --omit=dev --prefix "$REPO_DIR"
fi

"$REPO_DIR/scripts/install-skills.sh" "${GROUP_ARGS[@]}"
pi install "$REPO_DIR"
"$REPO_DIR/scripts/sync-workflows.sh"
"$REPO_DIR/scripts/sync-pi-packages.sh" --no-update

if [ "$INSTALL_GIT_HOOKS" = true ]; then
  "$REPO_DIR/scripts/install-git-hooks.sh"
fi

echo "Agent Toolkit bootstrap complete. Run /reload in active Pi sessions."
