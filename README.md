# Agent Toolkit

A portable personal toolkit for Pi: retained custom extensions, reusable Agent Skills, saved workflows, and safe installers for sharing them across machines.

The retired daemon and Brain runtimes are no longer part of this repository. Git history remains the recovery path if either is needed later.

## Install

```bash
git clone git@github.com:tvdavies/agent-toolkit.git ~/agent-toolkit
~/agent-toolkit/scripts/install.sh
```

`install.sh` is a thin wrapper around `bootstrap.sh`. Bootstrap:

1. installs production npm dependencies used by retained extensions;
2. creates managed individual skill links;
3. installs this checkout as a local Pi package;
4. links the saved workflows into `~/.pi/agent/workflows`; and
5. reconciles toolkit-managed third-party Pi packages.

It does not require Bun, create services, enable lingering, or change Pi settings. Bun is needed only for development tests.

Install selected skill groups with:

```bash
~/agent-toolkit/scripts/install.sh --groups general,personal
```

All of `general`, `personal`, and `lleverage` are installed by default. Add `--install-git-hooks` to install the post-pull reconciliation hooks.

After installation, run `/reload` in active Pi sessions.

## Skills

Skills are organised into:

- `skills/general/` — portable engineering and communication skills;
- `skills/personal/` — Tom, Myslop, Dispatch, Slack, and local tooling; and
- `skills/lleverage/` — Lleverage repositories, services, teams, and infrastructure.

`scripts/install-skills.sh` creates individual links in `~/.agents/skills`. By default `~/.claude/skills` links to that standard directory. If `~/.claude/skills` is a real directory, it is preserved and receives the same managed individual links.

The installer refuses to overwrite unmanaged directories or externally owned symlinks. Managed state is stored under `~/.local/state/agent-toolkit/`. It supports `--groups` and `--dry-run`.

Pi discovers `~/.agents/skills` automatically. If `~/.pi/agent/settings.json` explicitly lists `~/.claude/skills`, the installer prints a migration warning but never edits the settings file.

## Extensions and workflows

The Pi package exports only `extensions/`. See [`extensions/README.md`](extensions/README.md) for the active inventory and workflow security model.

Saved workflows live in `.pi/workflows/` and remain available through the workflows extension:

- `debug-issue`
- `implement-ticket`
- `review-pr`

## Third-party Pi packages

`manifests/pi-packages.json` is reconciled by:

```bash
./scripts/sync-pi-packages.sh
```

The script records toolkit-managed package specs before removing stale entries, so it does not remove unrelated user packages.

## Updating

```bash
git pull --ff-only
./scripts/after-pull.sh
```

`after-pull.sh` runs the same idempotent reconciliation as bootstrap. Git hooks can be installed with `./scripts/install-git-hooks.sh`.

## Removing the retired runtime

Existing machines may still have old user services. Remove them explicitly with:

```bash
./scripts/remove-legacy-runtime.sh --dry-run
./scripts/remove-legacy-runtime.sh
```

This stops/disables the old toolkit, Brain, and heartbeat units and removes their unit files. It preserves `~/.config/agent-toolkit/serve.env` unless `--purge-config` is passed.

## Development

```bash
npm ci
npm run typecheck
npm test
```

The test suite validates skill frontmatter/layout and the installer safety contract in isolated temporary home directories. It also covers retained extension behaviour. Run `git diff --check` before integration.

## Repository layout

```text
extensions/                 Active Pi extensions
skills/general/             Portable skills
skills/personal/            Personal/local skills
skills/lleverage/           Lleverage-specific skills
.pi/workflows/              Saved workflows
manifests/pi-packages.json  Third-party Pi package list
scripts/                    Install, sync, migration, and hook scripts
tests/                      Toolkit-level tests
```

Pi extensions and skills execute trusted local code or instructions. Review additions and third-party packages before installing them.
