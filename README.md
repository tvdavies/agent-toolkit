# Agent Toolkit

Personal agent toolkit shared across machines: Agent Skills, custom Pi extensions, optional prompts/themes, setup scripts, and a manifest for third-party Pi packages.

## Fresh machine setup

One command does the lot — package setup, the resident-agent daemon as a
`systemd --user` service, a heartbeat timer, and lingering:

```bash
git clone git@github.com:tvdavies/agent-toolkit.git ~/agent-toolkit
~/agent-toolkit/scripts/install.sh
```

Or extensions only, with no background services:

```bash
~/agent-toolkit/scripts/install.sh --no-service     # then /reload in Pi
```

`install.sh` is idempotent and re-runnable. It needs no secrets to start; add
Slack tokens or a spend cap to `~/.config/agent-toolkit/serve.env` (kept
`chmod 600`) afterwards and `systemctl --user restart agent-toolkit.service`.
The autonomous system is documented in [`docs/architecture.md`](docs/architecture.md)
and [`bin/README.md`](bin/README.md). The lower-level `scripts/bootstrap.sh`
does just the package setup (no services).

### Copy-paste install prompt for an existing Pi session

Paste this into an already-running Pi session to have Pi fetch and install the toolkit for you:

```text
Install the Agent Toolkit from GitHub into this Pi environment.

Please do the following:
1. Clone or update https://github.com/tvdavies/agent-toolkit.git at ~/agent-toolkit. If HTTPS auth fails, retry with git@github.com:tvdavies/agent-toolkit.git.
2. Run ~/agent-toolkit/scripts/bootstrap.sh to install dependencies, link skills, install this repo as a local Pi package, and sync third-party Pi packages.
3. Do not overwrite existing non-symlink skill directories; if bootstrap refuses for safety, stop and explain what I need to move or back up.
4. Show the final Pi package status, then remind me to run /reload in this Pi session.

You can start with:

set -euo pipefail
if [ -d "$HOME/agent-toolkit/.git" ]; then
  git -C "$HOME/agent-toolkit" pull --ff-only
else
  git clone https://github.com/tvdavies/agent-toolkit.git "$HOME/agent-toolkit" || git clone git@github.com:tvdavies/agent-toolkit.git "$HOME/agent-toolkit"
fi
"$HOME/agent-toolkit/scripts/bootstrap.sh"
```

The bootstrap script is idempotent and will:

1. install this repo's npm dependencies for local extension development;
2. link `~/.claude/skills` and `~/.agents/skills` to `~/agent-toolkit/skills`;
3. install this repo as a local Pi package with `pi install ~/agent-toolkit`;
4. install third-party Pi packages listed in `manifests/pi-packages.json`.

It refuses to overwrite existing non-symlink skill directories.

To also install local Git hooks that sync the setup after future pulls:

```bash
~/agent-toolkit/scripts/bootstrap.sh --install-git-hooks
```

Or install only the hooks:

```bash
~/agent-toolkit/scripts/install-git-hooks.sh
```

## Repository layout

```text
skills/                    Shared Agent Skills
extensions/                Custom Pi extensions loaded by this package
prompts/                   Optional Pi prompt templates
themes/                    Optional Pi themes
manifests/pi-packages.json Third-party Pi package list
scripts/bootstrap.sh       Fresh machine bootstrap
scripts/sync-pi-packages.sh Install/update third-party Pi packages
archive/extensions-disabled Disabled legacy extensions that must not auto-load
```

## Pi loading model

This repo is a Pi package. Its `package.json` exposes `skills/`, `extensions/`, `prompts/`, and `themes/` through the `pi` manifest.

For active local development, install the local checkout:

```bash
pi install "$HOME/agent-toolkit"
```

For a machine that should track the GitHub repo directly:

```bash
pi install git:git@github.com:tvdavies/agent-toolkit.git@main
```

After editing extensions, run `/reload` inside Pi.

`~/.pi/agent/extensions` is no longer the source of truth. Avoid keeping duplicate active `.ts` extensions there, otherwise Pi may load the same command/tool twice.

## Other agent harnesses

Claude Code and other harnesses still use fixed skill paths. Bootstrap maintains these symlinks:

```bash
~/.claude/skills -> ~/agent-toolkit/skills
~/.agents/skills -> ~/agent-toolkit/skills
```

## Adding a skill

1. Create `skills/<name>/SKILL.md`.
2. Use valid Agent Skills frontmatter with `name` and a specific `description`.
3. Keep helper scripts/assets inside the skill directory.
4. Commit and push the change.

## Adding a custom Pi extension

1. Add a `.ts` file under `extensions/`, or a directory with `index.ts`.
2. Keep disabled or experimental extensions outside `extensions/` unless their filenames cannot be auto-loaded.
3. Add runtime npm dependencies to the root `package.json`.
4. Run `npm install --package-lock-only` or `npm install` from the repo root when dependencies change.
5. Run `/reload` in Pi to reload resources.

## Third-party Pi packages

Third-party package specs live in `manifests/pi-packages.json`.

Install/reconcile them with:

```bash
~/agent-toolkit/scripts/sync-pi-packages.sh
```

Add version pins or Git refs there if reproducibility becomes more important than easy updates.

## Syncing after pulls

For manual sync after pulling remote changes:

```bash
cd ~/agent-toolkit
git pull
./scripts/after-pull.sh --force
```

For automatic local sync, install Git hooks:

```bash
~/agent-toolkit/scripts/install-git-hooks.sh
```

The hooks run `scripts/after-pull.sh` after merge pulls and `git pull --rebase`. The sync script:

- installs npm dependencies only when `package.json`, `package-lock.json`, or `node_modules` require it;
- keeps `~/.claude/skills` and `~/.agents/skills` pointed at `~/agent-toolkit/skills`;
- ensures Pi has this local checkout installed as a package;
- runs `scripts/sync-pi-packages.sh` when `manifests/pi-packages.json` changes;
- reminds you to run `/reload` in active Pi sessions when loaded resources changed.

Git hooks cannot reload already-running Pi sessions automatically.

## Security

Pi extensions execute arbitrary code with full local permissions. Skills can also instruct agents to run local commands. Only install and sync trusted code, and review third-party Pi packages before adding them to the manifest.
