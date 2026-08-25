#!/usr/bin/env bash
set -euo pipefail

INSTALL_GIT_HOOKS=false
UPDATE_PI_PACKAGES=false
GROUPS_EXPLICIT=false
GROUP_ARGS=()

usage() {
  cat <<'EOF'
Usage: sync.sh [--groups general,personal,lleverage] [--install-git-hooks] [--update-pi-packages]

Synchronise Agent Toolkit dependencies, managed skills, the local Pi package,
saved workflows, and toolkit-managed third-party Pi packages.

Options:
  --groups VALUE           Replace the complete desired skill group set.
  --groups=VALUE           Equivalent form of --groups.
                           Without this option, reuse this checkout's managed
                           selection, or install all groups on first use.
  --install-git-hooks      Install merge/rebase hooks that rerun this command.
  --update-pi-packages     Run `pi update --extensions` after package reconciliation.
  -h, --help               Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-git-hooks)
      INSTALL_GIT_HOOKS=true
      shift
      ;;
    --update-pi-packages)
      UPDATE_PI_PACKAGES=true
      shift
      ;;
    --groups)
      [ "$#" -ge 2 ] || { echo "--groups requires a value" >&2; exit 2; }
      GROUPS_EXPLICIT=true
      GROUP_ARGS=(--groups "$2")
      shift 2
      ;;
    --groups=*)
      GROUPS_EXPLICIT=true
      GROUP_ARGS=("$1")
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
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

if [ "$GROUPS_EXPLICIT" = false ]; then
  SKILL_STATE="$HOME/.local/state/agent-toolkit/skill-links.json"
  if [ -f "$SKILL_STATE" ]; then
    MANAGED_GROUPS="$(node --input-type=module - "$SKILL_STATE" "$REPO_DIR" <<'NODE'
import fs from "node:fs";

const [statePath, repo] = process.argv.slice(2);
let state;
try {
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
} catch (error) {
  console.error(`Cannot read managed skill state ${statePath}: ${error.message}`);
  process.exit(1);
}

if (!state || typeof state !== "object" || Array.isArray(state) || typeof state.repo !== "string") {
  console.error(`Managed skill state ${statePath} is malformed: expected an object with a string repo field.`);
  process.exit(1);
}
if (state.repo !== repo) process.exit(0);

const validGroups = new Set(["general", "personal", "lleverage"]);
if (state.version !== 1 || !Array.isArray(state.groups) || state.groups.length === 0) {
  console.error(`Managed skill state ${statePath} for ${repo} is malformed: expected version 1 with a non-empty groups array.`);
  process.exit(1);
}
if (state.groups.some((group) => typeof group !== "string" || !validGroups.has(group))) {
  console.error(`Managed skill state ${statePath} for ${repo} contains an invalid skill group.`);
  process.exit(1);
}
if (new Set(state.groups).size !== state.groups.length) {
  console.error(`Managed skill state ${statePath} for ${repo} contains duplicate skill groups.`);
  process.exit(1);
}

console.log(state.groups.join(","));
NODE
)"
    if [ -n "$MANAGED_GROUPS" ]; then
      GROUP_ARGS=(--groups "$MANAGED_GROUPS")
      echo "Reusing managed skill groups for this checkout: $MANAGED_GROUPS"
    fi
  fi
fi

if [ -f "$REPO_DIR/package-lock.json" ]; then
  npm ci --omit=dev --prefix "$REPO_DIR"
else
  npm install --omit=dev --prefix "$REPO_DIR"
fi

"$REPO_DIR/scripts/lib/install-skills.sh" "${GROUP_ARGS[@]}"
pi install "$REPO_DIR"
"$REPO_DIR/scripts/lib/sync-workflows.sh"

if [ "$UPDATE_PI_PACKAGES" = true ]; then
  "$REPO_DIR/scripts/lib/sync-pi-packages.sh"
else
  "$REPO_DIR/scripts/lib/sync-pi-packages.sh" --no-update
fi

if [ "$INSTALL_GIT_HOOKS" = true ]; then
  "$REPO_DIR/scripts/lib/install-git-hooks.sh"
fi

echo "Agent Toolkit sync complete. Run /reload in active Pi sessions."
