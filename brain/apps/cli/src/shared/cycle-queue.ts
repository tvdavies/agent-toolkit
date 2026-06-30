import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CycleRequest = {
  id: string;
  enqueuedAt: string;
  scope: string;
  phase?: string;
  dryRun: boolean;
};

async function dirs(homeDir: string) {
  const base = join(homeDir, "cycle-queue");
  const pending = join(base, "pending");
  const inFlight = join(base, "in-flight");
  await mkdir(pending, { recursive: true });
  await mkdir(inFlight, { recursive: true });
  return { pending, inFlight };
}

export async function enqueueCycleRequest(opts: {
  homeDir: string;
  scope: string;
  phase?: string;
  dryRun?: boolean;
}): Promise<CycleRequest> {
  const { pending } = await dirs(opts.homeDir);
  const id = randomUUID().slice(0, 12);
  const enqueuedAt = new Date().toISOString();
  const req: CycleRequest = {
    id,
    enqueuedAt,
    scope: opts.scope,
    dryRun: opts.dryRun === true,
    ...(opts.phase !== undefined ? { phase: opts.phase } : {}),
  };
  const safeTs = enqueuedAt.replace(/[:.]/g, "-");
  const filename = `${safeTs}-${id}.json`;
  const tmp = join(pending, `.tmp-${filename}`);
  const finalPath = join(pending, filename);
  await writeFile(tmp, JSON.stringify(req), "utf8");
  await rename(tmp, finalPath);
  return req;
}

export async function claimCycleRequest(homeDir: string): Promise<{
  request: CycleRequest;
  ack(): Promise<void>;
  fail(): Promise<void>;
} | null> {
  const { pending, inFlight } = await dirs(homeDir);
  const entries = (await readdir(pending))
    .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
    .sort();
  for (const filename of entries) {
    const from = join(pending, filename);
    const to = join(inFlight, filename);
    try {
      await rename(from, to);
    } catch {
      continue;
    }
    try {
      const request = JSON.parse(await Bun.file(to).text()) as CycleRequest;
      return {
        request,
        ack: async () => {
          await rm(to, { force: true });
        },
        fail: async () => {
          await rename(to, from).catch(() => undefined);
        },
      };
    } catch {
      await rm(to, { force: true });
    }
  }
  return null;
}
