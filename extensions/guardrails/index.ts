/**
 * Guardrails extension — the safety floor for autonomous operation.
 *
 * Subscribes to `tool_call` and blocks destructive/irreversible operations even
 * without pi approval prompts. Pairs with the "high autonomy, notify-after" policy: the agent
 * acts on everything except genuinely dangerous ops (which are blocked) and, at
 * the `ask` tier always requires an interactive Pi prompt, and at lower autonomy
 * levels the "confirm" tier is also gated. All blocks and notify-after escalations are
 * recorded to the decision spine.
 *
 * Config:
 *   AGENT_TOOLKIT_AUTONOMY  high (default) | balanced | conservative
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recordDecision } from "../lib/decisions";
import {
	type AutonomyLevel,
	classifyToolCall,
	decide,
	listRules,
} from "./policy";

function initialAutonomy(): AutonomyLevel {
	const raw = process.env.AGENT_TOOLKIT_AUTONOMY;
	if (raw === "balanced" || raw === "conservative" || raw === "high") return raw;
	return "high";
}

function bashCommand(input: unknown): string {
	return input && typeof input === "object" && "command" in input
		? String((input as { command: unknown }).command ?? "")
		: "";
}

function commandCwd(input: unknown): string | undefined {
	if (!input || typeof input !== "object" || !("cwd" in input)) return undefined;
	const cwd = (input as { cwd?: unknown }).cwd;
	return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
}

function currentGitBranch(cwd: string | undefined): string | undefined {
	const result = spawnSync("git", ["branch", "--show-current"], {
		cwd: cwd ?? process.cwd(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 1000,
	});
	return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

export default function guardrailsExtension(pi: ExtensionAPI): void {
	let autonomy = initialAutonomy();

	pi.on("tool_call", async (event, ctx) => {
		const command = event.toolName === "bash" ? bashCommand(event.input) : "";
		const classification = classifyToolCall(event.toolName, event.input, {
			currentBranch: /\bgit\s+push\b/.test(command) ? currentGitBranch(commandCwd(event.input)) : undefined,
		});
		if (classification.tier === "allow") return;

		const decision = decide(classification, { autonomy, hasUI: ctx.hasUI });

		if (decision.action === "prompt") {
			const ok = await ctx.ui.confirm(
				"Guardrail",
				`${classification.reason}\n\nRule: ${classification.rule}. Proceed?`,
			);
			if (ok) {
				recordDecision({
					kind: "guardrail-allow",
					summary: `Approved ${classification.rule}: ${classification.reason}`,
					source: "interactive",
				});
				return;
			}
			recordDecision({
				kind: "guardrail-block",
				summary: `Declined ${classification.rule}: ${classification.reason}`,
				source: "interactive",
			});
			return { block: true, reason: `Declined at guardrail prompt (${classification.rule}).` };
		}

		if (decision.action === "block") {
			recordDecision({
				kind: "guardrail-block",
				summary: `Blocked ${classification.rule}: ${classification.reason}`,
				detail: { tier: classification.tier, autonomy },
			});
			if (ctx.hasUI) ctx.ui.notify(`⛔ Guardrail blocked: ${classification.reason}`, "error");
			const explanation =
				classification.tier === "banned"
					? "banned (destructive/irreversible)"
					: classification.tier === "ask"
						? "blocked because it requires an interactive Pi approval step"
						: "gated at the current autonomy level";
			return {
				block: true,
				reason: `Blocked by guardrail "${classification.rule}": ${classification.reason} This operation is ${explanation}. If it is genuinely required, ask the user to approve it explicitly.`,
			};
		}

		// action === "allow": proceed, but record notify-after escalations.
		if (decision.escalate) {
			recordDecision({
				kind: "guardrail-allow",
				summary: `Acted on ${classification.rule}: ${classification.reason}`,
				detail: { tier: classification.tier, autonomy },
			});
			if (ctx.hasUI) {
				ctx.ui.notify(`⚠ ${classification.reason} (allowed; logged)`, "warning");
			}
		}
		return;
	});

	pi.registerCommand("guard", {
		description:
			"Guardrails: /guard status | level <high|balanced|conservative> | list",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "status", label: "status — show autonomy level" },
				{ value: "level ", label: "level — set high|balanced|conservative" },
				{ value: "list", label: "list — show guardrail rules" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const [command = "status", value] = args.trim().split(/\s+/).filter(Boolean);
			switch (command) {
				case "status":
					ctx.ui.notify(
						`Guardrails active. Autonomy: ${autonomy}. Banned ops are always blocked.`,
						"info",
					);
					return;
				case "level": {
					if (value === "high" || value === "balanced" || value === "conservative") {
						autonomy = value;
						ctx.ui.notify(`Autonomy set to ${autonomy}.`, "info");
					} else {
						ctx.ui.notify("Usage: /guard level <high|balanced|conservative>", "warning");
					}
					return;
				}
				case "list": {
					const byTier = listRules();
					const lines = ["Guardrail rules (first match wins):"];
					for (const tier of ["banned", "ask", "confirm", "notify"] as const) {
						lines.push(`\n${tier.toUpperCase()}:`);
						for (const r of byTier.filter((x) => x.tier === tier)) {
							lines.push(`  • ${r.rule} — ${r.reason}`);
						}
					}
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				default:
					ctx.ui.notify(
						"Usage: /guard status | level <high|balanced|conservative> | list",
						"warning",
					);
			}
		},
	});
}
