---
name: lleverage-gcloud
description: Run gcloud against Lleverage's GCP projects as the sal-agent service account, which never needs a re-login. Covers which identity agents use and what it can do, Cloud Logging for the retained GCP services (Cloud Run logging-service, Cloud SQL, Cloud Build), Cloud Build history and CI re-runs, session files in the per-organisation workflow buckets, and setting the identity up on a new machine. Use for any gcloud or gsutil command, "gcloud isn't authenticated" or "Reauthentication failed" errors, Cloud Run/Cloud SQL/Cloud Build logs, or granting the agent account a new GCP permission. Kubernetes, app and pod logs are in Loki, not here.
compatibility: Requires bash, jq and the gcloud CLI. Expects the sal-agent key at ~/.config/sal-gcloud/sal.json (see Setup).
metadata:
  author: tvd
  version: 1.0.0
---

# Lleverage gcloud

Agents run gcloud as `sal-agent@lleverage.iam.gserviceaccount.com`. Its key
lives in its own gcloud config dir, `~/.config/sal-gcloud`, and Claude Code
sessions select it through the `env` block of `~/.claude/settings.json`:

```
CLOUDSDK_CONFIG=~/.config/sal-gcloud
GOOGLE_APPLICATION_CREDENTIALS=~/.config/sal-gcloud/sal.json
CLOUDSDK_CORE_PROJECT=lleverage
```

The key does not expire, so there is no login to refresh. Tom's personal login
stays in the default `~/.config/gcloud` and is for Tom's own terminal only.

## Rules

- Never activate sal-agent inside the default `~/.config/gcloud`, and never run
  `gcloud auth login` from an agent session. If gcloud says "Reauthentication
  failed", the session is using Tom's config: check `echo $CLOUDSDK_CONFIG`,
  then prefix the command with `CLOUDSDK_CONFIG=~/.config/sal-gcloud`.
- Do not hunt for other keys. `dev-agent` belongs to the nightly prod-db-sync
  job, not to agent sessions.
- If sal-agent lacks a permission, stop and tell Tom which role is missing. Add
  it to `scripts/grant-roles.sh` and ask Tom to run it; agents cannot change IAM.
- `gcloud storage buckets list` takes over a minute. Go
  straight to the bucket you need.

Check the identity with:

```bash
gcloud auth list --format='value(account)' --filter=status:ACTIVE
```

## What sal-agent can do

Granted on project `lleverage` by `scripts/grant-roles.sh`:

| Area                    | Role                         | Typical use                                       |
| ----------------------- | ---------------------------- | ------------------------------------------------- |
| Cloud Logging           | `logging.viewer`             | `scripts/glogs.sh`, `gcloud logging read`         |
| Cloud Build             | `cloudbuild.builds.editor`   | build history, step timings, re-run the PR CI     |
| Cloud Storage           | `storage.bucketViewer`, `storage.objectViewer` | session files in `gs://workflow-<org>-bucket` |
| Cloud SQL               | `cloudsql.viewer`            | instance status                                   |
| Cloud Run               | `run.viewer`                 | logging-service revisions                         |
| Artifact Registry       | `artifactregistry.reader`    | images, repository sizes                          |
| Monitoring              | `monitoring.viewer`          | metrics and dashboards                            |
| Cloud DNS               | `dns.reader`                 | client email domain records                       |

It cannot read secrets, change IAM or write DNS records. It can also read Cloud
Build on `lleverage-staging`.

## Logs for the retained GCP services

Staging and production Kubernetes run on Talos on Scaleway. App, pod and
workflow-service logs are in Loki (the `loki-logs` skill in the infrastructure
repo), not Cloud Logging. Cloud Logging only covers:

| Source               | Resource type        |
| -------------------- | -------------------- |
| logging-service      | `cloud_run_revision` |
| Cloud SQL (Postgres) | `cloudsql_database`  |
| Cloud Build          | `build`              |

```bash
scripts/glogs.sh logging-service --from "1h ago" --limit 50
scripts/glogs.sh cloudsql --from "2h ago" --limit 50
scripts/glogs.sh cloudbuild --build-id <id> --from "6h ago"
scripts/glogs.sh query 'resource.type="cloud_run_revision" AND severity>=ERROR'
scripts/glogs.sh cloudbuild --staging --from "1d ago"
```

`glogs.sh` uses the active account; pass `--account` only to override it.

## Cloud Build

All builds run on the private pool in `europe-west2`.

```bash
# Recent PR CI builds (check name `ci (lleverage)`)
gcloud builds list --region=europe-west2 --limit=20 \
  --filter='tags="trigger-6a84b8b8-5c85-440a-a9e9-2c1b63432059"'

# Fresh PR CI run on a branch's current head (rerequest/retry in GitHub do not work)
gcloud builds triggers run 6a84b8b8-5c85-440a-a9e9-2c1b63432059 \
  --region=europe-west2 --branch=<branch>
```

## Session files

Each organisation's uploads, node inputs/outputs and skill resources sit in
`gs://workflow-<orgShortName>-bucket`.

```bash
gcloud storage ls gs://workflow-<org>-bucket/
gcloud storage cat gs://workflow-<org>-bucket/<path>
```

These are customer files: read only what the task needs and do not copy them
off the machine.

## Setup on a new machine

1. Get the sal-agent key from Tom (it is not in this repository).
2. Install it and point Claude Code sessions at it:

   ```bash
   scripts/setup.sh --key /path/to/sal.json --claude-settings
   ```

3. Start a new session; existing ones keep their old environment.

## Granting a new permission

Add the role to `ROLES` in `scripts/grant-roles.sh` with a comment saying which
task needs it, then have Tom run the script. It uses Tom's own login, adds the
missing bindings and prints the roles the account holds afterwards.
