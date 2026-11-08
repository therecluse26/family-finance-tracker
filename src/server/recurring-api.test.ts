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
import { startRecurringCharges } from "../recurring/index.ts";
import { createApp } from "./app.ts";
import type { RecurringChargeView } from "./recurring-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Recurring charges through the app's HTTP interface, on Transactions the fake adapter synced.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-recurring-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Recurring charge routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let stops: (() => void)[];

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
      startRecurringCharges({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);

    const card = fakeAccount({ id: "acc-card", type: "credit", subtype: "credit card" });
    const streamly = (id: string, postedDate: string) =>
      fakeTxn({ id, accountId: card.id, amount: -1_549, postedDate, merchantName: "Streamly" });
    // A phone bill paid from checking is not on a card.
    const checking = fakeAccount({ id: "acc-checking" });
    const brightwave = (id: string, postedDate: string) =>
      fakeTxn({
        id,
        accountId: checking.id,
        amount: -6_500,
        postedDate,
        merchantName: "Brightwave",
      });
    fake.addPages(BANK, {
      accounts: [card, checking],
      added: [
        streamly("s1", "2026-07-03"),
        streamly("s2", "2026-08-03"),
        streamly("s3", "2026-09-03"),
        brightwave("b1", "2026-06-20"),
        brightwave("b2", "2026-07-20"),
        brightwave("b3", "2026-08-20"),
        // A one-off off the schedule, which a Member may add.
        { ...brightwave("bx", "2026-08-01"), amount: -1_299 },
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
    await syncConnection(connectionId, () => new Date("2026-09-05T15:00:00.000Z"));
    await runFollowUp();
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    test.close();
  });

  const list = async () =>
    (
      (await (await browser.get("/api/recurring-charges")).json()) as {
        charges: RecurringChargeView[];
      }
    ).charges;

  it("lists the Recurring charges a history load found", async () => {
    // By next expected date.
    expect(await list()).toEqual([
      expect.objectContaining({
        merchantName: "Brightwave",
        nextExpectedDate: "2026-09-20",
        latestAmount: 6_500,
        onCard: false,
      }),
      {
        id: expect.any(String),
        name: null,
        merchantName: "Streamly",
        category: expect.any(String),
        categoryByHand: false,
        priceBand: null,
        defaultPriceBand: 7.5,
        schedule: "monthly",
        nextExpectedDate: "2026-10-03",
        latestAmount: 1_549,
        priceHistory: [
          {
            transactionId: expect.any(String),
            date: "2026-07-03",
            amount: 1_549,
            addedByHand: false,
          },
          {
            transactionId: expect.any(String),
            date: "2026-08-03",
            amount: 1_549,
            addedByHand: false,
          },
          {
            transactionId: expect.any(String),
            date: "2026-09-03",
            amount: 1_549,
            addedByHand: false,
          },
        ],
        priceChanges: [],
        accountId: expect.any(String),
        onCard: true,
        // Its status depends on today.
        status: expect.stringMatching(/^(active|inactive)$/),
      },
    ]);
  });

  it("marks a Recurring charge ended, and answers 404 for an unknown ID", async () => {
    const [charge] = await list();

    const res = await browser.send("POST", `/api/recurring-charges/${charge?.id}/end`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      charge: { id: charge?.id, status: "ended", onCard: false },
    });
    expect((await list()).map((each) => each.status)).toEqual([
      "ended",
      expect.stringMatching(/^(active|inactive)$/),
    ]);

    expect((await browser.send("POST", "/api/recurring-charges/no-such-id/end")).status).toBe(404);
  });

  it("answers 401 with no session and 403 from another site, and ends nothing", async () => {
    const [charge] = await list();
    const end = `/api/recurring-charges/${charge?.id}/end`;
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");

    expect((await signedOut.send("POST", end)).status).toBe(401);
    for (const origin of ["http://evil.example", undefined]) {
      expect((await browser.send("POST", end, undefined, { origin })).status).toBe(403);
    }

    expect((await list()).map((each) => each.status)).not.toContain("ended");
  });

  describe("a Member's edits", () => {
    const brightwave = async () => {
      const found = (await list()).find((each) => each.merchantName === "Brightwave");
      if (found === undefined) throw new Error("No Brightwave Recurring charge.");
      return found;
    };
    const candidates = async (id: string) =>
      (
        (await (await browser.get(`/api/recurring-charges/${id}/candidates`)).json()) as {
          candidates: { transactionId: string; amount: number; removedByHand: boolean }[];
        }
      ).candidates;
    // Each write route, with a body that would change the Recurring charge.
    const writes = async () => {
      const charge = await brightwave();
      const [extra] = await candidates(charge.id);
      const [first] = charge.priceHistory;
      return {
        charge,
        routes: [
          ["PUT", `/api/recurring-charges/${charge.id}`, { name: "Home phone" }],
          [
            "POST",
            `/api/recurring-charges/${charge.id}/price-changes`,
            { fromDate: "2026-09-20", amount: 7_000 },
          ],
          [
            "POST",
            `/api/recurring-charges/${charge.id}/transactions`,
            { transactionId: extra?.transactionId },
          ],
          ["DELETE", `/api/recurring-charges/${charge.id}/transactions/${first?.transactionId}`],
        ] as [string, string, unknown?][],
      };
    };

    it("names one, sets its Category and price band, and clears them with null", async () => {
      const charge = await brightwave();
      const res = await browser.send("PUT", `/api/recurring-charges/${charge.id}`, {
        name: "  Home phone ",
        category: "Phone and internet",
        priceBand: 12.5,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        charge: {
          id: charge.id,
          name: "Home phone",
          merchantName: "Brightwave",
          category: "Phone and internet",
          categoryByHand: true,
          priceBand: 12.5,
        },
      });

      const cleared = await browser.send("PUT", `/api/recurring-charges/${charge.id}`, {
        name: null,
        category: null,
        priceBand: null,
      });
      expect(await cleared.json()).toMatchObject({
        charge: { name: null, categoryByHand: false, priceBand: null },
      });
    });

    it("shows a name a Member gave on the Transactions page, next to the Merchant", async () => {
      const charge = await brightwave();
      await browser.send("PUT", `/api/recurring-charges/${charge.id}`, { name: "Home phone" });

      const { transactions } = (await (await browser.get("/api/transactions")).json()) as {
        transactions: { id: string; merchant: string; recurringChargeName: string | null }[];
      };
      const inIt = new Set(charge.priceHistory.map((entry) => entry.transactionId));
      for (const txn of transactions) {
        expect([txn.id, txn.recurringChargeName]).toEqual([
          txn.id,
          inIt.has(txn.id) ? "Home phone" : null,
        ]);
      }
      expect(transactions.filter((txn) => txn.recurringChargeName !== null)).toHaveLength(3);

      // A Transaction a Member removed shows no name.
      const [first] = charge.priceHistory;
      await browser.send(
        "DELETE",
        `/api/recurring-charges/${charge.id}/transactions/${first?.transactionId}`,
      );
      const after = (await (await browser.get("/api/transactions")).json()) as {
        transactions: { id: string; recurringChargeName: string | null }[];
      };
      expect(
        after.transactions.find((txn) => txn.id === first?.transactionId)?.recurringChargeName,
      ).toBeNull();
      expect(after.transactions.filter((txn) => txn.recurringChargeName !== null)).toHaveLength(2);
    });

    it("sets and deletes a price change, and adds and removes a Transaction", async () => {
      const charge = await brightwave();
      const set = await browser.send("POST", `/api/recurring-charges/${charge.id}/price-changes`, {
        fromDate: "2026-09-20",
        amount: 7_000,
      });
      expect(set.status).toBe(200);
      const { charge: changed } = (await set.json()) as { charge: RecurringChargeView };
      expect(changed.latestAmount).toBe(7_000);
      const [change] = changed.priceChanges;
      expect(change).toMatchObject({ fromDate: "2026-09-20", amount: 7_000, byHand: true });
      const deleted = await browser.send(
        "DELETE",
        `/api/recurring-charges/${charge.id}/price-changes/${change?.id}`,
      );
      expect(deleted.status).toBe(200);
      expect((await brightwave()).latestAmount).toBe(6_500);

      const [extra] = await candidates(charge.id);
      expect(extra).toMatchObject({ amount: 1_299, removedByHand: false });
      const added = await browser.send("POST", `/api/recurring-charges/${charge.id}/transactions`, {
        transactionId: extra?.transactionId,
      });
      expect(added.status).toBe(200);
      expect((await brightwave()).priceHistory).toContainEqual(
        expect.objectContaining({ transactionId: extra?.transactionId, addedByHand: true }),
      );
      const removed = await browser.send(
        "DELETE",
        `/api/recurring-charges/${charge.id}/transactions/${extra?.transactionId}`,
      );
      expect(removed.status).toBe(200);
      expect(await candidates(charge.id)).toEqual([
        {
          transactionId: extra?.transactionId,
          date: "2026-08-01",
          amount: 1_299,
          removedByHand: true,
        },
      ]);
    });

    it("refuses a bad body with 400, an unknown ID with 404, and an ended one with 409", async () => {
      const charge = await brightwave();
      const path = `/api/recurring-charges/${charge.id}`;
      for (const body of [
        {},
        { name: "" },
        { name: "   " },
        { name: "x".repeat(61) },
        { name: "Home\tphone" },
        { category: "Not a Category" },
        { priceBand: 12.55 },
        { priceBand: 101 },
        { priceBand: -1 },
        { other: 1 },
      ]) {
        expect([body, (await browser.send("PUT", path, body)).status]).toEqual([body, 400]);
      }
      // 60 characters counts each emoji once.
      expect((await browser.send("PUT", path, { name: "📞".repeat(60) })).status).toBe(200);
      for (const body of [
        { fromDate: "2026-02-30", amount: 100 },
        { fromDate: "2026-9-20", amount: 100 },
        { fromDate: "2026-09-20", amount: 0 },
        { fromDate: "2026-09-20", amount: 1.5 },
      ]) {
        const res = await browser.send("POST", `${path}/price-changes`, body);
        expect([body, res.status]).toEqual([body, 400]);
      }

      expect(
        (await browser.send("PUT", "/api/recurring-charges/no-such-id", { name: "X" })).status,
      ).toBe(404);
      expect((await browser.send("DELETE", `${path}/price-changes/no-such-id`)).status).toBe(404);
      expect(
        (await browser.send("POST", `${path}/transactions`, { transactionId: "no-such-id" }))
          .status,
      ).toBe(404);
      expect((await browser.send("DELETE", `${path}/transactions/no-such-id`)).status).toBe(404);
      expect((await browser.get("/api/recurring-charges/no-such-id/candidates")).status).toBe(404);

      await browser.send("POST", `${path}/end`);
      expect((await browser.send("PUT", path, { name: "Home phone" })).status).toBe(409);
      expect((await brightwave()).name).toBe("📞".repeat(60));
    });

    it("answers 401 with no session, 403 from another site, and 415 for a body not JSON, and changes nothing", async () => {
      const { charge, routes } = await writes();
      const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");

      for (const [method, path, body] of routes) {
        expect([path, (await signedOut.send(method, path, body)).status]).toEqual([path, 401]);
        for (const origin of ["http://evil.example", undefined]) {
          const res = await browser.send(method, path, body, { origin });
          expect([path, origin, res.status]).toEqual([path, origin, 403]);
        }
        if (body !== undefined) {
          const res = await browser.send(method, path, body, { "content-type": "text/plain" });
          expect([path, res.status]).toEqual([path, 415]);
        }
      }
      expect(await brightwave()).toEqual(charge);
      expect((await signedOut.get(`/api/recurring-charges/${charge.id}/candidates`)).status).toBe(
        401,
      );
    });
  });
});
