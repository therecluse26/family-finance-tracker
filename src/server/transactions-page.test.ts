import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth } from "../auth/testing.ts";
import { seedDemoHousehold } from "../bank/demo.ts";
import { FakeBankAdapter } from "../bank/fake.ts";
import { startBank } from "../bank/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { markSetupStep } from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { transactionRequests } from "../web/transactions.ts";
import { createApp } from "./app.ts";
import type { TransactionListView } from "./bank-views.ts";
import type { TransactionDetailView } from "./money-movement-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { TestBrowser } from "./testing.ts";

// End to end on the demo household (spec 07, Transactions page): the page's own requests, sent
// through the app's HTTP interface, change a Merchant's Category, and the Category rule that change
// makes gives the Merchant's other Transactions the same Category.

const APP_URL = "http://nas.local:8080";

let webRoot: string;
let stops: (() => void)[] = [];

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-transactions-page-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  vi.unstubAllGlobals();
});

describe("the Transactions page on the demo household", () => {
  it("changes a Category, and the Category rule gives the Merchant's other Transactions that Category", async () => {
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    const test = await newTestAuth(APP_URL, quiet);
    const app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
      test.secrets,
    );
    const fake = new FakeBankAdapter();
    stops = [
      startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop,
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startMoneyMovement({ database: test.database }).stop,
      startCategorization({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    const browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
    await seedDemoHousehold(test.database, fake);
    await runFollowUp();

    // The page's requests go to the app as the signed-in browser.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), APP_URL);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return browser.send(init?.method ?? "GET", `${url.pathname}${url.search}`, body);
    });
    const page = async (filters: Parameters<typeof transactionRequests.list>[0]) => {
      const res = await transactionRequests.list(filters);
      expect(res.status).toBe(200);
      return (await res.json()) as TransactionListView;
    };

    // A demo Merchant with more than one Spending Transaction, none set by hand.
    const { transactions } = await page({ type: "Spending" });
    const byMerchant = Map.groupBy(
      transactions.filter((txn) => txn.merchant !== null && txn.parts.length === 1),
      (txn) => txn.merchant,
    );
    const [merchant] =
      [...byMerchant].find(
        ([, each]) =>
          each.length > 1 &&
          each.every((txn) => txn.parts[0]?.categoryChosenBy !== "hand-set") &&
          new Set(each.map((txn) => txn.parts[0]?.category)).size === 1,
      ) ?? [];
    if (merchant == null) throw new Error("No demo Merchant fits.");
    // Every one of its Transactions, past the first page.
    const rows = (await page({ merchant })).transactions;
    expect(rows.every((txn) => txn.parts.length === 1)).toBe(true);
    const [first, ...others] = rows;
    if (first === undefined) throw new Error("The Merchant filter found nothing.");
    const category =
      first.parts[0]?.category === "Gifts and donations" ? "Hobbies" : "Gifts and donations";

    const res = await transactionRequests.setCategory(first.id, category, false);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      category,
      rule: { merchantName: merchant, category },
    });
    await runFollowUp();

    // The Transaction shows the hand-set Category; the Merchant's others show the rule's.
    const detail = (await (
      await transactionRequests.detail(first.id)
    ).json()) as TransactionDetailView;
    expect(detail.decision?.parts).toMatchObject([{ category, categoryChosenBy: "hand-set" }]);
    const after = await page({ merchant });
    expect(after.transactions.map((txn) => [txn.id, txn.parts])).toEqual(
      rows.map((txn) => [
        txn.id,
        [
          expect.objectContaining({
            category,
            categoryChosenBy: txn.id === first.id ? "hand-set" : "Category rule",
          }),
        ],
      ]),
    );
    expect(others.length).toBeGreaterThan(0);
    // The Category filter now finds them all.
    const filtered = await page({ merchant, category });
    expect(filtered.transactions.map((txn) => txn.id)).toEqual(rows.map((txn) => txn.id));
  });
});
