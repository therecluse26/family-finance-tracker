import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { markSetupStep } from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import type { UnconnectedAccountView } from "./bank-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The Unconnected account routes, through the app's HTTP interface: Settings, Banks.

const APP_URL = "http://nas.local:8080";
const SAVINGS = {
  name: "Credit union savings",
  kind: "savings",
  institutionName: "Credit union",
  mask: "1234",
  balance: 1_250_000,
};

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-unconnected-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Unconnected account routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let memberId: string;

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
    memberId = member.id;
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
    await markSetupStep(test.database, "master key", "done");
    await saveHouseholdFacts(
      test.database,
      { zipCode: "96813", ages: [40], rentOrOwn: "rent" },
      memberId,
    );
  });

  afterEach(() => {
    test.close();
  });

  const add = (body: unknown) => browser.send("POST", "/api/unconnected-accounts", body);
  const edit = (id: string, body: unknown) =>
    browser.send("PUT", `/api/unconnected-accounts/${id}`, body);
  const accountOf = async (res: Response) =>
    ((await res.json()) as { account: UnconnectedAccountView }).account;

  it("adds an account with a balance saved with the Household's date, and lists it", async () => {
    const res = await add(SAVINGS);

    expect(res.status).toBe(200);
    const account = await accountOf(res);
    const today = calendarDateIn(new Date(), "Pacific/Honolulu");
    expect(account).toEqual({
      id: account.id,
      name: "Credit union savings",
      kind: "savings",
      institutionName: "Credit union",
      mask: "1234",
      closed: false,
      estimate: { balance: 1_250_000, state: "typed", typedOn: today },
    });
    const list = await (await browser.get("/api/unconnected-accounts")).json();
    expect(list).toEqual({ accounts: [account] });
    const accounts = (await (await browser.get("/api/accounts")).json()) as {
      accounts: { id: string; currentBalance: number | null }[];
    };
    expect(accounts.accounts.find((each) => each.id === account.id)?.currentBalance).toBe(
      1_250_000,
    );
  });

  it("adds an account with only a name and a kind, which shows estimated from $0", async () => {
    const account = await accountOf(await add({ name: "Kids' HSA", kind: "HSA" }));

    expect(account).toMatchObject({
      institutionName: null,
      mask: null,
      estimate: { balance: 0, state: "estimated", typedOn: null },
    });
  });

  it("edits the fields and types a true balance, or keeps the balance when none is typed", async () => {
    const { id } = await accountOf(await add(SAVINGS));

    const renamed = await accountOf(
      await edit(id, { ...SAVINGS, name: "Brokerage", kind: "other", balance: null, mask: "" }),
    );
    expect(renamed).toMatchObject({
      name: "Brokerage",
      kind: "other",
      mask: null,
      estimate: { balance: 1_250_000, state: "typed" },
    });

    const typed = await accountOf(await edit(id, { ...SAVINGS, balance: 990_000 }));
    expect(typed.estimate.balance).toBe(990_000);
  });

  it("refuses a missing name, an unknown kind, a bad last 4 digits, and a balance in dollars", async () => {
    for (const body of [
      { ...SAVINGS, name: " " },
      { ...SAVINGS, kind: "loan" },
      { ...SAVINGS, kind: "payment app" },
      { ...SAVINGS, mask: "12345" },
      { ...SAVINGS, mask: "12a4" },
      { ...SAVINGS, balance: 12.5 },
      { ...SAVINGS, balance: "12" },
    ]) {
      const res = await add(body);
      expect(res.status).toBe(400);
    }
    expect(await (await browser.get("/api/unconnected-accounts")).json()).toEqual({
      accounts: [],
    });
  });

  it("answers Not found for an ID that is not an Unconnected account", async () => {
    const res = await edit("no-such-id", SAVINGS);

    expect(res.status).toBe(404);
  });

  it("refuses a request with no session", async () => {
    const stranger = new TestBrowser(app, APP_URL, "192.168.1.21");

    expect((await stranger.send("POST", "/api/unconnected-accounts", SAVINGS)).status).toBe(401);
    expect((await stranger.get("/api/unconnected-accounts")).status).toBe(401);
  });
});
