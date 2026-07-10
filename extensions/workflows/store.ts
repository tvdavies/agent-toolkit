import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

async function fsyncDirectory(dir: string): Promise<void> {
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(dir, "r");
		await handle.sync();
	} catch {
		// Directory fsync is not supported on every platform/filesystem.
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export async function atomicWriteFile(filePath: string, contents: string, mode = 0o600): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(temp, "wx", mode);
		await handle.writeFile(contents, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.promises.rename(temp, filePath);
		await fsyncDirectory(dir);
	} finally {
		await handle?.close().catch(() => undefined);
		await fs.promises.rm(temp, { force: true }).catch(() => undefined);
	}
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
	await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	const handle = await fs.promises.open(filePath, "a", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}
