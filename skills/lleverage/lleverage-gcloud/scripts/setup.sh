#!/usr/bin/env bash
# Set up the sal-agent gcloud identity for agent sessions on this machine.
# Idempotent. Keeps sal-agent in its own config dir so the default
# ~/.config/gcloud (your personal login) is never touched.
set -euo pipefail

SA=sal-agent@lleverage.iam.gserviceaccount.com
CONFIG_DIR="$HOME/.config/sal-gcloud"
KEY="$CONFIG_DIR/sal.json"
WRITE_CLAUDE_SETTINGS=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--key <path>] [--claude-settings]

  --key <path>        Service account key to install as $KEY
                      (default: use the key already there)
  --claude-settings   Add CLOUDSDK_CONFIG, GOOGLE_APPLICATION_CREDENTIALS and
                      CLOUDSDK_CORE_PROJECT to the env block of ~/.claude/settings.json
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key) [[ -n "${2-}" ]] || { usage >&2; exit 1; }; SRC_KEY="$2"; shift 2 ;;
    --claude-settings) WRITE_CLAUDE_SETTINGS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 1 ;;
  esac
done

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
if [[ -n "${SRC_KEY-}" ]]; then
  install -m 600 "$SRC_KEY" "$KEY"
fi
[[ -f "$KEY" ]] || { echo "No key at $KEY. Pass --key <path>." >&2; exit 1; }

email="$(jq -r .client_email "$KEY")"
[[ "$email" == "$SA" ]] || { echo "$KEY is for $email, expected $SA." >&2; exit 1; }

export CLOUDSDK_CONFIG="$CONFIG_DIR"
unset CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE
gcloud auth activate-service-account "$SA" --key-file="$KEY" --quiet
gcloud config set project lleverage --quiet
gcloud config set disable_usage_reporting true --quiet

if [[ "$WRITE_CLAUDE_SETTINGS" == 1 ]]; then
  settings="$HOME/.claude/settings.json"
  [[ -f "$settings" ]] || echo '{}' > "$settings"
  cp "$settings" "$settings.bak-gcloud"
  tmp="$(mktemp)"
  jq --arg dir "$CONFIG_DIR" --arg key "$KEY" \
    '.env = ((.env // {}) + {CLOUDSDK_CONFIG: $dir, GOOGLE_APPLICATION_CREDENTIALS: $key, CLOUDSDK_CORE_PROJECT: "lleverage"})' \
    "$settings" > "$tmp"
  mv "$tmp" "$settings"
  echo "Updated $settings (backup at $settings.bak-gcloud). New sessions pick it up."
fi

gcloud auth list --filter="account:$SA" --format='value(account)' | grep -qx "$SA"
echo "sal-agent is active in $CONFIG_DIR."
