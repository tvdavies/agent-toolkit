#!/usr/bin/env bash
# Grant the agent service account ($LLEVERAGE_GCP_SERVICE_ACCOUNT) the project
# roles agents on this machine need, and the few roles it needs on single
# service accounts.
# Run this yourself: it uses your own (tom@) gcloud login, not the service account.
# Agents add roles here (with the task that needs them); Tom runs it.
#
# Usage: grant-roles.sh [--dry-run]
#   --dry-run  list the bindings that are missing and change nothing
#
# Bindings the account already holds are left alone, so a re-run with nothing
# missing changes nothing.
set -euo pipefail

DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "") ;;
  *) echo "Usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

PROJECT=lleverage
SA="${LLEVERAGE_GCP_SERVICE_ACCOUNT:?Set LLEVERAGE_GCP_SERVICE_ACCOUNT to the agent service account email}"
MEMBER="serviceAccount:$SA"

# Use your default gcloud config even if the shell points at the agent one.
export CLOUDSDK_CONFIG="$HOME/.config/gcloud"
unset CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE GOOGLE_APPLICATION_CREDENTIALS

command -v jq >/dev/null 2>&1 || { echo "grant-roles.sh needs jq" >&2; exit 1; }

if ! gcloud auth print-access-token >/dev/null 2>&1; then
  gcloud auth login
fi

ROLES=(
  roles/logging.viewer              # gcloud-logs: Cloud Run / Cloud SQL / Cloud Build logs
  roles/cloudbuild.builds.editor    # list builds, read logs, re-run the PR CI trigger
  roles/storage.bucketViewer        # list buckets (workflow-debugger)
  roles/storage.objectViewer        # read session files in gs://workflow-* (workflow-debugger, agent-session-debugger)
  roles/cloudsql.viewer             # inspect Cloud SQL instances
  roles/run.viewer                  # inspect Cloud Run services (logging-service)
  roles/artifactregistry.reader     # inspect images and repository sizes
  roles/monitoring.viewer           # read metrics and dashboards
  roles/dns.reader                  # read client email domain records
  # roles/dns.admin                 # uncomment only if agents should create DNS records (client-email-domains)
)

# Roles on single service accounts, as "<service account email> <role>".
# Grant on the one account, never project-wide.
SA_ROLES=(
  # The ci (lleverage) trigger (6a84b8b8-5c85-440a-a9e9-2c1b63432059) builds as
  # the default compute account, so running it needs actAs on that account
  # (TASK-1232).
  "815833946946-compute@developer.gserviceaccount.com roles/iam.serviceAccountUser"
)

MISSING=0

# held_roles: the roles MEMBER holds without a condition, from an IAM policy
# (JSON) on stdin.
held_roles() {
  jq -r --arg m "$MEMBER" '.bindings[]? | select(.condition == null and ((.members // []) | index($m))) | .role'
}

held="$(gcloud projects get-iam-policy "$PROJECT" --format=json | held_roles)"
for role in "${ROLES[@]}"; do
  if grep -qxF "$role" <<<"$held"; then
    echo "Has $role"
  elif [[ "$DRY_RUN" == 1 ]]; then
    echo "Would grant $role"
    MISSING=$((MISSING + 1))
  else
    echo "Granting $role"
    gcloud projects add-iam-policy-binding "$PROJECT" \
      --member="$MEMBER" --role="$role" \
      --condition=None --quiet >/dev/null
  fi
done

for entry in "${SA_ROLES[@]}"; do
  read -r target role <<<"$entry"
  held="$(gcloud iam service-accounts get-iam-policy "$target" --project="$PROJECT" --format=json | held_roles)"
  if grep -qxF "$role" <<<"$held"; then
    echo "Has $role on $target"
  elif [[ "$DRY_RUN" == 1 ]]; then
    echo "Would grant $role on $target"
    MISSING=$((MISSING + 1))
  else
    echo "Granting $role on $target"
    gcloud iam service-accounts add-iam-policy-binding "$target" --project="$PROJECT" \
      --member="$MEMBER" --role="$role" \
      --condition=None --quiet >/dev/null
  fi
done

if [[ "$DRY_RUN" == 1 ]]; then
  echo
  echo "Dry run: $MISSING binding(s) missing for $SA; nothing was changed."
  exit 0
fi

echo
echo "Roles now held by $SA on $PROJECT:"
gcloud projects get-iam-policy "$PROJECT" --format=json | held_roles | sort
for entry in "${SA_ROLES[@]}"; do
  read -r target _ <<<"$entry"
  echo "Roles now held by $SA on $target:"
  gcloud iam service-accounts get-iam-policy "$target" --project="$PROJECT" --format=json | held_roles | sort
done
