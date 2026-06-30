/**
 * Provisioning renderers — pure functions that produce the install artefacts for
 * running the daemon under `systemd --user`.
 *
 * These only RENDER text. Installation (writing files, `systemctl --user enable`,
 * `loginctl enable-linger`) is a deliberate, separate step the user runs — see
 * `renderInstallInstructions`. Keeping rendering pure makes it testable and lets
 * the same renderers target a workstation today and an always-on server later.
 */

import { dirname } from "node:path";

export type ProvisionConfig = {
	/** Logical instance name; becomes the systemd unit name. */
	instance: string;
	/** Absolute path to the agent-toolkit package checkout. */
	repoDir: string;
	/** Absolute path to the daemon entry (bin/toolkit-daemon.ts). */
	daemonEntry: string;
	/** Absolute path to the launcher preflight (bin/toolkit-preflight.ts) — the
	 *  self-update rollback guard, run before the daemon on every (re)start. */
	preflightEntry?: string;
	/** Command that runs TypeScript, e.g. node --experimental-transform-types. */
	runtime: string;
	/** XDG-style state, session, and brain locations. */
	stateDir: string;
	sessionDir: string;
	brainRoot: string;
	/** Path to the 0600 secrets env file (sourced by the launcher). */
	envFile: string;
	/** Optional model id passed through to pi. */
	model?: string;
	/** Service user (for documentation of enable-linger). */
	user?: string;
	/** Bin dir to prepend to PATH so the service finds node/pi (e.g. an nvm dir). */
	nodeBinDir?: string;
	/** User bin dir to prepend to PATH so the service finds CLIs like `tadu`. */
	userBinDir?: string;
	/** Absolute path to the pi binary, for AGENT_TOOLKIT_PI_BIN under systemd. */
	piBin?: string;
	/** Absolute path to the bun binary — the self-update validate gate runs `bun test`,
	 *  and bun is usually NOT on the minimal systemd PATH. */
	bunBin?: string;
	/** Absolute path to the bundled Brain CLI wrapper. */
	brainBin?: string;
};

const MEMORY_MAX = "8G";

/** Environment exports written to the per-instance env file (no secrets here). */
export function renderEnvFile(cfg: ProvisionConfig): string {
	const lines = [
		`# ${cfg.instance} environment — sourced by the launcher.`,
		`# Mode 0600, owned by the service user. Put real secrets below the marker.`,
	];
	// Make node/pi/bun and user CLIs (tadu) resolvable under systemd (PATH is minimal there).
	const bunBinDir = cfg.bunBin ? dirname(cfg.bunBin) : undefined;
	const pathDirs = [cfg.nodeBinDir, cfg.userBinDir, bunBinDir].filter((d, i, a) => d && a.indexOf(d) === i);
	if (pathDirs.length) lines.push(`export PATH=${pathDirs.join(":")}:$PATH`);
	if (cfg.piBin) lines.push(`export AGENT_TOOLKIT_PI_BIN=${cfg.piBin}`);
	if (cfg.bunBin) lines.push(`export AGENT_TOOLKIT_BUN_BIN=${cfg.bunBin}`);
	if (cfg.brainBin) lines.push(`export AGENT_TOOLKIT_BRAIN_BIN=${cfg.brainBin}`);
	lines.push(
		`export AGENT_TOOLKIT_STATE_DIR=${cfg.stateDir}`,
		`export AGENT_TOOLKIT_BRAIN_ROOT=${cfg.brainRoot}`,
		`export AGENT_TOOLKIT_SESSION_DIR=${cfg.sessionDir}`,
		// Memory = the bundled external `brain` CLI. "okf" reverts to the in-process
		// OKF brain; "off" disables memory.
		`export AGENT_TOOLKIT_MEMORY_ENGINE=brain`,
		cfg.model ? `export AGENT_TOOLKIT_MODEL=${cfg.model}` : `# export AGENT_TOOLKIT_MODEL=anthropic/claude-opus-4-8`,
		``,
		`# --- secrets (Phase 3+) ---`,
		`# export SLACK_APP_TOKEN=xapp-...`,
		`# export SLACK_BOT_TOKEN=xoxb-...`,
		`# export SLACK_ALLOWED_USERS=U0123,U4567`,
		`# export SLACK_NOTIFY_CHANNEL=...`,
		``,
		`# --- guards ---`,
		`# export AGENT_TOOLKIT_DAILY_CAP_USD=20             # per-token billing guard`,
		`# export AGENT_TOOLKIT_MAX_RUNS_PER_DAY=200         # subscription guard (USD cap reads ~$0)`,
		`# export AGENT_TOOLKIT_HEARTBEAT_MIN_MINUTES=30     # min minutes between heartbeats (auto 60 on subscription auth, else 30; set to override)`,
		`# export AGENT_TOOLKIT_QUIET_HOURS=23:00-07:00      # do-not-disturb: keep working, hold routine notices (batched at window end); escalations still break through`,
		`# export AGENT_TOOLKIT_HEARTBEAT_HOURS=07:00-23:00  # pause: only run the heartbeat inside this window (leave unset to run 24/7)`,
		``,
	);
	return lines.join("\n");
}

/** Launcher script: verify env-file permissions, source it, exec the daemon. */
export function renderLauncher(cfg: ProvisionConfig): string {
	return `#!/usr/bin/env bash
set -euo pipefail

# Refuse to start if the secrets env file is group/world accessible or not owned
# by us — the env file is a security boundary, not a convenience.
ENV_FILE="${cfg.envFile}"
if [ -f "$ENV_FILE" ]; then
  perms=$(stat -c '%a' "$ENV_FILE")
  owner=$(stat -c '%u' "$ENV_FILE")
  if [ "$owner" != "$(id -u)" ]; then
    echo "refusing to start: $ENV_FILE is not owned by $(id -un)" >&2
    exit 1
  fi
  case "$perms" in
    600|400) : ;;
    *) echo "refusing to start: $ENV_FILE must be mode 600 (is $perms)" >&2; exit 1 ;;
  esac
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

cd "${cfg.repoDir}"
${
	cfg.preflightEntry
		? `# Self-update rollback guard: if a self-update restart keeps failing to boot,
# revert the checkout to the last-good commit before starting (best-effort).
${cfg.runtime} "${cfg.preflightEntry}" || true
`
		: ""
}exec ${cfg.runtime} "${cfg.daemonEntry}"
`;
}

/** systemd --user unit that supervises the daemon (Type=simple, Restart=always). */
export function renderSystemdUnit(cfg: ProvisionConfig, launcherPath: string): string {
	return `[Unit]
Description=Agent Toolkit daemon (${cfg.instance})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${launcherPath}
WorkingDirectory=${cfg.repoDir}
Restart=always
RestartSec=2
NoNewPrivileges=yes
MemoryMax=${MEMORY_MAX}
TasksMax=512

[Install]
WantedBy=default.target
`;
}

/** The manual, deferred install steps (printed by toolkit-daemon --print-units). */
export function renderInstallInstructions(
	cfg: ProvisionConfig,
	paths: { unit: string; launcher: string; envFile: string },
): string {
	const unitName = `${cfg.instance}.service`;
	const user = cfg.user ?? "$(whoami)";
	return [
		"# Deferred install — review, then run these yourself:",
		``,
		`# 1. Create the 0600 secrets env file (paths are pre-filled):`,
		`install -m 600 /dev/null ${paths.envFile}   # then edit to add secrets`,
		``,
		`# 2. Make the launcher executable:`,
		`chmod 0755 ${paths.launcher}`,
		``,
		`# 3. Install and start the user service:`,
		`mkdir -p ~/.config/systemd/user`,
		`cp ${paths.unit} ~/.config/systemd/user/${unitName}`,
		`systemctl --user daemon-reload`,
		`systemctl --user enable --now ${unitName}`,
		``,
		`# 4. Survive logout/reboot (run once per host):`,
		`sudo loginctl enable-linger ${user}`,
		``,
		`# Inspect:  systemctl --user status ${unitName}`,
		`# Logs:     journalctl --user -u ${unitName} -f`,
		``,
	].join("\n");
}
