import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init.ts";

describe("brain init", () => {
  it("creates local cache/auth/log directories with private permissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-init-"));
    try {
      const home = join(dir, "home");
      const root = join(dir, "memories");
      const write = process.stdout.write;
      process.stdout.write = (() => true) as typeof process.stdout.write;
      try {
        await runInit({
          command: "init",
          positional: [],
          flags: { home, root, scope: "personal" },
        });
      } finally {
        process.stdout.write = write;
      }

      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, "personal")).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, ".cache")).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, "auth")).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, "logs")).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
