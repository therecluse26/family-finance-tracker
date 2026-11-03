import { describe, expect, it } from "vitest";
import { codeFromHash, openWizardIfNeeded, type SetupState } from "./setup-gate.ts";

// Page gating in the web app: until steps 1 to 4 are done, every page leads to the wizard.

const BEFORE_FIRST_MEMBER: SetupState = { next: "setup link", wizard: true };
const AT_MASTER_KEY: SetupState = { next: "master key", wizard: true };
const DONE: SetupState = { next: null, wizard: false };

async function opened(state: SetupState, page: "app" | "sign-in"): Promise<string[]> {
  const went: string[] = [];
  const result = await openWizardIfNeeded(
    (path) => went.push(path),
    page,
    async () => state,
  );
  expect(result).toBe(went.length > 0);
  return went;
}

describe("page gating", () => {
  it("leads every app page to the wizard until steps 1 to 4 are done", async () => {
    expect(await opened(BEFORE_FIRST_MEMBER, "app")).toEqual(["/setup"]);
    expect(await opened(AT_MASTER_KEY, "app")).toEqual(["/setup"]);
    expect(await opened(DONE, "app")).toEqual([]);
  });

  it("leads the sign-in page to the wizard only before the first Member exists", async () => {
    expect(await opened(BEFORE_FIRST_MEMBER, "sign-in")).toEqual(["/setup"]);
    // The first Member signs in to finish steps 3 and 4.
    expect(await opened(AT_MASTER_KEY, "sign-in")).toEqual([]);
    expect(await opened(DONE, "sign-in")).toEqual([]);
  });
});

describe("the setup link", () => {
  it("gives its code from the part after #", () => {
    expect(codeFromHash("#code=7KQ2-M9XD-4TRF")).toBe("7KQ2-M9XD-4TRF");
    expect(codeFromHash("code=7kq2m9xd4trf")).toBe("7kq2m9xd4trf");
    expect(codeFromHash("")).toBeUndefined();
    expect(codeFromHash("#code=")).toBeUndefined();
    expect(codeFromHash("#other=1")).toBeUndefined();
  });
});
