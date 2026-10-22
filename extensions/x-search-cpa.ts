import { readFile } from "node:fs/promises";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

/**
 * X (Twitter) search through CLI Proxy API (CPA), using the xAI account CPA holds.
 *
 * pi-xai's own `xai_x_search` needs an xAI login or XAI_API_KEY in the session. This
 * tool instead posts a Grok Responses request with the `x_search` built-in tool to
 * CPA's /v1/responses, reading the CPA key from a file on each call, so the key is
 * never copied anywhere new.
 *
 * Configuration (environment):
 * - PI_X_SEARCH_BASE_URL: CPA base URL, with or without /v1. Falls back to
 *   PI_CLAUDE_CODE_BASE_URL, which already points at CPA where Claude is routed
 *   through it. The tool is not registered when neither is set.
 * - PI_X_SEARCH_API_KEY_FILE: file holding the CPA key (default
 *   ~/.cli-proxy-api/proxy.key, CPA's own client key on its host).
 * - PI_X_SEARCH_MODEL: Grok model (default grok-4.6).
 */

type Env = Record<string, string | undefined>;

export const DEFAULT_X_SEARCH_MODEL = "grok-4.6";
const DEFAULT_KEY_FILE = "~/.cli-proxy-api/proxy.key";
const REQUEST_TIMEOUT_MS = 180_000;

export type XSearchConfig = {
	baseUrl: string;
	keyFile: string;
	model: string;
};

function expandHome(path: string): string {
	return path.replace(/^~(?=\/|$)/, os.homedir());
}

function firstSet(...values: Array<string | undefined>): string | undefined {
	return values.map((value) => value?.trim()).find((value) => value);
}

export function resolveXSearchConfig(env: Env = process.env): XSearchConfig | null {
	const baseUrl = firstSet(env.PI_X_SEARCH_BASE_URL, env.PI_CLAUDE_CODE_BASE_URL);
	if (!baseUrl) return null;
	const keyFile = firstSet(env.PI_X_SEARCH_API_KEY_FILE) ?? DEFAULT_KEY_FILE;
	return {
		baseUrl,
		keyFile: expandHome(keyFile),
		model: firstSet(env.PI_X_SEARCH_MODEL) ?? DEFAULT_X_SEARCH_MODEL,
	};
}

export function responsesUrl(baseUrl: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	return base.endsWith("/v1") ? `${base}/responses` : `${base}/v1/responses`;
}

const xSearchSchema = Type.Object({
	query: Type.String({ description: "What to look for on X, in plain language" }),
	from_date: Type.Optional(Type.String({ description: "Only posts on or after this date (YYYY-MM-DD, UTC)" })),
	to_date: Type.Optional(Type.String({ description: "Only posts on or before this date (YYYY-MM-DD, UTC)" })),
	allowed_x_handles: Type.Optional(
		Type.Array(Type.String(), { description: "Only search posts from these handles (without @, at most 10)" }),
	),
	excluded_x_handles: Type.Optional(
		Type.Array(Type.String(), { description: "Skip posts from these handles (without @, at most 10)" }),
	),
});

export type XSearchInput = Static<typeof xSearchSchema>;

function cleanHandles(handles: string[] | undefined): string[] {
	return (handles ?? []).map((handle) => handle.trim().replace(/^@/, "")).filter(Boolean);
}

export function buildXSearchRequest(params: XSearchInput, model: string, now: Date = new Date()) {
	const today = now.toISOString().slice(0, 10);
	const tool: Record<string, unknown> = { type: "x_search" };
	if (params.from_date?.trim()) tool.from_date = params.from_date.trim();
	if (params.to_date?.trim()) tool.to_date = params.to_date.trim();
	const allowed = cleanHandles(params.allowed_x_handles);
	const excluded = cleanHandles(params.excluded_x_handles);
	if (allowed.length) tool.allowed_x_handles = allowed;
	if (excluded.length) tool.excluded_x_handles = excluded;

	return {
		model,
		// Grok otherwise treats recent dates as "in the future".
		instructions: `Today is ${today} (UTC). Search X and answer from the posts you find. Give each post's URL, author and date. Say so plainly if you find nothing relevant.`,
		input: params.query.trim(),
		tools: [tool],
		store: false,
	};
}

type ResponsesResult = {
	output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; annotations?: Array<{ url?: string }> }> }>;
	citations?: string[];
	usage?: { server_side_tool_usage_details?: { x_search_calls?: number; x_posts_fetched?: number } };
};

export function formatXSearchResult(result: ResponsesResult): string {
	const texts: string[] = [];
	const sources = new Set<string>(result.citations ?? []);
	for (const item of result.output ?? []) {
		if (item.type !== "message") continue;
		for (const part of item.content ?? []) {
			if (part.type === "output_text" && part.text) texts.push(part.text);
			for (const annotation of part.annotations ?? []) if (annotation.url) sources.add(annotation.url);
		}
	}
	const text = texts.join("\n").trim() || "(X search returned no text)";
	if (!sources.size) return text;
	const list = [...sources].map((url, index) => `${index + 1}. ${url}`).join("\n");
	return `${text}\n\nSources consulted:\n${list}`;
}

export async function runXSearch(
	params: XSearchInput,
	config: XSearchConfig,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	let key: string;
	try {
		key = (await readFile(config.keyFile, "utf8")).trim();
	} catch {
		throw new Error(`x_search: CPA key file not readable: ${config.keyFile}`);
	}
	if (!key) throw new Error(`x_search: CPA key file is empty: ${config.keyFile}`);

	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetchImpl(responsesUrl(config.baseUrl), {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify(buildXSearchRequest(params, config.model)),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) {
		const body = (await response.text()).slice(0, 500);
		throw new Error(`x_search: CPA returned HTTP ${response.status}: ${body}`);
	}
	return formatXSearchResult((await response.json()) as ResponsesResult);
}

export default function (pi: ExtensionAPI) {
	const config = resolveXSearchConfig();
	if (!config) return;

	pi.registerTool({
		name: "x_search",
		label: "X search (CPA)",
		description:
			"Search recent posts on X (Twitter) with Grok's live x_search, through CLI Proxy API and the xAI account it holds. Returns Grok's answer with post URLs.",
		promptSnippet: "Search recent posts on X (Twitter)",
		promptGuidelines: [
			"Use x_search for what people are posting on X, such as newly exploited vulnerabilities or reactions to a release; use web search for everything else.",
			"Give x_search a from_date/to_date window for anything time-sensitive, and treat its answer as leads to verify against primary sources.",
		],
		parameters: xSearchSchema,

		async execute(_toolCallId, params, signal) {
			const text = await runXSearch(params, config, signal);
			return { content: [{ type: "text", text }], details: { model: config.model } };
		},
	});
}
