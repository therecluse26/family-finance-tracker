import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import type { TxnRecord } from "../bank/adapter.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { addConnection, markSetupStep } from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { createApp } from "./app.ts";
import type { TransactionListView } from "./bank-views.ts";
import type { TransactionDetailView } from "./money-movement-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The Transactions page's reads (spec 07, Transactions page): the list with its filters and pages,
// and one Transaction's detail, through the app's HTTP interface, on Transactions the fake adapter
// synced. Also the hand-set type route the page calls.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-transactions-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

const plaid = (name: string) => ({ name, confidence: "HIGH", version: "v2", mcc: null });

describe("the Transactions page's routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let stops: (() => void)[];
  let ids: Map<string, string>;
  let checkingId: string;

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
    const checking = fakeAccount({ id: "acc-checking", mask: "1234" });
    const target = (id: string, amount: number, postedDate: string): TxnRecord =>
      fakeTxn({
        id,
        accountId: card.id,
        amount,
        postedDate,
        description: "TARGET",
        merchantName: "Target",
        category: plaid("GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE"),
      });
    const bistro = (id: string, postedDate: string, fields: Partial<TxnRecord> = {}) =>
      fakeTxn({
        id,
        accountId: card.id,
        amount: -4_250,
        postedDate,
        description: "CORNER BISTRO",
        merchantName: "Corner Bistro",
        category: plaid("FOOD_AND_DRINK_RESTAURANT"),
        ...fields,
      });
    fake.addPages(BANK, {
      accounts: [card, checking],
      added: [
        target("purchase", -12_000, "2026-10-01"),
        // Its Refund posts in November, and counts in the purchase's month.
        target("refund", 3_000, "2026-11-02"),
        bistro("dinner", "2026-10-20", { authorizedDate: "2026-10-19" }),
        bistro("lunch", "2026-11-03"),
        bistro("tonight", "2026-11-04", { pending: true }),
        fakeTxn({
          id: "paycheck",
          accountId: checking.id,
          amount: 320_000,
          postedDate: "2026-10-31",
          description: "ACME PAYROLL",
          category: plaid("INCOME_WAGES"),
        }),
        fakeTxn({ id: "gone", accountId: card.id, amount: -6_000, postedDate: "2026-10-05" }),
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
    await syncConnection(connectionId, () => new Date("2026-11-04T15:00:00.000Z"));
    await runFollowUp();
    await test.database.$client.execute(
      "UPDATE transactions SET hidden_reason = 'removed by provider' WHERE provider_transaction_id = 'gone'",
    );
    const rows = await test.database.$client.execute(
      "SELECT id, provider_transaction_id, account_id FROM transactions",
    );
    ids = new Map(rows.rows.map((row) => [String(row.provider_transaction_id), String(row.id)]));
    checkingId = String(
      rows.rows.find((row) => row.provider_transaction_id === "paycheck")?.account_id,
    );
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    test.close();
  });

  const id = (providerId: string) => ids.get(providerId) ?? "none";
  const providerIdOf = (txnId: string) =>
    [...ids].find(([, value]) => value === txnId)?.[0] ?? txnId;
  const list = async (query: string) => {
    const res = await browser.get(`/api/transactions${query}`);
    expect(res.status, query).toBe(200);
    return (await res.json()) as TransactionListView;
  };
  const listed = async (query: string) =>
    (await list(query)).transactions.map((txn) => providerIdOf(txn.id));
  const detail = async (providerId: string) => {
    const res = await browser.get(`/api/transactions/${id(providerId)}`);
    expect(res.status).toBe(200);
    return (await res.json()) as TransactionDetailView;
  };
  const SPLIT = {
    parts: [
      { amount: 8_000, category: "Groceries" },
      { amount: 4_000, category: "Clothing" },
    ],
  };

  it("lists every Transaction that shows, newest first, with its Merchant, its parts, and how each Category was chosen", async () => {
    const { transactions, next } = await list("");

    expect(next).toBeNull();
    expect(transactions.map((txn) => providerIdOf(txn.id))).toEqual([
      "tonight",
      "lunch",
      "refund",
      "paycheck",
      "dinner",
      "purchase",
    ]);
    const dinner = transactions.find((txn) => txn.id === id("dinner"));
    expect(dinner).toEqual({
      id: id("dinner"),
      accountId: expect.any(String),
      amount: -4_250,
      postedDate: "2026-10-20",
      authorizedDate: "2026-10-19",
      pending: false,
      description: "CORNER BISTRO",
      merchantName: "Corner Bistro",
      merchant: "Corner Bistro",
      parts: [
        {
          type: "Spending",
          amount: -4_250,
          category: "Restaurants",
          linked: false,
          categoryChosenBy: "Plaid",
        },
      ],
    });
    expect(transactions.find((txn) => txn.id === id("tonight"))?.pending).toBe(true);
    expect(transactions.find((txn) => txn.id === id("paycheck"))?.parts).toEqual([
      { type: "Income", amount: 320_000, category: null, linked: false, categoryChosenBy: null },
    ]);
  });

  it("filters by Account, posted date, Merchant, type, Category, and month, each on its own and together", async () => {
    expect(await listed(`?account=${checkingId}`)).toEqual(["paycheck"]);
    expect(await listed("?from=2026-10-20&to=2026-11-02")).toEqual([
      "refund",
      "paycheck",
      "dinner",
    ]);
    expect(await listed("?merchant=Target")).toEqual(["refund", "purchase"]);
    expect(await listed("?merchant=Corner%20Bistro")).toEqual(["tonight", "lunch", "dinner"]);
    expect(await listed("?type=Income")).toEqual(["paycheck"]);
    expect(await listed("?type=Refund")).toEqual(["refund"]);
    expect(await listed("?type=Transfer")).toEqual([]);
    expect(await listed("?category=Restaurants")).toEqual(["tonight", "lunch", "dinner"]);
    // The month comes from the purchase date, else the posted date.
    expect(await listed("?category=Restaurants&month=2026-10")).toEqual(["dinner"]);
    expect(await listed("?type=Income&month=2026-10")).toEqual(["paycheck"]);
    // A linked Refund has its purchase's Category and month.
    expect(await listed("?category=Superstores&month=2026-10")).toEqual(["refund", "purchase"]);
    expect(await listed("?type=Refund&month=2026-11")).toEqual([]);
    expect(await listed("?category=Superstores&month=2026-11")).toEqual([]);
    expect(await listed("?merchant=Target&type=Spending")).toEqual(["purchase"]);
    // An empty filter is no filter.
    expect(await listed("?account=&category=&type=&month=")).toHaveLength(6);
  });

  it("finds a Merchant by word starts in the name its row shows, exact words in quotes, and text inside a word after *", async () => {
    expect(await listed("?merchant=bIsT")).toEqual(["tonight", "lunch", "dinner"]);
    expect(await listed("?merchant=TARG")).toEqual(["refund", "purchase"]);
    expect(await listed("?merchant=bistro%20corn")).toEqual(["tonight", "lunch", "dinner"]);
    expect(await listed("?merchant=bistro%20target")).toEqual([]);
    expect(await listed("?merchant=%22corner%20bistro%22")).toEqual(["tonight", "lunch", "dinner"]);
    expect(await listed("?merchant=%22bist%22")).toEqual([]);
    expect(await listed("?merchant=istro")).toEqual([]);
    expect(await listed("?merchant=*istro")).toEqual(["tonight", "lunch", "dinner"]);
    // A Transaction with no Merchant name is found by the bank's line its row shows.
    expect(await listed("?merchant=payroll")).toEqual(["paycheck"]);
    expect(await listed("?merchant=payroll&type=Spending")).toEqual([]);
    // % and _ alone match only themselves; FTS5 syntax is only text.
    for (const text of ["%25", "_", "%5C", "Nowhere", "NEAR(", "-corner%20OR"]) {
      expect(await listed(`?merchant=${text}`), text).toEqual([]);
    }
    // A lone quote holds no term, so it is no filter.
    expect(await listed("?merchant=%22")).toHaveLength(6);
  });

  it("finds a Refund on a split purchase by each part's Category, and shows it per part in the detail", async () => {
    expect(
      (await browser.send("PUT", `/api/transactions/${id("purchase")}/split`, SPLIT)).status,
    ).toBe(200);
    await runFollowUp();

    expect(await listed("?category=Clothing")).toEqual(["refund", "purchase"]);
    expect(await listed("?category=Groceries&month=2026-10")).toEqual(["refund", "purchase"]);
    expect(await listed("?category=Superstores")).toEqual([]);
    const refund = await detail("refund");
    expect(refund.decision?.parts).toEqual([
      {
        type: "Refund",
        amount: 2_000,
        category: "Groceries",
        linked: true,
        categoryChosenBy: null,
      },
      { type: "Refund", amount: 1_000, category: "Clothing", linked: true, categoryChosenBy: null },
    ]);
    expect(refund.transaction.parts).toEqual(refund.decision?.parts);
    expect(refund.otherLinks).toMatchObject([
      { kind: "Refund", otherTransactionId: id("purchase"), tier: "Strong", madeBy: "app" },
    ]);
    expect(refund.matched.map((txn) => txn.id)).toEqual([id("purchase")]);
    expect(refund.matched[0]?.parts.map((part) => [part.category, part.categoryChosenBy])).toEqual([
      ["Groceries", "hand-set"],
      ["Clothing", "hand-set"],
    ]);
  });

  it("shows a hand-set Category, and the Category rule it makes on the Merchant's other Transactions", async () => {
    const res = await browser.send("PUT", `/api/transactions/${id("dinner")}/category`, {
      category: "Groceries",
    });
    expect(res.status).toBe(200);
    await runFollowUp();

    const chosen = async (providerId: string) =>
      (await detail(providerId)).decision?.parts.map((part) => [
        part.category,
        part.categoryChosenBy,
      ]);
    expect(await chosen("dinner")).toEqual([["Groceries", "hand-set"]]);
    expect(await chosen("lunch")).toEqual([["Groceries", "Category rule"]]);
  });

  it("reads one page at a time, newest first, and the next page after the last row", async () => {
    const first = await list("?limit=4");
    expect(first.transactions.map((txn) => providerIdOf(txn.id))).toEqual([
      "tonight",
      "lunch",
      "refund",
      "paycheck",
    ]);
    expect(first.next).toBe(id("paycheck"));
    const second = await list(`?limit=4&after=${first.next}`);
    expect(second.transactions.map((txn) => providerIdOf(txn.id))).toEqual(["dinner", "purchase"]);
    expect(second.next).toBeNull();
    // A page with the filters.
    const bistro = await list("?merchant=Corner%20Bistro&limit=2");
    expect(bistro.transactions.map((txn) => providerIdOf(txn.id))).toEqual(["tonight", "lunch"]);
    const rest = await list(`?merchant=Corner%20Bistro&limit=2&after=${bistro.next}`);
    expect(rest).toMatchObject({ transactions: [{ id: id("dinner") }], next: null });
  });

  it("reads each Transaction once, in order, when a page ends between rows on one posted date", async () => {
    // Four Transactions post on one date, after the two newest.
    await test.database.$client.execute(
      `UPDATE transactions SET posted_date = '2026-10-20' WHERE provider_transaction_id IN
       ('purchase', 'refund', 'dinner', 'paycheck')`,
    );
    const whole = await listed("");
    expect(whole).toHaveLength(6);
    expect(whole.slice(0, 2)).toEqual(["tonight", "lunch"]);

    for (const limit of [1, 2, 3, 4, 5]) {
      const paged: string[] = [];
      let after: string | null = null;
      do {
        const page: TransactionListView = await list(
          `?limit=${limit}${after === null ? "" : `&after=${after}`}`,
        );
        paged.push(...page.transactions.map((txn) => providerIdOf(txn.id)));
        after = page.next;
      } while (after !== null);
      expect(paged, `limit ${limit}`).toEqual(whole);
    }
  });

  it("runs newest first by the date each row shows, and pages by that date with no row skipped or shown twice", async () => {
    // Lunch and the refund post late but show earlier purchase dates; dinner shows lunch's date.
    await test.database.$client.execute(
      `UPDATE transactions SET authorized_date = CASE provider_transaction_id
         WHEN 'lunch' THEN '2026-10-25' WHEN 'refund' THEN '2026-10-30' WHEN 'dinner' THEN '2026-10-25'
       END WHERE provider_transaction_id IN ('lunch', 'refund', 'dinner')`,
    );
    // Lunch and dinner show the same date: the later posted date goes first (lunch posts
    // 2026-11-03, dinner 2026-10-20), then the ID.
    const shownTie = ["lunch", "dinner"];
    const order = ["tonight", "paycheck", "refund", ...shownTie, "purchase"];

    const whole = await list("");
    expect(whole.transactions.map((txn) => providerIdOf(txn.id))).toEqual(order);
    const shown = whole.transactions.map((txn) => txn.authorizedDate ?? txn.postedDate);
    expect(shown).toEqual(shown.toSorted().reverse());
    for (const limit of [1, 2, 3, 4, 5]) {
      const paged: string[] = [];
      let after: string | null = null;
      do {
        const page: TransactionListView = await list(
          `?limit=${limit}${after === null ? "" : `&after=${after}`}`,
        );
        paged.push(...page.transactions.map((txn) => providerIdOf(txn.id)));
        after = page.next;
      } while (after !== null);
      expect(paged, `limit ${limit}`).toEqual(order);
    }
    // The Account page's list, with its date filter, runs the same way.
    const card = whole.transactions.find((txn) => txn.id === id("lunch"))?.accountId ?? "";
    expect(await listed(`?account=${card}&from=2026-10-01`)).toEqual(
      order.filter((each) => each !== "paycheck"),
    );
  });

  it("refuses a filter or a page it cannot read", async () => {
    for (const query of [
      "?from=October",
      "?month=2026-13",
      "?category=Snacks",
      "?type=Fee",
      "?limit=0",
      "?limit=201",
      "?limit=ten",
      "?limit=5&after=no-such-id",
      // A page after a Transaction needs a limit.
      `?after=${id("lunch")}`,
    ]) {
      expect((await browser.get(`/api/transactions${query}`)).status, query).toBe(400);
    }
  });

  it("answers no one who is signed out", async () => {
    const stranger = new TestBrowser(app, APP_URL, "192.168.1.21");

    expect((await stranger.get("/api/transactions?limit=5")).status).toBe(401);
    expect((await stranger.get(`/api/transactions/${id("dinner")}`)).status).toBe(401);
  });

  describe("PUT /api/transactions/:id/type", () => {
    const path = () => `/api/transactions/${id("dinner")}/type`;
    const stored = async () =>
      (
        await test.database.$client.execute({
          sql: `SELECT t.hand_set, p.type FROM transactions t
                JOIN transaction_parts p ON p.transaction_id = t.id WHERE t.id = ?`,
          args: [id("dinner")],
        })
      ).rows.map((row) => ({ ...row }));

    it("sets the type by hand", async () => {
      const res = await browser.send("PUT", path(), { type: "Transfer" });
      await runFollowUp();

      expect(res.status).toBe(200);
      expect((await detail("dinner")).decision).toMatchObject({
        step: "1",
        parts: [{ type: "Transfer", category: null }],
      });
    });

    it("answers 401 with no session, 403 from another site or with no Origin, and 415 to a body that is not JSON, and changes nothing", async () => {
      const before = await stored();
      const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");

      expect((await signedOut.send("PUT", path(), { type: "Transfer" })).status).toBe(401);
      for (const origin of ["http://evil.example", undefined]) {
        const put = await browser.send("PUT", path(), { type: "Transfer" }, { origin });
        expect(put.status, `origin ${origin}`).toBe(403);
      }
      const text = await browser.send(
        "PUT",
        path(),
        { type: "Transfer" },
        { "content-type": "text/plain" },
      );
      expect(text.status).toBe(415);
      await runFollowUp();

      expect(await stored()).toEqual(before);
      expect(before).toEqual([{ hand_set: "{}", type: "Spending" }]);
    });
  });
});
