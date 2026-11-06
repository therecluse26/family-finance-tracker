import { afterEach, describe, expect, it, vi } from "vitest";
import { checkLoginReset, finishLoginReset, newLoginResetTotp } from "./Reset.tsx";

// The reset page: the exact requests it sends. src/server/login-reset-api.test.ts sends these same
// requests.

describe("the reset page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the token only in JSON bodies, to the reset routes", async () => {
    const requests: { method: string; path: string; type: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({
        method: init.method ?? "GET",
        path: String(input),
        type: new Headers(init.headers).get("content-type"),
        body: init.body,
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });

    await checkLoginReset("t0k3n");
    await newLoginResetTotp("t0k3n");
    await finishLoginReset({ token: "t0k3n", password: "a long password", totpCode: "123456" });

    const json = "application/json";
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/api/auth/login-reset/check",
        type: json,
        body: '{"token":"t0k3n"}',
      },
      {
        method: "POST",
        path: "/api/auth/login-reset/new-totp",
        type: json,
        body: '{"token":"t0k3n"}',
      },
      {
        method: "POST",
        path: "/api/auth/login-reset/finish",
        type: json,
        body: '{"token":"t0k3n","password":"a long password","totpCode":"123456"}',
      },
    ]);
  });
});
