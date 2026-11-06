import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { markSetupStep } from "../db/index.ts";
import { onHouseholdFactsEdited } from "../household/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import type { HouseholdFactsView } from "./household-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The Household facts routes, through the app's HTTP interface: the wizard's step 4 and Settings,
// Household.

const APP_URL = "http://nas.local:8080";
const FACTS = { zipCode: "99501", ages: [44, 43, 12, 3], rentOrOwn: "own" };

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-household-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Household facts routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;

  beforeEach(async () => {
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
      test.secrets,
    );
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
  });

  afterEach(() => {
    test.close();
  });

  const put = (body: unknown) => browser.send("PUT", "/api/household", body);
  const setup = async () => (await browser.get("/api/setup")).json();

  it("ends page gating once step 4 saves the facts after steps 1 to 3", async () => {
    await markSetupStep(test.database, "master key", "done");
    expect(await setup()).toEqual({ next: "household facts", wizard: true });
    expect(await (await browser.get("/api/household")).json()).toEqual({ facts: null });

    const res = await put(FACTS);

    expect(res.status).toBe(200);
    const { facts } = (await res.json()) as { facts: HouseholdFactsView };
    expect(facts).toMatchObject({ ...FACTS, state: "AK", timeZone: "America/Anchorage" });
    expect(await setup()).toEqual({ next: null, wizard: false });
    expect(await (await browser.get("/api/household")).json()).toEqual({ facts });
  });

  it("refuses an unknown ZIP code with a message", async () => {
    await markSetupStep(test.database, "master key", "done");

    const res = await put({ ...FACTS, zipCode: "00000" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "The app does not know this ZIP code. Check it and try again.",
    });
    expect(await setup()).toEqual({ next: "household facts", wizard: true });
  });

  it.each([
    ["a 4-digit ZIP code", { ...FACTS, zipCode: "9950" }],
    ["no people", { ...FACTS, ages: [] }],
    ["an age that is not a whole number", { ...FACTS, ages: [44.5] }],
    ["an age over 120", { ...FACTS, ages: [121] }],
    ["neither rent nor own", { ...FACTS, rentOrOwn: "lease" }],
  ])("refuses %s", async (_case, body) => {
    await markSetupStep(test.database, "master key", "done");

    expect((await put(body)).status).toBe(400);
  });

  it("lets a Member edit the facts in Settings at any time, which fires the facts-edited hook", async () => {
    await markSetupStep(test.database, "master key", "done");
    await put(FACTS);
    const edited: string[] = [];
    const stop = onHouseholdFactsEdited(({ facts }) => {
      edited.push(facts.timeZone);
    });
    try {
      const res = await put({ ...FACTS, zipCode: "96813", rentOrOwn: "rent" });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        facts: { zipCode: "96813", rentOrOwn: "rent", timeZone: "Pacific/Honolulu" },
      });
    } finally {
      stop();
    }
    expect(edited).toEqual(["Pacific/Honolulu"]);
  });

  it("stores no facts before the wizard's step 3 is done", async () => {
    expect((await put(FACTS)).status).toBe(409);
  });

  it("gives the Household time zone alone, with no ZIP code, ages or other field", async () => {
    const timeZone = async () => {
      const res = await browser.get("/api/household/time-zone");
      expect(res.status).toBe(200);
      return res.json();
    };
    expect(await timeZone()).toEqual({ timeZone: null });

    await markSetupStep(test.database, "master key", "done");
    expect((await put(FACTS)).status).toBe(200);
    const answer = await timeZone();
    expect(answer).toEqual({ timeZone: "America/Anchorage" });
    const text = JSON.stringify(answer);
    for (const fact of [FACTS.zipCode, "AK", "own", ...FACTS.ages.map(String)]) {
      expect(text).not.toContain(fact);
    }

    // A new ZIP code in another time zone changes it at once.
    expect((await put({ ...FACTS, zipCode: "96813" })).status).toBe(200);
    expect(await timeZone()).toEqual({ timeZone: "Pacific/Honolulu" });
  });

  it("answers no one who is signed out", async () => {
    const stranger = new TestBrowser(app, APP_URL, "192.168.1.21");

    expect((await stranger.get("/api/household")).status).toBe(401);
    expect((await stranger.send("PUT", "/api/household", FACTS)).status).toBe(401);
    const zone = await stranger.get("/api/household/time-zone");
    expect(zone.status).toBe(401);
    expect(await zone.text()).not.toContain("timeZone");
  });
});
