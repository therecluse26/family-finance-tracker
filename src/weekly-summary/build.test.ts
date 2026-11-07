import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { type Category, categoryGroupOf } from "../categories/index.ts";
import {
  addReviewItems,
  type NewBudget,
  type NewPart,
  replaceRecurringCharges,
  type StoredRecurringCharge,
  storeAlerts,
  storeDecisions,
  storeFirstDraft,
  storeHouseholdFacts,
} from "../db/index.ts";
import { buildWeeklySummary, COMING_UP_SHOWN, summaryWeek } from "./index.ts";

// The weekly summary email's text (spec 06, Weekly summary email, What it holds), built from
// app.db as the job builds it, on the fake bank. The Household is in New York. The summary goes out
// on Sunday, Nov 8, 2026 at 8:00 AM, and covers Sunday, Nov 1 to Saturday, Nov 7.

const APP_URL = "http://nas.local:8080";
const NEW_YORK = "America/New_York";
const SENT_AT = new Date("2026-11-08T13:00:00.000Z");
const BANK = "fake-summary-bank";
// The Account's name and mask must never reach the summary.
const CARD = fakeAccount({
  id: "acc-card",
  name: "Sapphire Reserve",
  mask: "4821",
  type: "credit",
  subtype: "credit card",
});

const $ = (dollars: number) => Math.round(dollars * 100);
const at = (date: string) => new Date(`${date}T15:00:00.000Z`);

type TxnSpec = {
  id: string;
  date: string;
  parts: NewPart[];
  pending?: boolean;
  // The purchase date, when the bank gives one.
  bought?: string;
};

const spend = (id: string, date: string, dollars: number, category: Category): TxnSpec => ({
  id,
  date,
  parts: [{ type: "Spending", amount: -$(dollars), category }],
});

const monthly = (category: Category, dollars: number): NewBudget => ({
  category,
  amount: $(dollars),
  period: "monthly",
  takesEffect: "2026-01",
  source: "formula",
  setBy: null,
  pinned: categoryGroupOf(category) === "Bills" ? false : null,
  setAt: at("2026-01-02"),
});

describe("the weekly summary's text", () => {
  let bank: TestBank;
  let connectionId: string;
  let made = 0;

  // The summary sent at `sentAt`, the Nov 8 one unless a test names another Sunday.
  const build = (sentAt = SENT_AT) =>
    buildWeeklySummary({
      database: bank.database,
      week: summaryWeek(sentAt, NEW_YORK),
      timeZone: NEW_YORK,
      address: (path) => `${APP_URL}${path}`,
      now: sentAt,
    });

  // Syncs one page of these Transactions, and the bank's removal of others. Returns each
  // Transaction's ID in app.db, by its bank ID.
  const load = async (txns: TxnSpec[], removed: string[] = []) => {
    bank.fake.addPages(BANK, {
      accounts: [CARD],
      removed: removed.map((id) => ({ id })),
      added: txns.map((txn) =>
        fakeTxn({
          id: txn.id,
          accountId: CARD.id,
          amount: txn.parts.reduce((sum, part) => sum + part.amount, 0),
          postedDate: txn.date,
          pending: txn.pending ?? false,
          authorizedDate: txn.bought ?? null,
        }),
      ),
    });
    await syncConnection(connectionId, () => SENT_AT);
    const rows = await bank.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    const ids = new Map(
      rows.rows.map((row) => [String(row.provider_transaction_id), String(row.id)]),
    );
    await storeDecisions(
      bank.database,
      txns.map((txn) => ({
        transactionId: ids.get(txn.id) ?? "",
        step: "5.7",
        provisionalUntil: null,
        decidedAt: SENT_AT,
        parts: txn.parts,
      })),
    );
    return ids;
  };

  const draft = (budgets: NewBudget[]) =>
    storeFirstDraft(bank.database, {
      inputs: {
        steadyIncome: $(6_000),
        ceDataYear: 2024,
        sampleBenchmarks: false,
        firstDraftMonth: "2026-01",
        fixedCostsPassIncome: false,
        recordedAt: at("2026-01-02"),
      },
      budgets,
    });

  const charge = (
    merchantName: string,
    nextExpectedDate: string,
    dollars: number,
    status: StoredRecurringCharge["status"] = "active",
  ): StoredRecurringCharge => {
    made += 1;
    return {
      id: `charge-${made}`,
      merchantId: null,
      merchantName,
      category: "Entertainment",
      schedule: "monthly",
      nextExpectedDate,
      latestAmount: $(dollars),
      priceHistory: [],
      accountId: "",
      status,
      foundAt: at("2026-10-01"),
      endedAt: status === "ended" ? at("2026-10-20") : null,
      endedBy: null,
    };
  };

  const storeCharges = async (charges: StoredRecurringCharge[]) => {
    const [account] = (
      await bank.database.$client.execute("SELECT id FROM household_accounts LIMIT 1")
    ).rows;
    await replaceRecurringCharges(
      bank.database,
      charges.map((each) => ({ ...each, accountId: String(account?.id) })),
    );
  };

  const alert = (
    id: string,
    kind: "Over Budget" | "Large purchase" | "Duplicate charge",
    createdAt: string,
    state: "sent" | "held back (weekly cap)" | "found in history",
  ) => ({
    id,
    kind,
    createdAt: new Date(createdAt),
    facts: { kind },
    text: `${kind} text`,
    category: null,
    state,
    transactionIds: [],
  });

  beforeEach(async () => {
    made = 0;
    bank = await newTestBank({ timeZone: NEW_YORK });
    await storeHouseholdFacts(bank.database, {
      zipCode: "10001",
      state: "NY",
      timeZone: NEW_YORK,
      ages: [41],
      rentOrOwn: "rent",
      updatedAt: at("2026-01-01"),
      updatedBy: null,
    });
    connectionId = await bank.connect(BANK);
  });

  afterEach(() => {
    bank.close();
  });

  it("holds each part, with its numbers and links, and names no Account", async () => {
    await draft([
      monthly("Groceries", 700),
      monthly("Restaurants", 30),
      monthly("Clothing", 5_000),
    ]);
    await load([
      // The history starts on Wednesday, Oct 7. As the Dashboard counts the month the history
      // starts in, the usual counts the week it starts in: the median of $50, $100, $200 and $200
      // is $150. Without that week it would be $200.
      spend("oct-7", "2026-10-07", 50, "Groceries"),
      spend("oct-14", "2026-10-14", 100, "Groceries"),
      spend("oct-21", "2026-10-21", 200, "Groceries"),
      spend("oct-28", "2026-10-28", 150, "Groceries"),
      spend("oct-31", "2026-10-31", 50, "Clothing"),
      // Bought on Saturday, Oct 31, posted on Monday: still pending at the Nov 1 summary, so it
      // counts in this one, the week it posted. October's totals count it on its purchase date.
      { ...spend("bought-oct-31", "2026-11-02", 60, "Groceries"), bought: "2026-10-31" },
      // The summary's 7 days, by the app's Spending rule: Groceries $60 + $240 - a $30 Refund =
      // $270; Restaurants $40; and Clothing, a $20 Refund with no Spending that week, counts $0,
      // not -$20. In all, $310. The $10 bought on Saturday and posted on Sunday is the next
      // summary's. At $240, the Nov 3 purchase is no Large purchase, so the projection counts it.
      spend("nov-3", "2026-11-03", 240, "Groceries"),
      {
        id: "refund",
        date: "2026-11-05",
        parts: [{ type: "Refund", amount: $(30), category: "Groceries" }],
      },
      spend("nov-7", "2026-11-07", 40, "Restaurants"),
      { ...spend("bought-nov-7", "2026-11-08", 10, "Restaurants"), bought: "2026-11-07" },
      {
        id: "clothing-refund",
        date: "2026-11-06",
        parts: [{ type: "Refund", amount: $(20), category: "Clothing" }],
      },
      // Neither counts: a pending charge, and a Transfer.
      { ...spend("pending", "2026-11-06", 77, "Clothing"), pending: true },
      {
        id: "transfer",
        date: "2026-11-04",
        parts: [{ type: "Transfer", amount: -$(500), category: null }],
      },
      // Sunday the 8th is the next summary's.
      spend("nov-8", "2026-11-08", 999, "Clothing"),
    ]);
    await storeAlerts(bank.database, [
      alert("over", "Over Budget", "2026-11-02T15:00:00.000Z", "sent"),
      alert("large-1", "Large purchase", "2026-11-04T15:00:00.000Z", "held back (weekly cap)"),
      alert("large-2", "Large purchase", "2026-11-04T18:00:00.000Z", "held back (weekly cap)"),
      alert("history", "Duplicate charge", "2026-11-06T15:00:00.000Z", "found in history"),
      // 11 PM on Saturday, Oct 31 in New York, though it is Nov 1 in UTC.
      alert("before", "Over Budget", "2026-11-01T03:00:00.000Z", "sent"),
      alert("after", "Over Budget", "2026-11-08T14:00:00.000Z", "sent"),
    ]);
    // A merged Alert counts once.
    await bank.database.$client.execute(
      "INSERT INTO alert_parts (alert_id, merged_into) VALUES ('large-2', 'large-1')",
    );
    const review = { subjectType: "transactions" as const, subjectIds: [], decided: "A guess" };
    const [closed] = await addReviewItems(
      bank.database,
      [1, 2, 3, 4].map((n) => ({
        kind: "category guess",
        ...review,
        bestAnswer: { value: `v${n}`, label: `Answer ${n}` },
      })),
      SENT_AT,
    );
    await bank.database.$client.execute({
      sql: "UPDATE review_items SET closed_at = ?, closed_reason = 'answered' WHERE id = ?",
      args: [SENT_AT.toISOString(), closed ?? ""],
    });
    await storeCharges(
      [
        charge("Streamly", "2026-11-09", 15.49),
        // A bank's control character becomes a space: the name cannot start a line of its own.
        charge("Iron\nGym", "2026-11-14", 50),
        charge("Due later", "2026-11-15", 9.99),
        charge("Ended one", "2026-11-10", 12),
      ].map((each) => (each.merchantName === "Ended one" ? { ...each, status: "ended" } : each)),
    );

    const email = await build();
    expect(email.subject).toBe("Weekly summary: Nov 1 to Nov 7");
    expect(email.text).toBe(
      [
        "Your weekly summary for Sunday, Nov 1 to Saturday, Nov 7.",
        "",
        "Spending: $310, ▲ $160 above usual.",
        `See it: ${APP_URL}/transactions?type=Spending&from=2026-11-01&to=2026-11-07`,
        "",
        "Budgets in November 2026:",
        "- Groceries: ◆ on pace for $788, $210 of $700 so far.",
        "- Restaurants: ▲ Over Budget, $50 of $30.",
        `See them: ${APP_URL}/budgets`,
        "",
        "Alerts: 1 Alert sent, 1 held back (weekly cap).",
        `See them: ${APP_URL}/alert-list`,
        "",
        "Review list: 3 items open.",
        `See it: ${APP_URL}/review-list`,
        "",
        "Coming up, Nov 8 to Nov 14:",
        "- Nov 9: Streamly, $15.49",
        "- Nov 14: Iron Gym, $50.00",
        `See them: ${APP_URL}/recurring-charges`,
        "",
        `Turn this email off in Settings, Alerts: ${APP_URL}/settings/alerts`,
      ].join("\n"),
    );
    expect(email.text).not.toMatch(/Sapphire|4821|Reserve/);
  });

  it("counts each purchase in the summary of the week it posted, once, and keeps the usual like with like", async () => {
    // $100 of Groceries posts each Wednesday from Oct 7. A $100 purchase bought on Saturday, Nov 7
    // is still pending at the Nov 8 send.
    const weekly = ["2026-10-07", "2026-10-14", "2026-10-21", "2026-10-28", "2026-11-04"].map(
      (date) => spend(`weekly-${date}`, date, 100, "Groceries"),
    );
    await load([
      ...weekly,
      { ...spend("late-pending", "2026-11-07", 100, "Groceries"), pending: true },
    ]);
    expect((await build()).text).toContain("Spending: $100, ● about usual.\n");

    // It posts on Monday, Nov 9, with Wednesday's $100. On Tuesday, a $40 Refund of the Oct 28
    // purchase comes, linked to it: it counts in the week it came, not in October's.
    const ids = await load(
      [
        { ...spend("late", "2026-11-09", 100, "Groceries"), bought: "2026-11-07" },
        spend("weekly-2026-11-11", "2026-11-11", 100, "Groceries"),
        {
          id: "linked-refund",
          date: "2026-11-10",
          parts: [{ type: "Refund", amount: $(40), category: "Groceries", linked: true }],
        },
      ],
      ["late-pending"],
    );
    await bank.database.$client.execute({
      sql: `INSERT INTO spending_links (id, kind, transaction_id, spending_transaction_id, tier, signals, made_by, created_at)
            VALUES ('link', 'Refund', ?, ?, 'Strong', '[]', 'app', ?)`,
      args: [
        ids.get("linked-refund") ?? "",
        ids.get("weekly-2026-10-28") ?? "",
        SENT_AT.toISOString(),
      ],
    });

    // The Nov 15 summary counts it: $100 + $100 - $40 = $160. Its usual is $100: the Nov 1 to
    // Nov 7 week still reads $100, as its own summary did, and the Oct 25 to Oct 31 week keeps its
    // $100.
    const nextSunday = new Date("2026-11-15T13:00:00.000Z");
    expect((await build(nextSunday)).text).toContain("Spending: $160, ▲ $60 above usual.\n");
    expect((await build()).text).toContain("Spending: $100, ● about usual.\n");
  });

  it("says so with no Budgets, no Spending history, no Alerts, and nothing due", async () => {
    const email = await build();
    expect(email.text).toContain("Spending: $0.\n");
    expect(email.text).toContain("Budgets in November 2026:\nNo Budgets yet.\n");
    expect(email.text).toContain("Alerts: 0 Alerts sent, 0 held back (weekly cap).");
    expect(email.text).toContain("Review list: 0 items open.");
    expect(email.text).toContain("Coming up, Nov 8 to Nov 14:\nNo Recurring charges are due.\n");
  });

  it("says every Budget is on track when none is over or on pace", async () => {
    await draft([monthly("Clothing", 5_000)]);
    await load([spend("small", "2026-11-03", 20, "Clothing")]);
    expect((await build()).text).toContain(
      "Budgets in November 2026:\nEvery Budget is on track.\n",
    );
  });

  it(`lists at most ${COMING_UP_SHOWN} Recurring charges coming up, then how many more`, async () => {
    await load([spend("one", "2026-10-03", 5, "Clothing")]);
    await storeCharges(
      Array.from({ length: COMING_UP_SHOWN + 3 }, (_, index) =>
        charge(`Service ${String(index + 1).padStart(2, "0")}`, "2026-11-10", 5),
      ),
    );
    const text = (await build()).text;
    expect(text).toContain("- Nov 10: Service 10, $5.00\n- and 3 more\n");
    expect(text).not.toContain("Service 11");
  });
});
