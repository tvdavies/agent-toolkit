import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { streamAnthropic } from "@earendil-works/pi-ai/anthropic";

const nativeModule = process.env.PI_TEST_ANTHROPIC_API_MODULE;

for (const native of [false, true]) {
  test.skipIf(native && !nativeModule)(`Claude Code version reaches the wire via ${native ? "installed" : "pinned"} SDK`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-code-version-"));
    const headers: Headers[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      headers.push(request.headers);
      // Stop locally after capturing headers; no model or credentials are used.
      return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Local fixture" } }, { status: 400 });
    } });
    try {
      const keyFile = join(directory, "proxy.key");
      await writeFile(keyFile, "fixture-only-key");
      const extensionUrl = new URL("../../extensions/anthropic-claude-code.ts", import.meta.url).href;
      // A separate module environment prevents tests from reading private credentials
      // or depending on whichever environment first imported the extension.
      const child = Bun.spawnSync([process.execPath, "--eval", `
        const { default: extension } = await import(${JSON.stringify(extensionUrl)});
        await extension({
          registerProvider(name, config) { console.log(JSON.stringify({ name, config })); },
          registerCommand() {}, on() {},
        });
      `], { env: { ...process.env, PI_CLAUDE_CODE_API_KEY_FILE: keyFile, PI_CLAUDE_CODE_BASE_URL: server.url.toString() } });
      expect(child.exitCode).toBe(0);
      const registration = JSON.parse(child.stdout.toString()) as {
        name: string;
        config: { api: "anthropic-messages"; baseUrl: string; apiKey: string; headers: Record<string, string>; models: Model<"anthropic-messages">[] };
      };
      expect(registration.name).toBe("anthropic-claude-code");
      expect(registration.config.headers["user-agent"]).toBe("claude-cli/2.1.280 (external, sdk-cli)");
      let stream = streamAnthropic;
      if (native) {
        if (!nativeModule || !isAbsolute(nativeModule)) throw new Error("Expected absolute native SDK path");
        stream = (await import(pathToFileURL(nativeModule).href)).stream;
      }
      const { config } = registration;
      const definition = config.models.find((model) => model.id === "claude-opus-5-5")!;
      const model: Model<"anthropic-messages"> = {
        ...definition, api: config.api, provider: registration.name, baseUrl: config.baseUrl, headers: config.headers,
      };
      for (const apiKey of [config.apiKey, "sk-ant-oat-fixture-not-a-real-token"]) {
        const result = await stream(model, { messages: [{ role: "user", content: "Local fixture", timestamp: 0 }] }, { apiKey, maxRetries: 0 }).result();
        expect(result.stopReason).toBe("error");
        expect(result.errorMessage).toContain("Local fixture");
      }
      expect(headers).toHaveLength(2);
      for (const requestHeaders of headers) {
        expect(requestHeaders.get("user-agent")).toBe(config.headers["user-agent"]!);
        expect(requestHeaders.get("user-agent")).not.toContain("2.1.261");
      }
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
