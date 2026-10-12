#!/usr/bin/env bash
# Grant sal-agent the project roles agents on this machine need.
# Run this yourself: it uses your own (tom@) gcloud login, not the service account.
# Agents add roles here (with the task that needs them); Tom runs it.
set -euo pipefail

PROJECT=lleverage
SA=sal-agent@lleverage.iam.gserviceaccount.com

# Use Tom's default gcloud config even if the shell points at the sal-agent one.
export CLOUDSDK_CONFIG="$HOME/.config/gcloud"
unset CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE GOOGLE_APPLICATION_CREDENTIALS

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

for role in "${ROLES[@]}"; do
  echo "Granting $role"
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$SA" --role="$role" \
    --condition=None --quiet >/dev/null
done

echo
echo "Roles now held by $SA:"
gcloud projects get-iam-policy "$PROJECT" \
  --flatten=bindings --filter="bindings.members:serviceAccount:$SA" \
  --format='value(bindings.role)' | sort
