/**
 * Guardrails policy — pure classification of tool calls into risk tiers, and the
 * decision of what to do about a tier given the current autonomy level.
 *
 * This is the safety floor that makes "high autonomy, notify-after" acceptable:
 * the agent acts end-to-end within guardrails, but genuinely destructive or
 * irreversible-and-dangerous operations are blocked even though pi has no approval prompts.
 *
 * No Pi/fs imports — fully table-driven and unit-tested in policy.test.ts. The
 * extension (../index) maps a Decision onto an actual block/prompt/allow.
 */

/** Risk tiers, in increasing severity. */
export type Tier = "allow" | "notify" | "confirm" | "ask" | "banned";

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

export type CommandContext = {
	/** Current git branch for bare `git push` checks, when the caller can cheaply provide it. */
	currentBranch?: string;
	/** Treat destination-ambiguous pushes as protected (for compound commands in isolated children). */
	assumeBarePushProtected?: boolean;
};

type Predicate = (command: string, context: CommandContext) => boolean;

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

const PROTECTED_BRANCH_NAMES = [
	"main",
	"master",
	"develop",
	"development",
	"staging",
	"production",
	"prod",
	"release",
] as const;
function isProtectedBranchName(branch: string | undefined): boolean {
	return PROTECTED_BRANCH_NAMES.includes(branch as (typeof PROTECTED_BRANCH_NAMES)[number]);
}

const PUSH_OPTION_VALUE_FLAGS = new Set(["--exec", "--receive-pack", "--repo", "--push-option", "-o"]);
const KNOWN_REMOTE_NAMES = new Set(["origin", "upstream"]);
const GIT_PUSH_PATTERN = /\bgit(?:\s+(?:(?:-[Cc]|--(?:git-dir|work-tree|namespace|super-prefix|config-env))\s+(?:"[^"]*"|'[^']*'|\S+)|--[A-Za-z][\w-]*(?:=(?:"[^"]*"|'[^']*'|\S+))?|-[A-Za-z]))*\s+push\b/;

type GitPushInvocation = { command: string; args: string[] };

function isForcePushFlag(command: string): boolean {
	return /(--force(?!-with-lease)|(^|\s)-f(\s|$))/.test(command);
}

function normalizeRefToken(ref: string): string {
	// Shell wrappers such as `bash -c "git push origin main"` leave only one quote attached to
	// the final whitespace-split token. Trim edge quotes independently; quotes inside a ref stay
	// suspicious and are handled by isDynamicRef.
	return ref.trim().replace(/^[+'"]+/, "").replace(/['"]+$/, "");
}

function isDynamicRef(ref: string): boolean {
	const normalized = normalizeRefToken(ref);
	return /[$`\\'"]/.test(normalized) || /\$\(|\$\{|\b(eval|printenv|envsubst)\b/.test(normalized) || /^(HEAD|@)(?:[~^].*)?$/.test(normalized);
}

function refDestination(ref: string): string {
	const unquoted = normalizeRefToken(ref);
	const parts = unquoted.split(":");
	const destination = parts.length > 1 ? (parts[parts.length - 1] ?? "") : unquoted;
	return destination.replace(/^refs\/heads\//, "");
}

function isProtectedRef(ref: string): boolean {
	return isProtectedBranchName(refDestination(ref));
}

/** Every `git [global-options] push` invocation in a possibly compound/wrapped command.
 *  Non-option words after each push are parsed best-effort and intentionally conservatively. */
function gitPushInvocations(command: string): GitPushInvocation[] {
	const matcher = new RegExp(GIT_PUSH_PATTERN.source, "g");
	const invocations: GitPushInvocation[] = [];
	for (const match of command.matchAll(matcher)) {
		const tail = command.slice((match.index ?? 0) + match[0].length);
		const boundary = tail.search(/\s*(?:&&|\|\||;|\|)\s*/);
		const rest = (boundary >= 0 ? tail.slice(0, boundary) : tail).trim();
		const tokens = rest.split(/\s+/).filter(Boolean);
		const args: string[] = [];
		for (let i = 0; i < tokens.length; i += 1) {
			const token = tokens[i] ?? "";
			if (token === "--") {
				args.push(...tokens.slice(i + 1));
				break;
			}
			if (token.startsWith("--")) {
				const key = token.split("=")[0] ?? token;
				if (!token.includes("=") && PUSH_OPTION_VALUE_FLAGS.has(key)) i += 1;
				continue;
			}
			if (/^-[A-Za-z]+$/.test(token)) {
				// Short push flags like -u/--set-upstream do not themselves name a ref.
				if (PUSH_OPTION_VALUE_FLAGS.has(token)) i += 1;
				continue;
			}
			args.push(token);
		}
		invocations.push({ command: `${match[0]}${rest ? ` ${rest}` : ""}`, args });
	}
	return invocations;
}

function isGitPush(command: string): boolean {
	return gitPushInvocations(command).length > 0;
}

function isAnyForcePush(command: string): boolean {
	return gitPushInvocations(command).some((invocation) => isForcePushFlag(invocation.command));
}

function refArgs(args: readonly string[]): string[] {
	if (args.length === 0) return [];
	return KNOWN_REMOTE_NAMES.has(args[0] ?? "") ? args.slice(1) : [...args];
}

function isRemoteOnlyPush(args: readonly string[]): boolean {
	return args.length === 1 && !args[0]?.includes(":") && !args[0]?.startsWith("+");
}

/** Force-push that targets a protected branch, including bare/current-branch
 *  force-pushes when the current branch is protected. */
function isForcePushProtected(command: string, context: CommandContext): boolean {
	for (const invocation of gitPushInvocations(command)) {
		const { args } = invocation;
		const refs = refArgs(args);
		const plusForceRefs = refs.filter((ref) => ref.startsWith("+"));
		if (plusForceRefs.some((ref) => isProtectedRef(ref) || (KNOWN_REMOTE_NAMES.has(args[0] ?? "") && isDynamicRef(ref)))) return true;
		if (!isForcePushFlag(invocation.command)) continue;
		if (refs.some((ref) => isProtectedRef(ref) || (KNOWN_REMOTE_NAMES.has(args[0] ?? "") && isDynamicRef(ref)))) return true;
		if ((isProtectedBranchName(context.currentBranch) || context.assumeBarePushProtected === true) && (args.length === 0 || isRemoteOnlyPush(args))) return true;
	}
	return false;
}

/** A plain (non-force) push whose explicit refspec target is a protected branch,
 *  or whose ref target is dynamic enough that the guardrail cannot prove it is
 *  safe. Dynamic refs to known remotes ask rather than silently falling through
 *  to the generic git-push notify tier. */
function isPushToProtected(command: string): boolean {
	return gitPushInvocations(command).some(({ args }) => {
		const refs = refArgs(args);
		return refs.some((ref) => isProtectedRef(ref) || (KNOWN_REMOTE_NAMES.has(args[0] ?? "") && isDynamicRef(ref)));
	});
}

/** A bare or remote-only push from a protected current branch. Git's default
 *  push behaviour can target the upstream branch without spelling it out, so
 *  `git push` on main is as consequential as `git push origin main`. */
function isBarePushFromProtectedBranch(command: string, context: CommandContext): boolean {
	if (!isProtectedBranchName(context.currentBranch) && context.assumeBarePushProtected !== true) return false;
	return gitPushInvocations(command).some(({ args }) => args.length === 0 || isRemoteOnlyPush(args));
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
	{ id: "git-force-push-protected", tier: "banned", match: isForcePushProtected, reason: "Force-push to a protected branch (main/master/develop/production…)." },
	{ id: "git-push-protected", tier: "ask", match: isPushToProtected, reason: "Pushing straight to a protected branch requires explicit human approval." },
	{ id: "git-bare-push-protected", tier: "ask", match: isBarePushFromProtectedBranch, reason: "A destination-ambiguous git push may target a protected upstream and requires explicit human approval." },
	{ id: "gh-pr-merge", tier: "banned", match: /\bgh\s+pr\s+merge\b/, reason: "Merging a PR is not permitted for the autonomous agent — a human merges." },
	{ id: "git-history-rewrite", tier: "banned", match: /\bgit\s+filter-branch\b|\bgit[-\s]filter-repo\b/, reason: "Rewriting git history irreversibly." },
	{ id: "terraform-destroy", tier: "banned", match: /\bterraform\s+destroy\b/, reason: "Tearing down infrastructure." },
	{ id: "drop-database", tier: "banned", match: /\bdrop\s+database\b/i, reason: "Dropping a database." },
	{ id: "remote-pipe-shell", tier: "banned", match: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|fish)\b/, reason: "Piping a remote download straight into a shell." },

	// --- confirm: irreversible / consequential, but a normal part of work -------
	{ id: "git-force-push", tier: "confirm", match: isAnyForcePush, reason: "Force-push (history overwrite on the remote branch)." },
	{ id: "git-clean", tier: "confirm", match: /\bgit\s+clean\b[^\n]*-[a-z]*f/, reason: "Deleting untracked files." },
	{ id: "package-publish", tier: "confirm", match: /\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgh\s+release\s+create\b/, reason: "Publishing a package/release (outward, hard to retract)." },
	{ id: "deploy", tier: "confirm", match: /\bterraform\s+apply\b|\bkubectl\b[^\n]*\bdelete\b|\bflyctl\s+deploy\b|\bvercel\b[^\n]*--prod\b|\bwrangler\s+deploy\b|\b(gcloud|aws)\b[^\n]*\bdelete\b/, reason: "Deploying or deleting cloud/infra resources." },
	{ id: "sql-drop-table", tier: "confirm", match: /\b(drop\s+table|truncate\s+table)\b/i, reason: "Dropping/truncating a table." },
	{ id: "chmod-777", tier: "confirm", match: /\bchmod\s+-R\s+0?777\b/, reason: "Recursively world-writable permissions." },

	// --- notify: reversible but worth recording --------------------------------
	{ id: "git-reset-hard", tier: "notify", match: /\bgit\s+reset\s+--hard\b/, reason: "Hard reset (recoverable via reflog)." },
	{ id: "git-push", tier: "notify", match: isGitPush, reason: "Pushing to a remote." },
];

/** Metadata for every rule, for display by the /guard command. */
export function listRules(): { rule: string; tier: Tier; reason: string }[] {
	return RULES.map((rule) => ({ rule: rule.id, tier: rule.tier, reason: rule.reason }));
}

/** Classify a raw shell command into a risk tier. First matching rule wins. */
export function classifyCommand(command: string, context: CommandContext = {}): Classification {
	const normalised = command.replace(/\s+/g, " ").trim();
	for (const rule of RULES) {
		const hit =
			typeof rule.match === "function"
				? rule.match(normalised, context)
				: rule.match.test(normalised);
		if (hit) return { tier: rule.tier, rule: rule.id, reason: rule.reason };
	}
	return ALLOW;
}

/** Classify a tool call. Only `bash` is inspected today; other tools allow. */
export function classifyToolCall(toolName: string, input: unknown, context: CommandContext = {}): Classification {
	if (toolName !== "bash") return ALLOW;
	const command =
		input && typeof input === "object" && "command" in input
			? String((input as { command: unknown }).command ?? "")
			: "";
	return command ? classifyCommand(command, context) : ALLOW;
}

/**
 * Decide what to do about a classification given the autonomy level and whether
 * a UI is available to prompt. Banned is always blocked; ask always requires an
 * interactive prompt; the confirm/notify tiers soften as autonomy rises.
 *
 * - high:         act on confirm/notify; escalate (notify-after) on confirm.
 * - balanced:     prompt for confirm when interactive, else block+escalate.
 * - conservative: prompt for confirm and notify when interactive, else block+escalate.
 * - ask:          always prompt when interactive; block headless/non-interactive.
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

	if (tier === "ask") {
		return gated();
	}

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
