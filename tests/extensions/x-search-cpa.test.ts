import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import xSearch, {
	buildXSearchRequest,
	formatXSearchResult,
	resolveXSearchConfig,
	responsesUrl,
	runXSearch,
} from "../../extensions/x-search-cpa.ts";

const dir = mkdtempSync(join(os.tmpdir(), "x-search-cpa-"));
const keyFile = join(dir, "key");
writeFileSync(keyFile, "test-key\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveXSearchConfig", () => {
	test("is off without a CPA base URL", () => {
		expect(resolveXSearchConfig({})).toBeNull();
	});

	test("falls back to the Claude-through-CPA base URL, CPA's key file and the default model", () => {
		expect(resolveXSearchConfig({ PI_CLAUDE_CODE_BASE_URL: "http://cpa:8317" })).toEqual({
			baseUrl: "http://cpa:8317",
			keyFile: join(os.homedir(), ".cli-proxy-api/proxy.key"),
			model: "grok-4.6",
		});
	});

	test("prefers its own settings and expands ~", () => {
		expect(
			resolveXSearchConfig({
				PI_X_SEARCH_BASE_URL: "http://x:1/v1",
				PI_CLAUDE_CODE_BASE_URL: "http://cpa:8317",
				PI_X_SEARCH_API_KEY_FILE: "~/k",
				PI_X_SEARCH_MODEL: "grok-4.7",
			}),
		).toEqual({ baseUrl: "http://x:1/v1", keyFile: join(os.homedir(), "k"), model: "grok-4.7" });
	});
});

test("responsesUrl accepts a base URL with or without /v1", () => {
	expect(responsesUrl("http://cpa:8317")).toBe("http://cpa:8317/v1/responses");
	expect(responsesUrl("http://cpa:8317/v1/")).toBe("http://cpa:8317/v1/responses");
});

test("buildXSearchRequest states today's date and passes the filters to x_search", () => {
	const request = buildXSearchRequest(
		{ query: " exploited npm packages ", from_date: "2026-10-20", allowed_x_handles: ["@CISAgov", " "] },
		"grok-4.6",
		new Date("2026-10-22T08:00:00Z"),
	);
	expect(request.instructions).toStartWith("Today is 2026-10-22 (UTC).");
	expect(request.input).toBe("exploited npm packages");
	expect(request.tools).toEqual([{ type: "x_search", from_date: "2026-10-20", allowed_x_handles: ["CISAgov"] }]);
	expect(request.store).toBe(false);
});

test("formatXSearchResult joins the answer and lists each cited URL once", () => {
	const text = formatXSearchResult({
		output: [
			{ type: "reasoning" },
			{
				type: "message",
				content: [{ type: "output_text", text: "Two posts.", annotations: [{ url: "https://x.com/a/1" }, { url: "https://x.com/a/1" }] }],
			},
		],
	});
	expect(text).toBe("Two posts.\n\nSources consulted:\n1. https://x.com/a/1");
});

describe("runXSearch", () => {
	const config = { baseUrl: "http://cpa:8317", keyFile, model: "grok-4.6" };

	test("posts to CPA with the key from the file", async () => {
		let seen: { url: string; init: RequestInit } | undefined;
		const fakeFetch = (async (url: string, init: RequestInit) => {
			seen = { url, init };
			return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] });
		}) as unknown as typeof fetch;
		expect(await runXSearch({ query: "q" }, config, undefined, fakeFetch)).toBe("ok");
		expect(seen?.url).toBe("http://cpa:8317/v1/responses");
		expect((seen?.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
		expect(JSON.parse(String(seen?.init.body)).model).toBe("grok-4.6");
	});

	test("reports HTTP errors and a missing key file without the key", async () => {
		const failing = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
		await expect(runXSearch({ query: "q" }, config, undefined, failing)).rejects.toThrow("CPA returned HTTP 401: nope");
		await expect(runXSearch({ query: "q" }, { ...config, keyFile: join(dir, "missing") })).rejects.toThrow(
			"CPA key file not readable",
		);
	});
});

test("registers x_search only when CPA is configured", () => {
	const names: string[] = [];
	const previous = { base: process.env.PI_X_SEARCH_BASE_URL, claude: process.env.PI_CLAUDE_CODE_BASE_URL };
	try {
		delete process.env.PI_X_SEARCH_BASE_URL;
		delete process.env.PI_CLAUDE_CODE_BASE_URL;
		xSearch({ registerTool: (tool: { name: string }) => names.push(tool.name) } as never);
		expect(names).toEqual([]);
		process.env.PI_X_SEARCH_BASE_URL = "http://cpa:8317";
		xSearch({ registerTool: (tool: { name: string }) => names.push(tool.name) } as never);
		expect(names).toEqual(["x_search"]);
	} finally {
		for (const [name, value] of [
			["PI_X_SEARCH_BASE_URL", previous.base],
			["PI_CLAUDE_CODE_BASE_URL", previous.claude],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});
