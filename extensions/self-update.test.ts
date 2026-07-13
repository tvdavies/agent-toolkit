import { describe, expect, test } from "bun:test";
import selfUpdateExtension, { hasSelfUpdateCapability } from "./self-update.ts";

function extensionHarness(): { pi: any; tools: Array<{ name: string }> } {
	const tools: Array<{ name: string }> = [];
	return {
		pi: {
			registerTool(tool: { name: string }) {
				tools.push(tool);
			},
		},
		tools,
	};
}

describe("self-update extension capability gate", () => {
	test("does not expose apply_update in a normal interactive harness", () => {
		const { pi, tools } = extensionHarness();
		selfUpdateExtension(pi, {});
		expect(tools).toEqual([]);
	});

	test("registers apply_update for the daemon resident", () => {
		const { pi, tools } = extensionHarness();
		selfUpdateExtension(pi, { AGENT_TOOLKIT_SELF_UPDATE_TOKEN: "daemon-capability" });
		expect(tools.map((tool) => tool.name)).toEqual(["apply_update"]);
	});

	test("requires a non-empty daemon capability", () => {
		expect(hasSelfUpdateCapability({})).toBe(false);
		expect(hasSelfUpdateCapability({ AGENT_TOOLKIT_SELF_UPDATE_TOKEN: "" })).toBe(false);
		expect(hasSelfUpdateCapability({ AGENT_TOOLKIT_SELF_UPDATE_TOKEN: "token" })).toBe(true);
	});
});
