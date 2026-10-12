#!/usr/bin/env bash
# Set up the agent service account's gcloud identity on this machine.
# Idempotent. Keeps the service account in its own config dir so the default
# ~/.config/gcloud (your personal login) is never touched.
set -euo pipefail

DEFAULT_GCLOUD_DIR="$HOME/.config/gcloud"
CONFIG_DIR="${CLOUDSDK_CONFIG:-}"
[[ -z "$CONFIG_DIR" || "$CONFIG_DIR" == "$DEFAULT_GCLOUD_DIR" ]] && CONFIG_DIR="$HOME/.config/gcloud-agent"
KEY="${GOOGLE_APPLICATION_CREDENTIALS:-$CONFIG_DIR/key.json}"
SRC_KEY=""
WRITE_CLAUDE_SETTINGS=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--key <path>] [--config-dir <dir>] [--claude-settings]

  --key <path>         Service account key to install as <config-dir>/key.json
                       (default: use \$GOOGLE_APPLICATION_CREDENTIALS or <config-dir>/key.json)
  --config-dir <dir>   gcloud config dir for the service account
                       (default: \$CLOUDSDK_CONFIG, else ~/.config/gcloud-agent)
  --claude-settings    Add LLEVERAGE_GCP_SERVICE_ACCOUNT, CLOUDSDK_CONFIG,
                       GOOGLE_APPLICATION_CREDENTIALS and CLOUDSDK_CORE_PROJECT
                       to the env block of ~/.claude/settings.json

The service account is read from the key. If LLEVERAGE_GCP_SERVICE_ACCOUNT is
set, the key must belong to that account.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key) [[ -n "${2-}" ]] || { usage >&2; exit 1; }; SRC_KEY="$2"; shift 2 ;;
    --config-dir) [[ -n "${2-}" ]] || { usage >&2; exit 1; }; CONFIG_DIR="$2"; KEY="$2/key.json"; shift 2 ;;
    --claude-settings) WRITE_CLAUDE_SETTINGS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 1 ;;
  esac
done

[[ "$CONFIG_DIR" != "$DEFAULT_GCLOUD_DIR" ]] || { echo "Refusing to use $DEFAULT_GCLOUD_DIR; pick a separate config dir." >&2; exit 1; }

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
if [[ -n "$SRC_KEY" ]]; then
  KEY="$CONFIG_DIR/key.json"
  install -m 600 "$SRC_KEY" "$KEY"
fi
[[ -f "$KEY" ]] || { echo "No key at $KEY. Pass --key <path>." >&2; exit 1; }
[[ "$(jq -r .type "$KEY")" == service_account ]] || { echo "$KEY is not a service account key." >&2; exit 1; }

SA="$(jq -r .client_email "$KEY")"
if [[ -n "${LLEVERAGE_GCP_SERVICE_ACCOUNT:-}" && "$SA" != "$LLEVERAGE_GCP_SERVICE_ACCOUNT" ]]; then
  echo "$KEY is for $SA, but LLEVERAGE_GCP_SERVICE_ACCOUNT is $LLEVERAGE_GCP_SERVICE_ACCOUNT." >&2
  exit 1
fi

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
  jq --arg sa "$SA" --arg dir "$CONFIG_DIR" --arg key "$KEY" \
    '.env = ((.env // {}) + {LLEVERAGE_GCP_SERVICE_ACCOUNT: $sa, CLOUDSDK_CONFIG: $dir, GOOGLE_APPLICATION_CREDENTIALS: $key, CLOUDSDK_CORE_PROJECT: "lleverage"})' \
    "$settings" > "$tmp"
  mv "$tmp" "$settings"
  echo "Updated $settings (backup at $settings.bak-gcloud). New sessions pick it up."
fi

gcloud auth list --filter="account:$SA" --format='value(account)' | grep -qx "$SA"
echo "$SA is active in $CONFIG_DIR."
