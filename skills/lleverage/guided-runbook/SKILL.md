---
name: guided-runbook
description: Write a guided, wizard-style bash script for Tom to run in his own terminal when a task needs his credentials, an interactive confirmation or a change an agent must not make itself (staging or production infrastructure, OpenBao policies and secrets, Terraform applies, PR merges, Cloud Build triggers). Covers the one-command handover, fetching secrets from 1Password at run time, cluster and OpenBao access, step detection and resume, safe read-modify-write and dry-run checks. Use whenever you would otherwise hand Tom shell commands to paste, a multi-step procedure to follow, or a script to run.
compatibility: Requires bash, jq and kubectl; the op CLI with the service-account env described in the 1password skill; the infrastructure checkout (INFRA, default ~/dev/lleverage-ai/infrastructure). Tom's interactive shell is fish.
metadata:
  author: tvd
  version: 1.0.0
---

# Guided runbook

When Tom has to run something himself, give him **one script and one command**.
The script does the whole procedure as a wizard: it checks first, asks before
each change, can be stopped and re-run, and fetches its own secrets.

## The handover

Tom's shell is **fish**. Never give him commands to paste beyond this one line:

```
bash /absolute/path/to/the-script.sh
```

- No environment variables in front of it, no `export`, no `read -gsx`, no
  multi-line snippets, no "first set X then run Y". Defaults belong inside the
  script.
- Put the script in the task's workspace (for Sal,
  `~/.local/state/sal/workspaces/tasks/<area>/<TASK-ID>/`) with a name that
  says what it does, e.g. `activate-isolate-sandbox-staging.sh`.
- If a run stops or fails, **fix the same script** and hand over the same
  command again. Don't add wrapper scripts, side scripts or "run this first"
  fix-ups. A fix that is a separate manual step becomes a step in the script.
  The script detects what's already done, so a re-run picks up where it stopped.
- In the message, say in two or three lines what it will do, what it will ask,
  and what to do when it finishes. Mention that `WIZ_DRY_RUN=1` rehearses it
  only if Tom asks how to check it first.

## Writing the script

Start from [`templates/runbook.sh`](templates/runbook.sh) and source the
shared library, [`scripts/lib/wizard.sh`](scripts/lib/wizard.sh):

```bash
. "${WIZARD_LIB:-$HOME/.agents/skills/guided-runbook/scripts/lib/wizard.sh}"
wiz_init "What this does" 4
```

The shape is fixed:

1. **Preflight, before any change.** `need_tools`, auth checks (`gh auth
   status`, gcloud identity), `use_cluster`, secrets, `openbao_connect`.
   Anything that can fail without changing state fails here.
2. **One step per change**, each going *detect, show, ask, change, verify*:
   - detect whether it's already done and `skip` if so;
   - show exactly what will change (a diff, the resource, the command);
   - `confirm_or_stop "…?"`. Default is No, and No ends the run cleanly;
   - make the change;
   - read it back and `ok` or `die`.
3. `wiz_done "next thing Tom should do"`.

| Helper | Use |
| --- | --- |
| `step`, `ok`, `skip`, `info`, `warn`, `die` | Output. `die` exits and tells Tom to re-run once fixed |
| `ask`, `confirm_or_stop`, `confirm_typed WORD …`, `pause_for` | Prompts, read from `/dev/tty`. Use `confirm_typed production` for production or destructive changes |
| `need_tools` | Preflight tool check |
| `op_secret VAR op://…`, `op_document_field VAR ITEM VAULT JQ` | 1Password into a shell variable |
| `openbao_root_token VAR staging\|production` | The current OpenBao root token from Infra break-glass |
| `use_cluster staging\|production` | Exports a working `KUBECONFIG`, falling back from the direct config to the tailnet one |
| `openbao_connect VAR`, `bao …`, `bao_with_input FILE …` | bao inside the active OpenBao pod; the token goes over stdin |
| `guard_nonempty FILE WHAT`, `guard_additive BEFORE AFTER`, `guard_unchanged SNAPSHOT FRESH WHAT` | Read-modify-write safety |
| `show_cmd DESC CMD…` | Print a command, then run it |
| `$WIZ_TMP` | Private temp dir, deleted on exit |

### Secrets

- The script fetches every secret itself at run time, from 1Password, through
  the helpers. Never ask Tom to export a token or paste one.
- Never read secrets from local generated files such as
  `generated/<env>/openbao-init.json`. They go stale after a rotation and have
  been removed on purpose.
- Secrets stay in shell variables. Don't echo them, pass them as arguments
  (`BAO_TOKEN=… bao` shows in process lists), write them to files outside
  `$WIZ_TMP`, or turn on `set -x`.
- Reading from the Infra break-glass vault needs Tom's agreement. Running the
  script is that agreement, so say in the handover which break-glass item the
  script reads.
- When an existing script takes a secret through an environment variable (like
  `OPENBAO_ROOT_TOKEN`), set it inside your script just before calling that
  script. Don't make Tom provide it.

### Safe changes

- **Read, modify, write:** if a write replaces a whole object (an OpenBao
  policy, a ConfigMap, a JSON setting), the read must succeed and be non-empty
  (`guard_nonempty`), and the diff must only add lines unless removal is the
  point (`guard_additive`). A failed read must never turn into a write.
- After the confirmation, read the object again and `guard_unchanged` it
  against the snapshot, so a change someone made while Tom was deciding isn't
  overwritten.
- Detect and verify the effect, not the text: a path in a policy only counts if
  its stanza grants the capability (see `grants_read` in the template).
- **Production:** `confirm_typed production "…"` before every production change,
  and name the environment in every prompt.
- Each step works out its state from the live system, not from a marker file,
  so re-runs are correct even after hand changes.
- Prefer the direct kubeconfig. The tailnet kubeconfig goes through Tailscale's
  SOCKS proxy (`127.0.0.1:1055`), which sometimes fails a request with
  "general SOCKS server failure"; `use_cluster` handles the fallback.

## Before handing it over

Run the checker. It runs `bash -n`, shellcheck and the rules above, and with
`--dry-run` rehearses the script with every change answered No:

```bash
bash ~/.agents/skills/guided-runbook/scripts/check-runbook.sh --dry-run /path/to/script.sh
```

Do the dry run whenever you can reach the systems the preflight needs. It
catches missing tools, unreachable clusters, wrong tokens and bad detection
before Tom finds them. If you can't (no access from your session), say so in
the handover.

Each run writes a log next to the script (`<name>.<timestamp>.log`). When Tom
says a run went wrong, read the latest log before asking him to paste output.
