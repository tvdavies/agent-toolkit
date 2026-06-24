/**
 * Heartbeat extension — the scheduled "check in and act" loop.
 *
 * A cron job queues a heartbeat trigger (see ./protocol); when its prompt reaches
 * the resident agent, this extension recognises the marker on before_agent_start
 * and injects the user-editable HEARTBEAT.md checklist, the silence rule, the
 * recently-handled items (so it never re-flags the same thing), and the recent
 * heartbeat log. The agent records outcomes via heartbeat_note — escalating only
 * what genuinely needs attention.
 *
 * Config: AGENT_TOOLKIT_HEARTBEAT (checklist path), AGENT_TOOLKIT_STATE_DIR.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { recordDecision, stateDir } from "../lib/decisions.ts";
import { notify } from "../lib/notify.ts";
import { HandledStore } from "./handled.ts";
import { buildHeartbeatPrompt, isHeartbeatPrompt } from "./protocol.ts";

const DEFAULT_HEARTBEAT = `# Heartbeat checklist

Standing instructions for scheduled heartbeats. The agent runs these autonomously,
so keep them conservative.

## Reporting rule
- Stay silent when everything is fine. Escalate (heartbeat_note with attention: true)
  only when something needs the user's attention, a check failed or was blocked, or
  you took a notable action. Record routine outcomes with heartbeat_note and finish.

## Checks
1. If a durable /goal is active, make concrete progress on it.
2. Otherwise do read-only triage only — nothing surprising or outward-facing.

(Add Slack/Gmail/PR checks here as those integrations land.)
`;

function heartbeatFile(): string {
	return (
		process.env.AGENT_TOOLKIT_HEARTBEAT ??
		join(homedir(), ".config", "agent-toolkit", "HEARTBEAT.md")
	);
}
function heartbeatLogPath(): string {
	return join(stateDir(), "heartbeat-log.md");
}
function handledPath(): string {
	return join(stateDir(), "heartbeat-handled.json");
}

function readHeartbeatChecklist(): string {
	const path = heartbeatFile();
	if (!existsSync(path)) return DEFAULT_HEARTBEAT;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return DEFAULT_HEARTBEAT;
	}
}

function ensureHeartbeatFile(): string {
	const path = heartbeatFile();
	if (!existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, DEFAULT_HEARTBEAT, "utf8");
	}
	return path;
}

function appendHeartbeatLog(summary: string): void {
	try {
		const path = heartbeatLogPath();
		mkdirSync(dirname(path), { recursive: true });
		const header = existsSync(path) ? "" : "# Heartbeat log\n\n";
		appendFileSync(path, `${header}- ${new Date().toISOString()} — ${summary.replace(/\s+/g, " ").trim()}\n`);
	} catch {
		// best-effort
	}
}

function recentLog(limit: number): string[] {
	const path = heartbeatLogPath();
	if (!existsSync(path)) return [];
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.startsWith("- "))
			.slice(-limit);
	} catch {
		return [];
	}
}

function buildAddendum(): string {
	const handled = new HandledStore(handledPath()).list();
	const lines = [
		"# Heartbeat run",
		"This is a scheduled heartbeat. Work the checklist below.",
		"SILENCE RULE: produce no user-facing report when everything is fine. Escalate via heartbeat_note(attention=true) only when something needs the user's attention, a check failed, or you took a notable action. Record routine outcomes via heartbeat_note and finish.",
		"",
		"## Checklist (HEARTBEAT.md)",
		readHeartbeatChecklist().trim(),
	];
	if (handled.length > 0) {
		lines.push("", "## Already handled (do not re-flag)");
		for (const entry of handled) lines.push(`- ${entry.key}${entry.note ? ` — ${entry.note}` : ""}`);
	}
	const log = recentLog(8);
	if (log.length > 0) lines.push("", "## Recent heartbeat log", ...log);
	return lines.join("\n");
}

const noteSchema = Type.Object({
	summary: Type.String({ description: "What you checked or did this heartbeat." }),
	attention: Type.Optional(
		Type.Boolean({
			description:
				"Set true only if this genuinely needs the user — it escalates (push). Routine outcomes stay pull-only.",
		}),
	),
	handled: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Stable keys of items you dealt with (e.g. 'pr-4811', 'slack-C123-ts'), so future heartbeats don't re-flag them.",
		}),
	),
	ttlHours: Type.Optional(
		Type.Number({ description: "How long handled keys stay suppressed (default 24)." }),
	),
});
type NoteInput = Static<typeof noteSchema>;

export default function heartbeatExtension(pi: ExtensionAPI): void {
	let heartbeatTurn = false;
	let noteRecorded = false;

	pi.on("before_agent_start", async (event) => {
		if (!isHeartbeatPrompt(event.prompt)) {
			heartbeatTurn = false;
			return;
		}
		heartbeatTurn = true;
		noteRecorded = false;
		new HandledStore(handledPath()).prune();
		return { systemPrompt: `${event.systemPrompt}\n\n${buildAddendum()}` };
	});

	pi.on("agent_end", async () => {
		if (heartbeatTurn && !noteRecorded) {
			appendHeartbeatLog("Heartbeat ran; nothing to report.");
		}
		heartbeatTurn = false;
	});

	pi.registerTool({
		name: "heartbeat_note",
		label: "heartbeat note",
		description:
			"Record the outcome of a heartbeat: log it, suppress handled items, and escalate only if it needs the user.",
		promptSnippet: "Record a heartbeat outcome (and escalate only if needed)",
		parameters: noteSchema,
		async execute(_id, params: NoteInput, _signal, _onUpdate, ctx) {
			const summary = params.summary.trim();
			if (summary === "") {
				return { content: [{ type: "text" as const, text: "summary is required" }], details: { ok: false } };
			}
			const store = new HandledStore(handledPath());
			const ttlMs = (params.ttlHours ?? 24) * 3_600_000;
			for (const key of params.handled ?? []) store.add(key, ttlMs);
			appendHeartbeatLog(params.attention ? `[ATTENTION] ${summary}` : summary);
			if (params.attention) {
				// Escalation: record + push (rate-limited) through the notify channel.
				notify({ summary, kind: "escalate", source: "heartbeat" });
			} else {
				recordDecision({ kind: "heartbeat", summary, source: "heartbeat" });
			}
			noteRecorded = true;
			if (params.attention && ctx.hasUI) ctx.ui.notify(`Heartbeat escalation: ${summary}`, "warning");
			return {
				content: [{ type: "text" as const, text: params.attention ? "Escalated and logged." : "Logged." }],
				details: { ok: true, attention: params.attention === true },
			};
		},
		renderResult: (res, _options, theme, renderCtx) => {
			const text = res.content.find((item) => item.type === "text")?.text ?? "";
			return new Text(
				renderCtx.isError ? theme.fg("error", text) : `${theme.fg("success", "✓ ")}${theme.fg("muted", text)}`,
				0,
				0,
			);
		},
	});

	pi.registerCommand("heartbeat", {
		description: "Heartbeat: /heartbeat status | init | run | edit",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "status", label: "status — show checklist path, handled count, recent log" },
				{ value: "init", label: "init — scaffold a default HEARTBEAT.md" },
				{ value: "run", label: "run — trigger a heartbeat now" },
				{ value: "edit", label: "edit — show the HEARTBEAT.md path" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx: ExtensionContext) => {
			const command = args.trim().split(/\s+/)[0] || "status";
			switch (command) {
				case "status": {
					const handled = new HandledStore(handledPath()).list().length;
					const log = recentLog(5);
					ctx.ui.notify(
						[
							`Heartbeat checklist: ${heartbeatFile()}${existsSync(heartbeatFile()) ? "" : " (using built-in default)"}`,
							`Handled items: ${handled}`,
							log.length ? ["Recent:", ...log].join("\n") : "No heartbeat runs logged yet.",
						].join("\n"),
						"info",
					);
					return;
				}
				case "init":
					ctx.ui.notify(`HEARTBEAT.md ready at ${ensureHeartbeatFile()}`, "info");
					return;
				case "run": {
					const prompt = buildHeartbeatPrompt();
					if (ctx.isIdle()) pi.sendUserMessage(prompt);
					else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
					ctx.ui.notify("Heartbeat queued.", "info");
					return;
				}
				case "edit":
					ctx.ui.notify(`Edit your checklist at: ${ensureHeartbeatFile()}`, "info");
					return;
				default:
					ctx.ui.notify("Usage: /heartbeat status | init | run | edit", "warning");
			}
		},
	});
}
