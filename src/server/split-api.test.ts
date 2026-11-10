import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { addConnection, markSetupStep } from "../db/index.ts";
import { followUpAgain, runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { startLineItemCategories } from "../line-items/index.ts";
import { addTestLineItems } from "../line-items/testing.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { createApp } from "./app.ts";
import type { MonthTotalsView, TransactionDetailView } from "./money-movement-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// A Member's split of a Spending Transaction (spec 04, Splits), through the app's HTTP interface,
// on Transactions the fake adapter synced.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";
const SPLIT = {
  parts: [
    { amount: 8_000, category: "Groceries" },
    { amount: 4_000, category: "Clothing" },
  ],
};

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-split-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the split routes", () => {
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
      startLineItemCategories({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);

    const card = fakeAccount({ id: "acc-card", type: "credit", subtype: "credit card" });
    const target = (id: string, amount: number, postedDate: string) =>
      fakeTxn({
        id,
        accountId: card.id,
        amount,
        postedDate,
        description: "TARGET",
        merchantName: "Target",
        category: {
          name: "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE",
          confidence: "HIGH",
          version: "v2",
          mcc: null,
        },
      });
    fake.addPages(BANK, {
      accounts: [card],
      added: [
        target("purchase", -12_000, "2026-10-01"),
        target("refund", 3_000, "2026-10-12"),
        target("gone", -6_000, "2026-09-20"),
      ],
      historyLoaded: true,
    });
    const connectionId = await addConnection(test.database, {
      provider: "fake",
      bankId: BANK,
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
    await syncConnection(connectionId, () => new Date("2026-10-15T15:00:00.000Z"));
    await runFollowUp();
    await test.database.$client.execute(
      "UPDATE transactions SET hidden_reason = 'removed by provider' WHERE provider_transaction_id = 'gone'",
    );
    const rows = await test.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    ids = new Map(rows.rows.map((row) => [String(row.provider_transaction_id), String(row.id)]));
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    test.close();
  });

  const path = (providerId: string) => `/api/transactions/${ids.get(providerId) ?? "none"}/split`;
  const october = async () => {
    const res = await browser.get("/api/totals");
    expect(res.status).toBe(200);
    const { months } = (await res.json()) as { months: MonthTotalsView[] };
    return months.find((totals) => totals.month === "2026-10");
  };
  const handSet = async () =>
    (await test.database.$client.execute("SELECT hand_set FROM transactions ORDER BY id")).rows.map(
      (row) => row.hand_set,
    );

  it("splits a Spending Transaction, which GET /api/totals counts in each part's Category with the Refund in proportion, and removes the split", async () => {
    expect(await october()).toMatchObject({ spending: 9_000, byCategory: { Superstores: 9_000 } });

    const res = await browser.send("PUT", path("purchase"), SPLIT);
    await runFollowUp();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      decision: {
        parts: [
          { type: "Spending", amount: -8_000, category: "Groceries" },
          { type: "Spending", amount: -4_000, category: "Clothing" },
        ],
      },
    });
    expect(await october()).toMatchObject({
      spending: 9_000,
      byCategory: { Groceries: 6_000, Clothing: 3_000 },
    });
    const detail = (await (
      await browser.get(`/api/transactions/${ids.get("purchase")}`)
    ).json()) as TransactionDetailView;
    expect(detail.decision?.parts.map((part) => part.category)).toEqual(["Groceries", "Clothing"]);

    const removed = await browser.send("DELETE", path("purchase"));
    await runFollowUp();
    expect(removed.status).toBe(200);
    expect(await october()).toMatchObject({ spending: 9_000, byCategory: { Superstores: 9_000 } });
    expect((await browser.send("DELETE", path("purchase"))).status).toBe(404);
  });

  it("counts the Refund in proportion in a split from Line items too, which a hand split replaces (spec 14)", async () => {
    const purchase = ids.get("purchase") ?? "";
    await addTestLineItems(test.database, [
      {
        id: "1",
        total: 7_000,
        transactionId: purchase,
        category: "Groceries",
        categorySource: "hand-set",
      },
      {
        id: "2",
        total: 3_500,
        transactionId: purchase,
        category: "Clothing",
        categorySource: "hand-set",
      },
    ]);
    await followUpAgain(test.database, [purchase]);
    await runFollowUp();

    expect(await october()).toMatchObject({
      spending: 9_000,
      byCategory: { Groceries: 6_000, Clothing: 3_000 },
    });
    const detail = (await (
      await browser.get(`/api/transactions/${purchase}`)
    ).json()) as TransactionDetailView;
    expect(detail.decision?.parts.map((part) => [part.amount, part.category])).toEqual([
      [-8_000, "Groceries"],
      [-4_000, "Clothing"],
    ]);

    expect(
      (
        await browser.send("PUT", path("purchase"), {
          parts: [
            { amount: 12_000, category: "Home and garden" },
            { amount: 0, category: "Pets" },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await browser.send("PUT", path("purchase"), {
          parts: [
            { amount: 6_000, category: "Home and garden" },
            { amount: 6_000, category: "Pets" },
          ],
        })
      ).status,
    ).toBe(200);
    await runFollowUp();
    expect(await october()).toMatchObject({
      spending: 9_000,
      byCategory: { "Home and garden": 4_500, Pets: 4_500 },
    });
  });

  it("refuses parts that do not add up, a body that is not a split, money in, and a hidden or unknown Transaction, and changes nothing", async () => {
    const before = await handSet();

    for (const body of [
      { parts: [{ amount: 12_000, category: "Groceries" }] },
      { parts: [SPLIT.parts[0], { amount: 4_000, category: "Snacks" }] },
      { parts: [SPLIT.parts[0], { amount: -4_000, category: "Clothing" }] },
      { parts: [SPLIT.parts[0], { amount: 40.5, category: "Clothing" }] },
      {},
    ]) {
      expect((await browser.send("PUT", path("purchase"), body)).status).toBe(400);
    }
    const wrongTotal = await browser.send("PUT", path("purchase"), {
      parts: [SPLIT.parts[0], { amount: 3_000, category: "Clothing" }],
    });
    expect(wrongTotal.status).toBe(400);
    expect(await wrongTotal.json()).toEqual({
      error: "The parts must add up to the Transaction's amount.",
    });
    expect((await browser.send("PUT", path("refund"), SPLIT)).status).toBe(409);
    expect((await browser.send("PUT", path("gone"), SPLIT)).status).toBe(404);
    expect((await browser.send("PUT", path("none"), SPLIT)).status).toBe(404);

    expect(await handSet()).toEqual(before);
    expect(await october()).toMatchObject({ byCategory: { Superstores: 9_000 } });
  });

  it("answers 401 with no session, 403 from another site or with no Origin, and 415 to a body that is not JSON, and changes nothing", async () => {
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
    const before = await handSet();

    expect((await signedOut.send("PUT", path("purchase"), SPLIT)).status).toBe(401);
    expect((await signedOut.send("DELETE", path("purchase"))).status).toBe(401);
    for (const origin of ["http://evil.example", undefined]) {
      const put = await browser.send("PUT", path("purchase"), SPLIT, { origin });
      expect(put.status, `origin ${origin}`).toBe(403);
    }
    const text = await browser.send("PUT", path("purchase"), SPLIT, {
      "content-type": "text/plain",
    });
    expect(text.status).toBe(415);
    expect(await handSet()).toEqual(before);

    // A split to remove, which no request from another site or with no session removes.
    expect((await browser.send("PUT", path("purchase"), SPLIT)).status).toBe(200);
    const split = await handSet();
    expect((await signedOut.send("DELETE", path("purchase"))).status).toBe(401);
    for (const origin of ["http://evil.example", undefined]) {
      expect((await browser.send("DELETE", path("purchase"), undefined, { origin })).status).toBe(
        403,
      );
    }
    expect(await handSet()).toEqual(split);
  });
});
