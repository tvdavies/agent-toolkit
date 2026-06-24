import { describe, expect, it } from "bun:test";
import {
	type ProvisionConfig,
	renderEnvFile,
	renderInstallInstructions,
	renderLauncher,
	renderSystemdUnit,
} from "./provision";

const cfg: ProvisionConfig = {
	instance: "agent-toolkit",
	repoDir: "/home/tom/agent-toolkit",
	daemonEntry: "/home/tom/agent-toolkit/bin/toolkit-daemon.ts",
	runtime: "node --experimental-transform-types --no-warnings",
	stateDir: "/home/tom/.local/state/agent-toolkit",
	sessionDir: "/home/tom/.local/state/agent-toolkit/sessions",
	brainRoot: "/home/tom/.local/share/agent-toolkit/brain",
	envFile: "/home/tom/.config/agent-toolkit/serve.env",
	model: "anthropic/claude-opus-4-8",
	user: "tom",
};

describe("renderEnvFile", () => {
	it("exports toolkit paths and leaves secrets commented", () => {
		const out = renderEnvFile(cfg);
		expect(out).toContain("export AGENT_TOOLKIT_STATE_DIR=/home/tom/.local/state/agent-toolkit");
		expect(out).toContain("export AGENT_TOOLKIT_BRAIN_ROOT=/home/tom/.local/share/agent-toolkit/brain");
		expect(out).toContain("export AGENT_TOOLKIT_MODEL=anthropic/claude-opus-4-8");
		expect(out).toContain("# export SLACK_APP_TOKEN=");
	});
});

describe("renderLauncher", () => {
	it("guards env-file permissions and execs the daemon", () => {
		const out = renderLauncher(cfg);
		expect(out).toContain("#!/usr/bin/env bash");
		expect(out).toContain("set -euo pipefail");
		expect(out).toContain("refusing to start");
		expect(out).toContain('source "$ENV_FILE"');
		expect(out).toContain(
			'exec node --experimental-transform-types --no-warnings "/home/tom/agent-toolkit/bin/toolkit-daemon.ts"',
		);
	});
});

describe("renderSystemdUnit", () => {
	it("is a Restart=always simple service for the daemon", () => {
		const out = renderSystemdUnit(cfg, "/home/tom/.config/agent-toolkit/launch.sh");
		expect(out).toContain("Description=Agent Toolkit daemon (agent-toolkit)");
		expect(out).toContain("Type=simple");
		expect(out).toContain("Restart=always");
		expect(out).toContain("ExecStart=/home/tom/.config/agent-toolkit/launch.sh");
		expect(out).toContain("WantedBy=default.target");
		expect(out).toContain("NoNewPrivileges=yes");
	});
});

describe("renderInstallInstructions", () => {
	it("lists the manual, deferred install steps", () => {
		const out = renderInstallInstructions(cfg, {
			unit: "/tmp/agent-toolkit.service",
			launcher: "/home/tom/.config/agent-toolkit/launch.sh",
			envFile: "/home/tom/.config/agent-toolkit/serve.env",
		});
		expect(out).toContain("systemctl --user enable --now agent-toolkit.service");
		expect(out).toContain("loginctl enable-linger tom");
		expect(out).toContain("install -m 600 /dev/null");
	});
});
