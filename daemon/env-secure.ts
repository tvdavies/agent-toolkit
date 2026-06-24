/**
 * Secrets-file security check — the env file is a security boundary, so the
 * daemon refuses to start if it is group/world accessible or not owned by us.
 *
 * Pure (takes the stat facts), so it is tested without touching the filesystem;
 * the daemon supplies real `statSync` results.
 */

export type FileFacts = {
	/** Permission bits, e.g. 0o600. */
	mode: number;
	/** Owner uid. */
	uid: number;
};

export type SecurityResult = { ok: true } | { ok: false; reason: string };

/** A secrets file must be owned by the current user and have no group/world bits. */
export function checkEnvFileSecurity(facts: FileFacts, currentUid: number): SecurityResult {
	if (facts.uid !== currentUid) {
		return { ok: false, reason: "env file is not owned by the current user" };
	}
	if ((facts.mode & 0o077) !== 0) {
		const octal = (facts.mode & 0o777).toString(8).padStart(3, "0");
		return { ok: false, reason: `env file must be mode 600 (is ${octal})` };
	}
	return { ok: true };
}
