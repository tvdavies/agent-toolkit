/**
 * Self-update extension — lets the agent load its own code change.
 *
 * The agent runs from the live checkout (the resident's cwd is the repo), so it can
 * edit the toolkit's own source. It cannot restart itself cleanly — it lives inside
 * the process that would be replaced — so this tool just records a REQUEST. The
 * daemon (which outlives the restart and is supervised by systemd) validates it with
 * `bun test`, commits, and restarts onto the new code; a launcher preflight rolls the
 * checkout back if the new code will not boot. See daemon/self-update.ts + lib/update.
 *
 * This is a PACKAGE extension (loaded via package.json "pi".extensions), but it
 * registers the tool only when the daemon injects its self-update capability token.
 * Normal interactive Pi sessions and isolated workers therefore never see it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { stateDir } from "../lib/decisions.ts";
import { writeUpdateRequest } from "../lib/update.ts";

const schema = Type.Object({
	reason: Type.String({
		description: "Short description of the change being loaded (recorded in the commit + decision log), e.g. 'tighten heartbeat quiet-hours parsing'.",
	}),
	resumePrompt: Type.Optional(
		Type.String({
			description: "What to do after the restart, delivered to you once the new code is live and healthy (e.g. 'verify the heartbeat now skips during quiet hours, then close TASK-42').",
		}),
	),
});
type ApplyUpdateInput = Static<typeof schema>;

export interface SelfUpdateEnvironment {
	[key: string]: string | undefined;
	AGENT_TOOLKIT_SELF_UPDATE_TOKEN?: string;
	AGENT_TOOLKIT_WORKER_RUN_ID?: string;
}

export function hasSelfUpdateCapability(env: SelfUpdateEnvironment): boolean {
	return typeof env.AGENT_TOOLKIT_SELF_UPDATE_TOKEN === "string" && env.AGENT_TOOLKIT_SELF_UPDATE_TOKEN.length > 0;
}

export default function selfUpdateExtension(pi: ExtensionAPI, env: SelfUpdateEnvironment = process.env): void {
	if (!hasSelfUpdateCapability(env)) return;
	const token = env.AGENT_TOOLKIT_SELF_UPDATE_TOKEN;

	pi.registerTool({
		name: "apply_update",
		label: "apply update (restart onto my code change)",
		description:
			"Load a code change you have made to the toolkit's OWN source into the running system. First edit the files in the checkout, then call this. The daemon validates the change with the test suite; if green it commits and restarts onto the new code, and if the new code fails to boot it automatically rolls back. After calling apply_update, STOP — the restart will replace this process; you are resumed automatically. Only the change is loaded; to make it permanent upstream, open a PR as well.",
		promptSnippet: "Validate, restart, and load my code change",
		parameters: schema,
		async execute(_id, params: ApplyUpdateInput) {
			const result = (text: string, details: Record<string, unknown>) => ({ content: [{ type: "text" as const, text }], details });
			const reason = params.reason.trim();
			if (!reason) return result("apply_update needs a non-empty reason.", { ok: false });
			writeUpdateRequest(stateDir(), {
				reason,
				resumePrompt: params.resumePrompt?.trim() || undefined,
				runId: env.AGENT_TOOLKIT_WORKER_RUN_ID,
				// Proof the request came from the resident: the daemon injects this token
				// into the resident's env only, and refuses any request without it.
				token,
				ts: new Date().toISOString(),
			});
			return result(
				"Update queued. The daemon will run the test suite against your change; if it passes it commits and restarts to load it (auto-rolling-back if the new code will not boot). End your turn now — you will be resumed once it is live.",
				{ ok: true, reason },
			);
		},
	});
}
