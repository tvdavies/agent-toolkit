import { describe, expect, it } from "vitest";
import { decodeJwtPayload, extractCodexAccountId } from "../src/auth/oauth/jwt.ts";

function makeJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesignature`;
}

describe("decodeJwtPayload", () => {
  it("decodes a valid 3-segment JWT", () => {
    const jwt = makeJwt({
      sub: "user-123",
      "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" },
    });
    expect(decodeJwtPayload(jwt)).toEqual({
      sub: "user-123",
      "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" },
    });
  });

  it("rejects 2-segment strings", () => {
    expect(() => decodeJwtPayload("a.b")).toThrow(/3 dot-separated segments/);
  });

  it("rejects empty payload segment", () => {
    expect(() => decodeJwtPayload("a..c")).toThrow(/empty/);
  });

  it("rejects non-JSON payload", () => {
    const bad = `aaa.${Buffer.from("not json").toString("base64url")}.zzz`;
    expect(() => decodeJwtPayload(bad)).toThrow(/not valid JSON/);
  });
});

describe("extractCodexAccountId", () => {
  it("pulls chatgpt_account_id from the OpenAI auth claim", () => {
    const jwt = makeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acc-abcdef",
        chatgpt_user_id: "user-xyz",
      },
    });
    expect(extractCodexAccountId(jwt)).toBe("acc-abcdef");
  });

  it("errors clearly when the OpenAI claim is missing", () => {
    const jwt = makeJwt({ sub: "user-1" });
    expect(() => extractCodexAccountId(jwt)).toThrow(
      /missing the "https:\/\/api\.openai\.com\/auth" claim/,
    );
  });

  it("errors clearly when chatgpt_account_id is missing", () => {
    const jwt = makeJwt({ "https://api.openai.com/auth": { chatgpt_user_id: "u" } });
    expect(() => extractCodexAccountId(jwt)).toThrow(/chatgpt_account_id/);
  });

  it("errors clearly when chatgpt_account_id is empty", () => {
    const jwt = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "" } });
    expect(() => extractCodexAccountId(jwt)).toThrow(/chatgpt_account_id/);
  });
});
