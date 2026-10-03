---
name: 1password
description: Read Lleverage secrets and credential documents from 1Password via the `op` CLI and a vault-scoped service account. Use when a task needs a password, API key, token, kubeconfig, talosconfig or other credential stored in 1Password, or when asked to look something up in 1Password or a vault.
metadata:
  author: tvd
  version: 1.0.0
---

# 1Password (service account)

The `op` CLI (`/usr/bin/op`, installed from the AUR `1password-cli` package) authenticates as a **service account** on `lleverageai.1password.com`. It cannot see personal vaults or anything outside the vaults granted below.

## Authentication

The token lives in `~/.config/op/agent.env` (mode `600`) as `export OP_SERVICE_ACCOUNT_TOKEN=ops_...`. It is deliberately not in the global shell environment.

Load it in a subshell for the command that needs it, so it never leaks into later commands:

```bash
( . ~/.config/op/agent.env && op whoami )
```

- Never print, `cat`, echo or log the token file or the token.
- Never put the token on a command line or in a committed file.
- If `op whoami` fails with an auth error, the token was revoked or expired. Ask the user to generate a new one and write it with the silent-read command below. Do not ask them to paste it into chat.

```fish
# fish (the user's shell); keep it on one line
umask 077; read -s -P "Token: " t; and echo "export OP_SERVICE_ACCOUNT_TOKEN=$t" > ~/.config/op/agent.env; set -e t; umask 022
```

## Vaults

| Vault | ID | Contents | Policy |
|---|---|---|---|
| Infra operators | `rpvmsahdrlzdqoufnuzzks2wle` | Kubernetes and Talos admin configs (production, staging), stored as documents | Read when the task needs them. Production configs: say so before using. |
| Imported CSV | `m5a2vcvnkwlfzime2sameivyg4` | ~34 mixed credentials imported from a CSV | Read the specific item the task needs. |
| Infra break-glass | `cvglmxwxawo3rvid64lwgwisk4` | Emergency credentials | **Ask the user before reading any item.** Listing titles is fine. |

Re-check what is granted with `op vault list`; the user may add or remove vaults.

Treat all vaults as **read-only**. Do not create, edit, move or delete items unless the user explicitly asks for that change.

## Handling secrets

The goal is that secret values reach the tool that needs them without ever appearing in chat, tool output or files that outlive the task.

**Find items** (metadata only, safe to show):

```bash
( . ~/.config/op/agent.env && op item list --vault "Imported CSV" --format json | jq -r '.[] | "\(.id)\t\(.category)\t\(.title)"' )
( . ~/.config/op/agent.env && op item get "<title or id>" --vault "<vault>" --format json | jq '[.fields[] | {label, type, ref: .reference}]' )
```

**`op item get --format json` includes concealed values (passwords, credentials) in plain text, even without `--reveal`.** Always pipe it through a `jq` filter that drops `.value`, as above. Never print raw item JSON, and never pass `--reveal`.

**Pass a secret to a command** with `op read` inside a substitution or pipe, never into the transcript:

```bash
( . ~/.config/op/agent.env && SOME_API_KEY="$(op read 'op://Imported CSV/<item>/credential')" some-command )
```

Or use `op run` with secret references in an env file or environment:

```bash
( . ~/.config/op/agent.env && API_KEY='op://Imported CSV/<item>/credential' op run -- some-command )
```

`op run` masks secret values in the command's output by default; leave that on.

**Documents** (kubeconfigs, talosconfigs): write to a private temp file, use it, then delete it.

```bash
d=$(mktemp -d) && chmod 700 "$d"
( . ~/.config/op/agent.env && op document get "Kubernetes admin kubeconfig (staging)" --vault "Infra operators" --out-file "$d/kubeconfig" )
KUBECONFIG="$d/kubeconfig" kubectl get nodes
rm -rf "$d"
```

Do not save these files into repositories or long-lived paths. If one must persist for the session, tell the user where it is and remove it at the end.

## Rules

- Never show a secret value in chat or tool output. If the user asks to see one, say it can be read with `op read` themselves, or confirm first that they want it shown in the transcript.
- Fetch only the specific secret the task needs. Do not dump vaults or loop over items reading values.
- Service accounts have hourly request limits. Avoid tight loops of `op` calls; fetch once and reuse within the command.
- Verify access with `op whoami` and `op vault list` rather than assuming.
