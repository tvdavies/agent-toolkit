/**
 * Guardrails policy — pure classification of tool calls into risk tiers, and the
 * decision of what to do about a tier given the current autonomy level.
 *
 * This is the safety floor that makes "high autonomy, notify-after" acceptable:
 * the agent acts end-to-end within guardrails, but genuinely destructive or
 * irreversible-and-dangerous operations are blocked even under `--yolo`.
 *
 * No Pi/fs imports — fully table-driven and unit-tested in policy.test.ts. The
 * extension (../index) maps a Decision onto an actual block/prompt/allow.
 */

/** Risk tiers, in increasing severity. */
export type Tier = "allow" | "notify" | "confirm" | "banned";

/** How much the agent may do on the user's behalf without asking. */
export type AutonomyLevel = "high" | "balanced" | "conservative";

export type Classification = {
	tier: Tier;
	/** Stable rule id for logging, e.g. "rm-rf-root". */
	rule: string;
	/** Human-readable explanation shown to the agent/user. */
	reason: string;
};

export type Decision = {
	action: "allow" | "prompt" | "block";
	/** Push a notice to the human (after acting, or on block). */
	escalate: boolean;
	classification: Classification;
};

type Predicate = (command: string) => boolean;

type Rule = {
	id: string;
	tier: Tier;
	match: RegExp | Predicate;
	reason: string;
};

const ALLOW: Classification = {
	tier: "allow",
	rule: "default-allow",
	reason: "No guardrail matched.",
};

/**
 * A recursive-force `rm` aimed at a catastrophic target: filesystem root, home,
 * a top-level system directory, or a broad glob. Benign recursive deletes (a
 * build dir, node_modules, a path under /tmp) are intentionally NOT flagged.
 */
function isDangerousRm(command: string): boolean {
	const match = /\brm\b(.*)/s.exec(command);
	if (!match) return false;
	const rest = match[1] ?? "";
	const recursiveForce =
		/-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r/i.test(rest) ||
		(/(^|\s)-[a-z]*r/i.test(rest) && /(^|\s)-[a-z]*f/i.test(rest)) ||
		(/--recursive\b/.test(rest) && /--force\b/.test(rest));
	if (!recursiveForce) return false;
	const exact = /^(\/|~|\*|\.\*|\$HOME|\/\*|~\/\*?)$/;
	const systemRoot =
		/^\/(etc|usr|var|bin|boot|lib|lib64|opt|sys|proc|dev|root|sbin|home|mnt|media)(\/.*|\/?\*?)?$/;
	return rest
		.split(/\s+/)
		.filter((token) => token !== "" && !token.startsWith("-"))
		.some((token) => exact.test(token) || systemRoot.test(token));
}

/** Force-push that targets a protected branch. */
function isForcePushProtected(command: string): boolean {
	if (!/\bgit\s+push\b/.test(command)) return false;
	if (!/(--force(?!-with-lease)|(^|\s)-f(\s|$))/.test(command)) return false;
	return /\b(main|master|production|prod|release)\b/.test(command) || /\s\+(main|master)/.test(command);
}

/**
 * Rules are evaluated in order; the first match wins, so list most-severe first.
 * Patterns are intentionally conservative — they target unambiguous, well-known
 * destructive shapes rather than guessing at intent.
 */
const RULES: Rule[] = [
	// --- banned: destructive / irreversible-and-dangerous ----------------------
	{ id: "rm-rf-root", tier: "banned", match: isDangerousRm, reason: "Recursive force-delete of a root, home, or broad-glob path." },
	{ id: "forkbomb", tier: "banned", match: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "Fork bomb." },
	{ id: "sudo", tier: "banned", match: /(^|\s)sudo(\s|$)/, reason: "Privilege escalation is not permitted for the autonomous agent." },
	{ id: "power-state", tier: "banned", match: /\b(shutdown|reboot|halt|poweroff)\b|\binit\s+[06]\b/, reason: "Host power-state change." },
	{ id: "mkfs", tier: "banned", match: /\bmkfs(\.\w+)?\b/, reason: "Filesystem format." },
	{ id: "dd-device", tier: "banned", match: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd|mmcblk)/, reason: "Raw write to a block device." },
	{ id: "redirect-device", tier: "banned", match: />\s*\/dev\/(sd|nvme|disk|hd|mmcblk)/, reason: "Redirect over a block device." },
	{ id: "git-force-push-protected", tier: "banned", match: isForcePushProtected, reason: "Force-push to a protected branch (main/master/production)." },
	{ id: "git-history-rewrite", tier: "banned", match: /\bgit\s+filter-branch\b|\bgit[-\s]filter-repo\b/, reason: "Rewriting git history irreversibly." },
	{ id: "terraform-destroy", tier: "banned", match: /\bterraform\s+destroy\b/, reason: "Tearing down infrastructure." },
	{ id: "drop-database", tier: "banned", match: /\bdrop\s+database\b/i, reason: "Dropping a database." },
	{ id: "remote-pipe-shell", tier: "banned", match: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|fish)\b/, reason: "Piping a remote download straight into a shell." },

	// --- confirm: irreversible / consequential, but a normal part of work -------
	{ id: "git-force-push", tier: "confirm", match: /\bgit\s+push\b[^\n]*(--force(?!-with-lease)|(\s|^)-f(\s|$))/, reason: "Force-push (history overwrite on the remote branch)." },
	{ id: "git-clean", tier: "confirm", match: /\bgit\s+clean\b[^\n]*-[a-z]*f/, reason: "Deleting untracked files." },
	{ id: "package-publish", tier: "confirm", match: /\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgh\s+release\s+create\b/, reason: "Publishing a package/release (outward, hard to retract)." },
	{ id: "deploy", tier: "confirm", match: /\bterraform\s+apply\b|\bkubectl\b[^\n]*\bdelete\b|\bflyctl\s+deploy\b|\bvercel\b[^\n]*--prod\b|\bwrangler\s+deploy\b|\b(gcloud|aws)\b[^\n]*\bdelete\b/, reason: "Deploying or deleting cloud/infra resources." },
	{ id: "sql-drop-table", tier: "confirm", match: /\b(drop\s+table|truncate\s+table)\b/i, reason: "Dropping/truncating a table." },
	{ id: "chmod-777", tier: "confirm", match: /\bchmod\s+-R\s+0?777\b/, reason: "Recursively world-writable permissions." },

	// --- notify: reversible but worth recording --------------------------------
	{ id: "git-reset-hard", tier: "notify", match: /\bgit\s+reset\s+--hard\b/, reason: "Hard reset (recoverable via reflog)." },
	{ id: "git-push", tier: "notify", match: /\bgit\s+push\b/, reason: "Pushing to a remote." },
];

/** Metadata for every rule, for display by the /guard command. */
export function listRules(): { rule: string; tier: Tier; reason: string }[] {
	return RULES.map((rule) => ({ rule: rule.id, tier: rule.tier, reason: rule.reason }));
}

/** Classify a raw shell command into a risk tier. First matching rule wins. */
export function classifyCommand(command: string): Classification {
	const normalised = command.replace(/\s+/g, " ").trim();
	for (const rule of RULES) {
		const hit =
			typeof rule.match === "function"
				? rule.match(normalised)
				: rule.match.test(normalised);
		if (hit) return { tier: rule.tier, rule: rule.id, reason: rule.reason };
	}
	return ALLOW;
}

/** Classify a tool call. Only `bash` is inspected today; other tools allow. */
export function classifyToolCall(toolName: string, input: unknown): Classification {
	if (toolName !== "bash") return ALLOW;
	const command =
		input && typeof input === "object" && "command" in input
			? String((input as { command: unknown }).command ?? "")
			: "";
	return command ? classifyCommand(command) : ALLOW;
}

/**
 * Decide what to do about a classification given the autonomy level and whether
 * a UI is available to prompt. Banned is always blocked; the confirm/notify
 * tiers soften as autonomy rises.
 *
 * - high:         act on everything except banned; escalate (notify-after) on confirm.
 * - balanced:     prompt for confirm when interactive, else block+escalate.
 * - conservative: prompt for confirm and notify when interactive, else block+escalate.
 */
export function decide(
	classification: Classification,
	options: { autonomy: AutonomyLevel; hasUI: boolean },
): Decision {
	const { tier } = classification;
	const { autonomy, hasUI } = options;

	if (tier === "banned") {
		return { action: "block", escalate: true, classification };
	}
	if (tier === "allow") {
		return { action: "allow", escalate: false, classification };
	}

	const gated = (): Decision =>
		hasUI
			? { action: "prompt", escalate: false, classification }
			: { action: "block", escalate: true, classification };

	if (tier === "confirm") {
		if (autonomy === "high") {
			return { action: "allow", escalate: true, classification };
		}
		return gated();
	}

	// tier === "notify"
	if (autonomy === "conservative") return gated();
	return { action: "allow", escalate: true, classification };
}
