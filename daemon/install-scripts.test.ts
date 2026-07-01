import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const install = readFileSync(new URL("../scripts/install.sh", import.meta.url), "utf8");
const afterPull = readFileSync(new URL("../scripts/after-pull.sh", import.meta.url), "utf8");

describe("install/update scripts", () => {
	it("quote paths before writing Brain systemd unit fields", () => {
		for (const script of [install, afterPull]) {
			expect(script).toContain("systemd_quote()");
			expect(script).toContain('WorkingDirectory=$(systemd_quote');
			expect(script).toContain("source \"\\$1\" 2>/dev/null || true; exec \"\\$2\" daemon run");
			expect(script).toContain('$(systemd_quote "$CONFIG/serve.env")');
			expect(script).toContain('$(systemd_quote "$REPO');
		}
	});

	it("runs the heartbeat unit through argv placeholders instead of interpolating raw paths", () => {
		expect(install).toContain("source \"\\$1\" 2>/dev/null; exec \"\\$2\" --experimental-transform-types --no-warnings \"\\$3\" --cron-job heartbeat");
		expect(install).toContain('$(systemd_quote "$NODE_BIN")');
		expect(install).toContain('$(systemd_quote "$REPO/bin/toolkit-trigger.ts")');
	});
});
