#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
export AGENT_TOOLS_DIR="${AGENT_TOOLS_DIR:-$REPO_DIR}"

# Git hooks may pass old/new refs. Reconciliation is intentionally idempotent, so
# always converge dependencies, skill links, the local package, workflows, and
# toolkit-managed third-party packages instead of maintaining a second diff engine.
"$REPO_DIR/scripts/bootstrap.sh"
