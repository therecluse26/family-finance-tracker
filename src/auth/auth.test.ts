import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "./testing.ts";

// auth.handle on its own, without the security check in front of it. The security check's header
// allow list drops a client's x-fft-client-address; this checks the second guard behind it.

const APP_ORIGIN = "http://nas.local:8080";
const CLIENT = "192.0.2.10";
const SPOOFED = "203.0.113.99";

describe("auth.handle", () => {
  let test: TestAuth;
  let alice: TestMember;

  beforeEach(async () => {
    test = await newTestAuth(APP_ORIGIN);
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
  });

  afterEach(() => {
    test.close();
  });

  const post = (path: string, body: unknown, cookie = "") =>
    test.auth.handle(
      new Request(`${APP_ORIGIN}/api/auth${path}`, {
        method: "POST",
        headers: {
          origin: APP_ORIGIN,
          "content-type": "application/json",
          "x-fft-client-address": SPOOFED,
          ...(cookie === "" ? {} : { cookie }),
        },
        body: JSON.stringify(body),
      }),
      CLIENT,
    );

  const cookiesOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");

  const rows = async (sql: string) => (await test.database.$client.execute(sql)).rows;

  it("counts a failed sign-in under the client address it is given, not one the client sent", async () => {
    const res = await post("/sign-in/email", { email: alice.email, password: "a wrong password" });

    expect(res.status).toBe(401);
    const keys = (await rows("SELECT key FROM sign_in_tries")).map((row) => row.key);
    expect(keys).toContain(`ip:${CLIENT}`);
    expect(keys).not.toContain(`ip:${SPOOFED}`);
  });

  it("records the session under the client address it is given, not one the client sent", async () => {
    const waiting = await post("/sign-in/email", { email: alice.email, password: alice.password });
    const done = await post(
      "/two-factor/verify-totp",
      { code: await alice.totpCode() },
      cookiesOf(waiting),
    );

    expect(done.status).toBe(200);
    expect((await rows("SELECT ip_address FROM sessions")).map((row) => row.ip_address)).toEqual([
      CLIENT,
    ]);
  });
});
