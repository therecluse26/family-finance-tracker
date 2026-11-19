import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { TxnRecord } from "./adapter.ts";
import {
  DEMO_BANKS,
  DEMO_FIRST_DAY,
  DEMO_LAST_DAY,
  DEMO_MEMBERS,
  DEMO_PINECREST,
  demoRecords,
  seedDemoHousehold,
} from "./demo.ts";
import { newTestBank, type TestBank } from "./testing.ts";

// The demo Household fixture: its records, the cases it holds, and a seed through the fake
// adapter into a new app.db.

const calendarDate = z.string().refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && date.toISOString().startsWith(value);
}, "a real date written YYYY-MM-DD");

// TxnRecord, field by field, as a check that runs.
const txnRecord = z.strictObject({
  id: z.string().min(1),
  accountId: z.string().min(1),
  amount: z.number().int().refine(Number.isSafeInteger),
  postedDate: calendarDate,
  authorizedDate: calendarDate.nullable(),
  pending: z.boolean(),
  pendingTransactionId: z.string().min(1).nullable(),
  description: z.string().min(1),
  merchantName: z.string().min(1).nullable(),
  merchantId: z.string().min(1).nullable(),
  counterparties: z.array(z.strictObject({ name: z.string().min(1), type: z.string().min(1) })),
  category: z
    .strictObject({
      name: z.string().min(1),
      confidence: z.string().nullable(),
      version: z.string().nullable(),
      mcc: z.string().nullable(),
    })
    .nullable(),
  raw: z.unknown(),
});

// The schema and TxnRecord name the same fields with the same types.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameShape: Same<z.infer<typeof txnRecord>, TxnRecord> = true;

const records = demoRecords();
const byDescription = (pattern: RegExp) => records.filter((txn) => pattern.test(txn.description));
const accountOf = (bankId: string) => DEMO_BANKS.find((bank) => bank.bankId === bankId);

describe("the demo Household fixture", () => {
  it("checks every record against TxnRecord", () => {
    expect(sameShape).toBe(true);
    expect(records.length).toBeGreaterThan(700);
    for (const record of records) expect(txnRecord.safeParse(record).error).toBeUndefined();
  });

  it("gives each record a unique ID, on an Account of its own bank, inside the 18 months", () => {
    expect(new Set(records.map((txn) => txn.id)).size).toBe(records.length);
    for (const bank of DEMO_BANKS) {
      const ids = new Set(bank.accounts.map((account) => account.id));
      for (const page of bank.pages) {
        for (const txn of page.added ?? []) expect(ids.has(txn.accountId)).toBe(true);
      }
    }
    const dates = records.map((txn) => txn.postedDate).sort();
    expect([dates[0], dates.at(-1)]).toEqual([DEMO_FIRST_DAY, DEMO_LAST_DAY]);
    expect(records.some((txn) => txn.raw === null)).toBe(false);
  });

  it("has the example banks as fake Connections, and no Pinecrest", () => {
    expect(
      DEMO_BANKS.map((bank) => [
        bank.bankName,
        bank.accounts.map((account) => `${account.type} ${account.subtype}`),
      ]),
    ).toEqual([
      ["Ally Bank", ["depository checking", "depository savings"]],
      ["Capital One", ["credit credit card"]],
      ["Chase", ["credit credit card"]],
      ["Synchrony Bank", ["credit credit card"]],
      ["Larkspur", ["loan personal"]],
    ]);
    expect(DEMO_BANKS.some((bank) => /pinecrest/i.test(bank.bankName))).toBe(false);
  });

  it("gives each card APRs, a statement balance, a minimum payment, and a due date, and the loan no details", () => {
    const cards = DEMO_BANKS.flatMap((bank) => bank.accounts).filter((a) => a.type === "credit");
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.card?.aprs.length).toBeGreaterThan(0);
      expect(card.card?.statementBalance).toEqual(expect.any(Number));
      expect(card.card?.minimumPayment).toEqual(expect.any(Number));
      expect(card.card?.dueDate).toMatch(/^2026-11-\d{2}$/);
    }
    const [loan] = accountOf("fake-larkspur")?.accounts ?? [];
    expect(loan).toMatchObject({ subtype: "personal", loan: null, card: null });
    expect(loan?.currentBalance).toBeLessThan(0);
  });

  it("has two Members with first and last names, and Zelle lines that name one", () => {
    expect(DEMO_MEMBERS.map((member) => `${member.firstName} ${member.lastName}`)).toEqual([
      "Jamie Rivera",
      "Alex Rivera",
    ]);
    for (const member of DEMO_MEMBERS) {
      const name = `${member.firstName} ${member.lastName}`.toUpperCase();
      expect(byDescription(new RegExp(`^Zelle payment (to|from) ${name} `))).not.toHaveLength(0);
    }
  });

  it("holds each case later tickets test", () => {
    const checking = accountOf("fake-ally")?.accounts[0]?.id;
    const category = (name: string) => records.filter((txn) => txn.category?.name === name);

    // Paychecks every 2 weeks.
    const paychecks = byDescription(/^NORTHWIND LOGISTICS PAYROLL/);
    expect(paychecks.length).toBeGreaterThanOrEqual(38);
    // Card payments from Ally: with the card's last 4 digits, and with only the bank's name.
    const payments = category("LOAN_PAYMENTS_CREDIT_CARD_PAYMENT").filter(
      (txn) => txn.accountId === checking,
    );
    expect(payments.some((txn) => txn.description.includes("7731"))).toBe(true);
    expect(payments.some((txn) => txn.description.includes("5520"))).toBe(true);
    expect(payments.some((txn) => txn.description === "CAPITAL ONE MOBILE PMT")).toBe(true);
    // Larkspur's payout and monthly payments.
    expect(category("LOAN_DISBURSEMENTS_PERSONAL")).toHaveLength(1);
    expect(byDescription(/^LARKSPUR LOAN PMT/).length).toBeGreaterThanOrEqual(12);
    // Transfers to Pinecrest with "transfer" wording.
    expect(byDescription(/TRANSFER TO PINECREST BANK XXXXXX6014$/).length).toBeGreaterThanOrEqual(
      18,
    );
    expect(DEMO_PINECREST.mask).toBe("6014");
    // A monthly Recurring charge with one Price increase, and a yearly one.
    const streaming = byDescription(/^STREAMFLIX/);
    expect(new Set(streaming.map((txn) => txn.amount))).toEqual(new Set([-1_549, -1_799]));
    expect(byDescription(/ANNUAL MEMBERSHIP$/).map((txn) => txn.postedDate)).toEqual([
      "2025-06-14",
      "2026-06-14",
    ]);
    // Venmo and Zelle lines, and an ATM withdrawal.
    for (const pattern of [/^VENMO PAYMENT/, /^VENMO CASHOUT/, /^VENMO ADDFUNDS/, /^Zelle/]) {
      expect(byDescription(pattern)).not.toHaveLength(0);
    }
    expect(category("TRANSFER_OUT_WITHDRAWAL").length).toBeGreaterThan(0);
    // Refunds, card interest, and a late fee.
    expect(byDescription(/RETURN$|REFUND$/).every((txn) => txn.amount > 0)).toBe(true);
    expect(byDescription(/RETURN$|REFUND$/)).toHaveLength(2);
    expect(category("BANK_FEES_INTEREST_CHARGE").length).toBeGreaterThan(0);
    expect(category("BANK_FEES_LATE_PAYMENT")).toHaveLength(1);
    // One Duplicate charge, and one Large purchase.
    const duplicates = records.filter(
      (txn) => txn.postedDate === "2026-03-07" && txn.description === "SQ *BLUE DOOR CAFE",
    );
    expect(duplicates).toHaveLength(2);
    const purchases = records.filter((txn) => !/^(LOAN|TRANSFER)_/.test(txn.category?.name ?? ""));
    expect(Math.min(...purchases.map((txn) => txn.amount))).toBe(-274_900);
    // Pending-to-posted pairs: each posted record points back to a pending one.
    const pendingIds = new Set(records.filter((txn) => txn.pending).map((txn) => txn.id));
    const postedPairs = records.filter((txn) => txn.pendingTransactionId !== null);
    expect(postedPairs).toHaveLength(3);
    for (const txn of postedPairs)
      expect(pendingIds.has(txn.pendingTransactionId ?? "")).toBe(true);
    // Provider categories with every confidence level.
    expect(new Set(records.map((txn) => txn.category?.confidence))).toEqual(
      new Set(["VERY_HIGH", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]),
    );
  });
});

describe("seeding the demo Household", () => {
  let bank: TestBank;
  const count = async (sql: string) =>
    Number((await bank.database.$client.execute(sql)).rows[0]?.n);
  const now = () => new Date("2026-11-01T14:00:00.000Z");

  beforeEach(async () => {
    bank = await newTestBank();
  });

  afterEach(() => {
    bank.close();
  });

  it("loads the fixture through the fake adapter into a new app.db", async () => {
    await seedDemoHousehold(bank.database, bank.fake, now);

    expect(await count("SELECT count(*) AS n FROM connections WHERE provider = 'fake'")).toBe(5);
    expect(await count("SELECT count(*) AS n FROM connections WHERE history_loaded = 1")).toBe(5);
    expect(await count("SELECT count(*) AS n FROM household_accounts")).toBe(6);
    expect(await count("SELECT count(*) AS n FROM transactions")).toBe(762);
    // The 3 pending Transactions that posted are hidden with the reason "posted".
    expect(
      await count("SELECT count(*) AS n FROM transactions WHERE hidden_reason = 'posted'"),
    ).toBe(3);
    expect(await count("SELECT count(*) AS n FROM transactions WHERE hidden_reason IS NULL")).toBe(
      759,
    );
    expect(
      await count(
        "SELECT count(*) AS n FROM transactions WHERE pending = 1 AND hidden_reason IS NULL",
      ),
    ).toBe(2);
    expect(await count("SELECT count(*) AS n FROM daily_balances")).toBe(6);
  });

  // Spec 04, Names: the sync names each card payment line by its bank, with no last 4, and leaves
  // no clean name ending in a lead-in such as "ACCT ENDING".
  it("names the card payments by their bank through the sync", async () => {
    await seedDemoHousehold(bank.database, bank.fake, now);
    const names = async (sql: string) =>
      (await bank.database.$client.execute(sql)).rows.map((row) => String(row.name));

    expect(
      await names(
        `SELECT DISTINCT merchant_clean_name AS name FROM transactions
         WHERE provider_category = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' ORDER BY name`,
      ),
    ).toEqual([
      "Capital One card payment",
      "Card payment",
      "Chase card payment",
      "Synchrony Bank card payment",
    ]);
    const all = await names(
      "SELECT DISTINCT merchant_clean_name AS name FROM transactions WHERE merchant_clean_name IS NOT NULL",
    );
    expect(all.filter((name) => /\b(?:ending|in|acct|account)$/i.test(name))).toEqual([]);
  });

  it("adds nothing when it runs again", async () => {
    await seedDemoHousehold(bank.database, bank.fake, now);
    await seedDemoHousehold(bank.database, bank.fake, now);

    expect(await count("SELECT count(*) AS n FROM connections")).toBe(5);
    expect(await count("SELECT count(*) AS n FROM transactions")).toBe(762);
  });
});
