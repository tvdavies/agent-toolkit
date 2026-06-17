# Agent Tools

Personal agent tooling shared across machines: Agent Skills, custom Pi extensions, optional prompts/themes, setup scripts, and a manifest for third-party Pi packages.

## Fresh machine setup

```bash
git clone git@github.com:tvdavies/agent-skills.git ~/agent-skills
~/agent-skills/scripts/bootstrap.sh
```

The bootstrap script is idempotent and will:

1. install this repo's npm dependencies for local extension development;
2. link `~/.claude/skills` and `~/.agents/skills` to `~/agent-skills/skills`;
3. install this repo as a local Pi package with `pi install ~/agent-skills`;
4. install third-party Pi packages listed in `manifests/pi-packages.json`.

It refuses to overwrite existing non-symlink skill directories.

To also install local Git hooks that sync the setup after future pulls:

```bash
~/agent-skills/scripts/bootstrap.sh --install-git-hooks
```

Or install only the hooks:

```bash
~/agent-skills/scripts/install-git-hooks.sh
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
pi install "$HOME/agent-skills"
```

For a machine that should track the GitHub repo directly:

```bash
pi install git:git@github.com:tvdavies/agent-skills.git@main
```

After editing extensions, run `/reload` inside Pi.

`~/.pi/agent/extensions` is no longer the source of truth. Avoid keeping duplicate active `.ts` extensions there, otherwise Pi may load the same command/tool twice.

## Other agent harnesses

Claude Code and other harnesses still use fixed skill paths. Bootstrap maintains these symlinks:

```bash
~/.claude/skills -> ~/agent-skills/skills
~/.agents/skills -> ~/agent-skills/skills
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
~/agent-skills/scripts/sync-pi-packages.sh
```

Add version pins or Git refs there if reproducibility becomes more important than easy updates.

## Syncing after pulls

For manual sync after pulling remote changes:

```bash
cd ~/agent-skills
git pull
./scripts/after-pull.sh --force
```

For automatic local sync, install Git hooks:

```bash
~/agent-skills/scripts/install-git-hooks.sh
```

The hooks run `scripts/after-pull.sh` after merge pulls and `git pull --rebase`. The sync script:

- installs npm dependencies only when `package.json`, `package-lock.json`, or `node_modules` require it;
- keeps `~/.claude/skills` and `~/.agents/skills` pointed at `~/agent-skills/skills`;
- ensures Pi has this local checkout installed as a package;
- runs `scripts/sync-pi-packages.sh` when `manifests/pi-packages.json` changes;
- reminds you to run `/reload` in active Pi sessions when loaded resources changed.

Git hooks cannot reload already-running Pi sessions automatically.

## Security

Pi extensions execute arbitrary code with full local permissions. Skills can also instruct agents to run local commands. Only install and sync trusted code, and review third-party Pi packages before adding them to the manifest.
