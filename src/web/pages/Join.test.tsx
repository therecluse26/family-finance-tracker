import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptInvite, checkInvite, newInviteTotp, tokenFromHash } from "./Join.tsx";

// The join page: the token from the link's part after "#", and the exact requests the page sends.
// src/server/members-api.test.ts sends these same requests.

describe("the join page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the token from the part after #", () => {
    expect(tokenFromHash("#token=abc_DEF-123")).toBe("abc_DEF-123");
    expect(tokenFromHash("token=abc")).toBe("abc");
    expect(tokenFromHash("#code=abc")).toBeUndefined();
    expect(tokenFromHash("#token=")).toBeUndefined();
    expect(tokenFromHash("")).toBeUndefined();
  });

  it("sends the token only in JSON bodies, to the join routes", async () => {
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

    await checkInvite("t0k3n");
    await newInviteTotp("t0k3n", "bob@example.com");
    await acceptInvite({
      token: "t0k3n",
      name: "Bob",
      email: "bob@example.com",
      password: "a long password",
      totpCode: "123456",
    });

    const json = "application/json";
    expect(requests).toEqual([
      { method: "POST", path: "/api/auth/invite/check", type: json, body: '{"token":"t0k3n"}' },
      {
        method: "POST",
        path: "/api/auth/invite/new-totp",
        type: json,
        body: '{"token":"t0k3n","email":"bob@example.com"}',
      },
      {
        method: "POST",
        path: "/api/auth/invite/accept",
        type: json,
        body: '{"token":"t0k3n","name":"Bob","email":"bob@example.com","password":"a long password","totpCode":"123456"}',
      },
    ]);
  });
});
