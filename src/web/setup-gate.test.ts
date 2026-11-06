import { describe, expect, it } from "vitest";
import type { SetupProgressView } from "../server/setup-views.ts";
import {
  codeFromHash,
  forgetSetupCode,
  openWizardIfNeeded,
  resumeWizardIfNeeded,
  type SetupState,
  savedSetupCode,
  saveSetupCode,
  setupCodeRefused,
  skippedWizardSteps,
} from "./setup-gate.ts";

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

describe("the wizard's steps 5 and 6", () => {
  const progress = (next: SetupProgressView["next"]): SetupProgressView => ({
    next,
    steps: { banks: "skipped", ai: null, alerts: null, "invite members": null },
    finishSetup: ["banks"],
    connections: 0,
  });

  async function resumed(read: SetupProgressView | undefined): Promise<string[]> {
    const went: string[] = [];
    const result = await resumeWizardIfNeeded(
      (path) => went.push(path),
      async () => read,
    );
    expect(result).toBe(went.length > 0);
    return went;
  }

  it("opens the wizard's next step for the first Member on the next visit", async () => {
    expect(await resumed(progress("banks"))).toEqual(["/setup"]);
    expect(await resumed(progress("finish"))).toEqual(["/setup"]);
  });

  it("leaves the page open once the wizard has nothing more, and for any other Member", async () => {
    // The server answers next: null to a Member other than the first.
    expect(await resumed(progress(null))).toEqual([]);
    expect(await resumed(undefined)).toEqual([]);
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

// A tab's sessionStorage, as the browser gives it.
class TabStorage {
  readonly items = new Map<string, string>();
  getItem = (key: string) => this.items.get(key) ?? null;
  setItem = (key: string, value: string) => void this.items.set(key, value);
  removeItem = (key: string) => void this.items.delete(key);
}

describe("the setup code across a reload", () => {
  it("keeps the code exactly as the server took it, until it is forgotten", () => {
    const storage = new TabStorage();
    expect(savedSetupCode(storage)).toBeUndefined();

    for (const code of ["7KQ2-M9XD-4TRF", " 7kq2m9xd4trf", "7KQ2%2dM9XD;{4TRF\t"]) {
      saveSetupCode(code, storage);
      expect(savedSetupCode(storage)).toBe(code);
    }
    forgetSetupCode(storage);
    expect(savedSetupCode(storage)).toBeUndefined();
    expect(storage.items.size).toBe(0);
  });

  it("keeps no code the server would refuse for its length", () => {
    const storage = new TabStorage();
    saveSetupCode("", storage);
    saveSetupCode("A".repeat(65), storage);
    expect(storage.items.size).toBe(0);

    // A value written to the tab by other means is not used either.
    storage.items.set("fft-setup-code", "A".repeat(65));
    expect(savedSetupCode(storage)).toBeUndefined();
  });

  it("does without storage where the browser blocks it", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => saveSetupCode("7KQ2-M9XD-4TRF", blocked)).not.toThrow();
    expect(savedSetupCode(blocked)).toBeUndefined();
    expect(() => forgetSetupCode(blocked)).not.toThrow();
    expect(savedSetupCode(undefined)).toBeUndefined();
  });
});

describe("which refusals forget the kept setup code", () => {
  it("forgets it on a wrong code, a code with the wrong form, or a Member already made", () => {
    for (const status of [400, 401, 403]) expect(setupCodeRefused(status)).toBe(true);
  });

  it("keeps it after too many wrong codes and after a server error", () => {
    for (const status of [429, 500, 502, 503, 504]) expect(setupCodeRefused(status)).toBe(false);
  });
});

describe("the skipped wizard steps", () => {
  const progress = (banks: SetupProgressView["steps"]["banks"]): SetupProgressView => ({
    next: "finish",
    steps: { banks, ai: null, alerts: null, "invite members": null },
    finishSetup: [],
    connections: 0,
  });

  it("names Banks only while the server records it as skipped", () => {
    expect(skippedWizardSteps(progress("skipped"))).toEqual(["banks"]);
    expect(skippedWizardSteps(progress("done"))).toEqual([]);
    expect(skippedWizardSteps(progress(null))).toEqual([]);
    expect(skippedWizardSteps(undefined)).toEqual([]);
  });
});
