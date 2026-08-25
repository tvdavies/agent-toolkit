# Agent Toolkit

A portable personal toolkit for Pi: retained custom extensions, reusable Agent Skills, saved workflows, and safe installers for sharing them across machines.

The retired daemon and Brain runtimes are no longer part of this repository. Git history remains the recovery path if either is needed later.

## Install

```bash
git clone git@github.com:tvdavies/agent-toolkit.git ~/agent-toolkit
~/agent-toolkit/scripts/sync.sh
```

`scripts/sync.sh` is the single install and reconciliation command. It:

1. installs production npm dependencies used by retained extensions;
2. creates managed individual skill links;
3. installs this checkout as a local Pi package;
4. links the saved workflows into `~/.pi/agent/workflows`; and
5. reconciles toolkit-managed third-party Pi packages without running a blanket `pi update`.

It does not require Bun, create services, or enable lingering. Pi's package command records the local checkout and managed third-party packages in the normal package configuration. Bun is needed only for development tests.

Install selected skill groups with:

```bash
~/agent-toolkit/scripts/sync.sh --groups general,personal
```

On first install, all of `general`, `personal`, and `lleverage` are installed by default. Later runs without `--groups` reuse the managed group set recorded for the same checkout, so an automatic hook does not broaden a selective installation. An explicit `--groups` value replaces the complete desired set: reconciliation removes stale toolkit-managed links from groups that are omitted. To switch a selective machine back to all groups, pass `--groups general,personal,lleverage`. Add `--install-git-hooks` to make merge pulls and pull-with-rebase rerun `sync.sh` automatically. Use `--update-pi-packages` only when you explicitly want the final `pi update --extensions` step.

After installation, run `/reload` in active Pi sessions.

## Skills

Skills are organised into:

- `skills/general/` — portable engineering and communication skills;
- `skills/personal/` — Tom, Myslop, Dispatch, Slack, and local tooling; and
- `skills/lleverage/` — Lleverage repositories, services, teams, and infrastructure.

The internal skill reconciler creates individual links in `~/.agents/skills`. By default `~/.claude/skills` links to that standard directory. If `~/.claude/skills` is a real directory, it is preserved and receives the same managed individual links.

The installer refuses to overwrite unmanaged directories or externally owned symlinks. Managed state is stored under `~/.local/state/agent-toolkit/`. It supports `--groups` and `--dry-run`.

Pi discovers `~/.agents/skills` automatically. If `~/.pi/agent/settings.json` explicitly lists `~/.claude/skills`, the installer prints a migration warning but never edits the settings file.

## Extensions and workflows

The Pi package exports only `extensions/`. See [`extensions/README.md`](extensions/README.md) for the active inventory and workflow security model.

Saved workflows live in `.pi/workflows/` and remain available through the workflows extension:

- `debug-issue`
- `implement-ticket`
- `review-pr`

## Synchronising changes

Run the same command after adding or removing a skill, adding an extension or runtime dependency, changing a saved workflow, or editing `manifests/pi-packages.json`:

```bash
./scripts/sync.sh
```

A no-argument run preserves this checkout's previously managed skill-group selection. Pass `--groups` only when intentionally replacing that complete selection. If the relevant managed state is malformed, sync stops with an error instead of silently choosing another group set.

Existing skill contents are live through their managed links, and extension contents are live through the installed local package path. Active Pi sessions still need `/reload` to rebuild their resource inventory. New or removed resources need `sync.sh` first so their links and package state exist.

The package reconciler records toolkit-managed package specs before removing stale entries, so it does not remove unrelated user packages. Its safe default does not run `pi update`; pass `--update-pi-packages` explicitly when wanted.

For automatic reconciliation after merge pulls and pull-with-rebase rewrites, install the managed hooks once:

```bash
./scripts/sync.sh --install-git-hooks
```

The component scripts under `scripts/lib/` are internal implementation helpers. `scripts/install.sh` and `scripts/after-pull.sh` remain only as compatibility shims for older commands and existing hooks; new documentation and automation should call `scripts/sync.sh`.

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
scripts/sync.sh             Canonical install and reconciliation command
scripts/lib/                Internal reconciliation and hook helpers
scripts/remove-legacy-runtime.sh  Explicit retired-runtime migration
tests/                      Toolkit-level tests
```

Pi extensions and skills execute trusted local code or instructions. Review additions and third-party packages before installing them.
