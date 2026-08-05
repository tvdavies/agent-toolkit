import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getIssue } from "../../extensions/worktrees.ts";

type ExecResponse = {
  code: number;
  stdout: string;
  stderr: string;
};

function fakePi(responses: ExecResponse[]) {
  const calls: string[][] = [];
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected exec call");
      return response;
    },
  } as unknown as ExtensionAPI;
  return { pi, calls };
}

const failedLookup: ExecResponse = {
  code: 1,
  stdout: "",
  stderr: "Entity not found: Issue",
};

describe("getIssue", () => {
  it("normalises the identifier and retries an uncached direct lookup", async () => {
    const { pi, calls } = fakePi([
      {
        code: 0,
        stdout: JSON.stringify({
          id: "issue-id",
          identifier: "LLE-11970",
          title: "Agent errors for Allnex user",
        }),
        stderr: "",
      },
    ]);

    const issue = await getIssue(pi, " lle-11970 ");

    expect(issue.identifier).toBe("LLE-11970");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "get",
        "--retry",
        "3",
        "--no-cache",
        "--",
        "LLE-11970",
      ]),
    );
  });

  it("rejects flag-like input before invoking the CLI", async () => {
    const { pi, calls } = fakePi([]);

    await expect(getIssue(pi, "--schema")).rejects.toThrow(
      "Invalid Linear issue identifier",
    );
    expect(calls).toHaveLength(0);
  });

  it("falls back to an exact team-key and issue-number query", async () => {
    const { pi, calls } = fakePi([
      failedLookup,
      {
        code: 0,
        stdout: JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: "issue-id",
                  identifier: "LLE-11970",
                  title: "Agent errors for Allnex user",
                },
              ],
            },
          },
        }),
        stderr: "",
      },
    ]);

    const issue = await getIssue(pi, "LLE-11970");

    expect(issue.identifier).toBe("LLE-11970");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.slice(0, 2)).toEqual(["api", "query"]);
    expect(calls[1]).toEqual(
      expect.arrayContaining([
        "--variable",
        "number=11970",
        "--variable",
        "teamKey=LLE",
        "--retry",
        "3",
        "--no-cache",
      ]),
    );
  });

  it("falls back when a successful direct lookup returns malformed JSON", async () => {
    const { pi } = fakePi([
      { code: 0, stdout: "not-json", stderr: "" },
      {
        code: 0,
        stdout: JSON.stringify({
          data: {
            issues: {
              nodes: [{ id: "issue-id", identifier: "LLE-11970" }],
            },
          },
        }),
        stderr: "",
      },
    ]);

    await expect(getIssue(pi, "LLE-11970")).resolves.toMatchObject({
      id: "issue-id",
      identifier: "LLE-11970",
    });
  });

  it("rejects a fallback result for a different identifier", async () => {
    const { pi } = fakePi([
      failedLookup,
      {
        code: 0,
        stdout: JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: "different-issue-id",
                  identifier: "LLE-11971",
                  title: "Different issue",
                },
              ],
            },
          },
        }),
        stderr: "",
      },
    ]);

    await expect(getIssue(pi, "LLE-11970")).rejects.toThrow(
      "Exact identifier fallback also failed",
    );
  });

  it("includes malformed fallback output in the consolidated error", async () => {
    const { pi } = fakePi([
      failedLookup,
      { code: 0, stdout: "not-json", stderr: "" },
    ]);

    await expect(getIssue(pi, "LLE-11970")).rejects.toThrow(
      "Could not parse fallback output",
    );
  });
});
