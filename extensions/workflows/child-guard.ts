/** Filesystem confinement for workflow subagents.
 *
 * Built-in path tools are restricted to the child's isolated repository. Bash commands run
 * in a minimal bubblewrap mount namespace: only system runtimes and the isolated repository
 * are visible, only the repository is writable, the environment is cleared, and networking is
 * disabled unless the approved agent() call explicitly requests `network: true`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function repositoryRoot(cwd: string): string {
	let current = path.resolve(cwd);
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(cwd);
		current = parent;
	}
}

function nearestExistingRealPath(candidate: string): string {
	let current = path.resolve(candidate);
	const suffix: string[] = [];
	while (!fs.existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) break;
		suffix.unshift(path.basename(current));
		current = parent;
	}
	const base = fs.realpathSync.native(current);
	return path.join(base, ...suffix);
}

export function isInside(root: string, candidate: string): boolean {
	const resolvedRoot = fs.realpathSync.native(root);
	let resolvedCandidate: string;
	try { resolvedCandidate = nearestExistingRealPath(candidate); }
	catch { return false; }
	const relative = path.relative(resolvedRoot, resolvedCandidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

interface ChildPolicy {
	network: boolean;
	tokenPath?: string;
}

function readPolicy(root: string): ChildPolicy {
	const stem = path.join(path.dirname(root), `.policy-${path.basename(root)}`);
	const policyPath = `${stem}.json`;
	let network = false;
	try { network = JSON.parse(fs.readFileSync(policyPath, "utf8")).network === true; } catch { /* secure default */ }
	const tokenPath = `${stem}.github-token`;
	return { network, tokenPath: fs.existsSync(tokenPath) ? tokenPath : undefined };
}

function roBindIfPresent(args: string[], source: string, target = source): void {
	if (fs.existsSync(source)) args.push(`--ro-bind ${shellQuote(source)} ${shellQuote(target)}`);
}

export function sandboxCommand(command: string, cwd: string, root: string): string {
	const bwrap = process.env.PI_WORKFLOW_BWRAP?.trim() || "/usr/bin/bwrap";
	const policy = readPolicy(root);
	const args = [
		shellQuote(bwrap),
		"--die-with-parent",
		"--new-session",
		"--unshare-all",
		...(policy.network ? ["--share-net"] : []),
		"--cap-drop ALL",
		"--clearenv",
		`--setenv PATH ${shellQuote(process.env.PATH || "/usr/local/bin:/usr/bin:/bin")}`,
		"--setenv HOME /tmp/home",
		"--setenv TMPDIR /tmp",
		"--setenv LANG C.UTF-8",
		"--setenv GIT_AUTHOR_NAME 'Pi Workflow Agent'",
		"--setenv GIT_AUTHOR_EMAIL 'pi-workflow@localhost'",
		"--setenv GIT_COMMITTER_NAME 'Pi Workflow Agent'",
		"--setenv GIT_COMMITTER_EMAIL 'pi-workflow@localhost'",
		"--tmpfs /tmp",
		"--dir /tmp/home",
		"--dir /run",
		"--proc /proc",
		"--dev /dev",
	];
	for (const runtimePath of [
		"/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/nix/store",
		path.join(os.homedir(), ".local", "share", "nvm"),
		path.join(os.homedir(), ".bun", "bin"),
		"/etc/ssl", "/etc/ca-certificates", "/etc/alternatives", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf",
	]) roBindIfPresent(args, runtimePath);
	if (policy.network) {
		for (const networkPath of ["/etc/hosts", "/etc/resolv.conf", "/etc/gai.conf"]) roBindIfPresent(args, networkPath);
	}
	if (policy.tokenPath) roBindIfPresent(args, policy.tokenPath, "/run/pi-workflow-github-token");
	args.push(`--bind ${shellQuote(root)} ${shellQuote(root)}`);
	args.push(`--chdir ${shellQuote(cwd)}`);
	const authPrefix = policy.tokenPath
		? 'export GH_TOKEN="$(cat /run/pi-workflow-github-token)" GITHUB_TOKEN="$(cat /run/pi-workflow-github-token)"; '
		: "";
	args.push("/bin/bash -lc", shellQuote(`${authPrefix}${command}`));
	return args.join(" ");
}

export default function workflowChildGuard(pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		const root = repositoryRoot(ctx.cwd);
		const input = event.input as Record<string, unknown>;
		if (event.toolName === "bash" && typeof input.command === "string") {
			input.command = sandboxCommand(input.command, ctx.cwd, root);
			return;
		}
		if (["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName) && typeof input.path === "string") {
			const candidate = path.isAbsolute(input.path) ? input.path : path.resolve(ctx.cwd, input.path);
			if (!isInside(root, candidate)) return { block: true, reason: `Workflow child path is outside its isolated repository: ${input.path}` };
		}
	});
}
