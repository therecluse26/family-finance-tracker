import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { addConnection, markSetupStep } from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { createApp } from "./app.ts";
import type { CategoryCorrectionView, CategoryRuleView } from "./category-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// A Member's Category for a Transaction, and Settings → Categories, through the app's HTTP
// interface, on Transactions the fake adapter synced.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-category-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Category routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let stops: (() => void)[];
  let ids: Map<string, string>;

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
    const fake = new FakeBankAdapter();
    stops = [
      startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop,
      // The follow-up job runs at once.
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startMoneyMovement({ database: test.database }).stop,
      startCategorization({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);

    const card = fakeAccount({ id: "acc-card", type: "credit", subtype: "credit card" });
    const bistro = (id: string, postedDate: string) =>
      fakeTxn({
        id,
        accountId: card.id,
        amount: -2_500,
        postedDate,
        merchantName: "Corner Bistro",
      });
    fake.addPages(BANK, {
      accounts: [card],
      added: [bistro("first", "2026-10-01"), bistro("second", "2026-10-02")],
      historyLoaded: true,
    });
    const connectionId = await addConnection(test.database, {
      provider: "fake",
      bankId: BANK,
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
    await syncConnection(connectionId, () => new Date("2026-10-05T15:00:00.000Z"));
    await runFollowUp();
    const rows = await test.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    ids = new Map(rows.rows.map((row) => [String(row.provider_transaction_id), String(row.id)]));
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    test.close();
  });

  const setCategory = (providerId: string, body: unknown) =>
    browser.send("PUT", `/api/transactions/${ids.get(providerId) ?? "none"}/category`, body);
  const listRules = async () =>
    ((await (await browser.get("/api/category-rules")).json()) as { rules: CategoryRuleView[] })
      .rules;

  it("sets the Category by hand and makes a rule, which Settings lists with Delete", async () => {
    const res = await setCategory("first", { category: "Hobbies" });

    expect(res.status).toBe(200);
    const corrected = (await res.json()) as CategoryCorrectionView;
    expect(corrected).toMatchObject({
      category: "Hobbies",
      rule: { merchantName: "Corner Bistro", category: "Hobbies" },
      setSpending: false,
    });
    const rules = await listRules();
    expect(rules).toEqual([corrected.rule]);

    const deleted = await browser.send("DELETE", `/api/category-rules/${rules[0]?.id}`);
    expect(deleted.status).toBe(200);
    expect(await listRules()).toEqual([]);
    expect((await browser.send("DELETE", `/api/category-rules/${rules[0]?.id}`)).status).toBe(404);
  });

  it("makes no rule for only this Transaction", async () => {
    const res = await setCategory("second", { category: "Pets", onlyThisTransaction: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ category: "Pets", rule: null });
    expect(await listRules()).toEqual([]);
  });

  it("refuses a name that is not a Category, and an unknown Transaction", async () => {
    for (const body of [
      { category: "Snacks" },
      { category: "Pets", onlyThisTransaction: "yes" },
      {},
    ]) {
      expect((await setCategory("first", body)).status).toBe(400);
    }
    expect((await setCategory("none", { category: "Pets" })).status).toBe(404);
    expect(await listRules()).toEqual([]);
  });

  it("answers 415 to a Category that is not sent as JSON, and changes nothing", async () => {
    const res = await browser.send(
      "PUT",
      `/api/transactions/${ids.get("first")}/category`,
      { category: "Hobbies" },
      { "content-type": "text/plain" },
    );

    expect(res.status).toBe(415);
    expect(await listRules()).toEqual([]);
  });

  it("answers 401 with no session and 403 from another site, and changes nothing", async () => {
    await setCategory("first", { category: "Hobbies" });
    const [rule] = await listRules();
    const correct = `/api/transactions/${ids.get("second")}/category`;
    const remove = `/api/category-rules/${rule?.id}`;
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");

    expect((await signedOut.send("PUT", correct, { category: "Pets" })).status).toBe(401);
    expect((await signedOut.send("DELETE", remove)).status).toBe(401);
    for (const origin of ["http://evil.example", undefined]) {
      const put = await browser.send("PUT", correct, { category: "Pets" }, { origin });
      expect(put.status, `origin ${origin}`).toBe(403);
      expect((await browser.send("DELETE", remove, undefined, { origin })).status).toBe(403);
    }

    await runFollowUp();
    expect(await listRules()).toEqual([rule]);
    const second = await test.database.$client.execute({
      sql: "SELECT category FROM transaction_parts WHERE transaction_id = ?",
      args: [ids.get("second") ?? ""],
    });
    expect(second.rows.map((row) => row.category)).toEqual(["Hobbies"]);
  });
});
