import { describe, expect, it } from "vitest";
import { refusalText } from "./requests.ts";

const refused = (status: number, body: unknown) => Response.json(body, { status });

describe("refusalText", () => {
  const notVerified = "The passkey did not check that it was you.";

  it("shows the words for a wrong password or code on a 401 with no code it names", async () => {
    const res = refused(401, {
      code: "INVALID_PASSWORD",
      message: "Your current password is wrong.",
    });

    expect(await refusalText(res, "Wrong.", { MEMBER_NOT_VERIFIED: notVerified })).toBe("Wrong.");
  });

  it("shows the words it gives for the server's code, apart from a wrong password", async () => {
    const res = refused(401, { code: "MEMBER_NOT_VERIFIED", message: "From the server." });

    expect(await refusalText(res, "Wrong.", { MEMBER_NOT_VERIFIED: notVerified })).toBe(
      notVerified,
    );
  });

  it("never takes a code from the object's own prototype", async () => {
    const res = refused(401, { code: "toString" });

    expect(await refusalText(res, "Wrong.", {})).toBe("Wrong.");
  });

  it("shows the server's message for too many tries or a bad input, and plain words otherwise", async () => {
    expect(await refusalText(refused(429, { message: "Wait 15 minutes." }), "Wrong.")).toBe(
      "Wait 15 minutes.",
    );
    expect(await refusalText(refused(400, { message: "Too short." }), "Wrong.")).toBe("Too short.");
    expect(await refusalText(refused(500, { message: "Inside." }), "Wrong.")).toBe(
      "That did not work.",
    );
  });
});
