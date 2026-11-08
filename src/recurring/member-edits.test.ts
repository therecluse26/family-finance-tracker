import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { connectionRemoving, syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { correctCategory, startCategorization } from "../categorization/index.ts";
import { editRecurringCharge, replaceRecurringCharges } from "../db/index.ts";
import { registerFollowUpStep, runFollowUp } from "../follow-up/index.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import {
  addChargeTransaction,
  addMonths,
  chargeCandidates,
  deleteChargePriceChange,
  editCharge,
  endCharge,
  type RecurringCharge,
  recurringCharges,
  removeChargeTransaction,
  setChargePriceChange,
  startRecurringCharges,
} from "./index.ts";

// A Member's edits to a Recurring charge (spec 06, Member edits), through the recurring module's
// interface: a name, a Category, a price band, price changes, and adding or removing a Transaction.
// Each one is kept through the checks after every sync. Transactions arrive through the fake
// adapter, and the follow-up job runs Matching, Categorization, then the checks.

const BANK = "fake-first-bank";
const MEMBER = "member-1";
const CARD = fakeAccount({
  id: "acc-card",
  name: "Everyday Card",
  type: "credit",
  subtype: "credit card",
});

describe("a Member's edits to a Recurring charge", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let atStart: () => Promise<void>;
  let connectionId: string;
  let now: Date;
  const clock = () => now;

  // A posted Streamly charge on the card, in whole cents spent.
  const charge = (
    id: string,
    postedDate: string,
    spent: number,
    fields: Partial<TxnRecord> = {},
  ): TxnRecord =>
    fakeTxn({
      id,
      accountId: CARD.id,
      amount: -spent,
      postedDate,
      merchantName: "Streamly",
      category: {
        name: "ENTERTAINMENT_TV_AND_MOVIES",
        confidence: "HIGH",
        version: "v2",
        mcc: null,
      },
      ...fields,
    });
  // A Privacy.com line, a masked Merchant: its series match exact cents.
  const masked = (id: string, postedDate: string, spent: number) =>
    charge(id, postedDate, spent, { merchantName: null, description: "PRIVACY.COM" });
  // A sync, then its follow-up job, then the job the checks ask for when a Transaction joins a
  // Recurring charge with a Member's Category, so the cascade runs on it again.
  const sync = async (...txns: TxnRecord[]) => {
    bank.fake.addPages(BANK, { added: txns });
    await syncConnection(connectionId, clock);
    await runFollowUp(clock);
    await runAsked();
  };
  // The follow-up jobs the app asked for, as a job runner would run them: at most 5.
  const runAsked = async () => {
    for (let run = 0; run < 5; run += 1) {
      const asked = bank.followUpsAsked();
      await runFollowUp(clock);
      if (bank.followUpsAsked() === asked) return;
    }
    throw new Error("The follow-up jobs did not settle.");
  };
  const charges = () => recurringCharges(bank.database, now);
  const only = async (): Promise<RecurringCharge> => {
    const [first, ...rest] = await charges();
    if (first === undefined || rest.length > 0) throw new Error("Expected one Recurring charge.");
    return first;
  };
  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ?",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  const providerIds = async (ids: readonly string[]) => {
    const rows = await bank.database.$client.execute(
      "SELECT id, provider_transaction_id AS provider FROM transactions",
    );
    const byId = new Map(rows.rows.map((row) => [String(row.id), String(row.provider)]));
    return ids.map((id) => byId.get(id));
  };
  // Each Transaction in the Recurring charge, by provider ID, with its amount.
  const members = async (each?: RecurringCharge) => {
    const found = each ?? (await only());
    const ids = await providerIds(found.priceHistory.map((entry) => entry.transactionId));
    return found.priceHistory.map((entry, at) => `${ids[at]} ${entry.amount}`);
  };
  // The first part's Category, and the step that chose it.
  const chosen = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: `SELECT p.category, p.category_source AS source
            FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id
            WHERE t.provider_transaction_id = ? ORDER BY p.part`,
      args: [providerId],
    });
    const [row] = rows.rows;
    return row === undefined ? undefined : `${row.category} (${row.source})`;
  };
  // Spending by Category, in whole cents: the totals the Budgets read.
  const byCategory = async () => {
    const rows = await bank.database.$client.execute(
      `SELECT p.category, -SUM(p.amount) AS spent FROM transaction_parts p
       JOIN transactions t ON t.id = p.transaction_id
       WHERE t.hidden_reason IS NULL AND p.type = 'Spending' GROUP BY p.category ORDER BY p.category`,
    );
    return Object.fromEntries(rows.rows.map((row) => [String(row.category), Number(row.spent)]));
  };
  const edited = (result: unknown): RecurringCharge => {
    if (typeof result === "string") throw new Error(`The edit did not apply: ${result}`);
    return result as RecurringCharge;
  };

  beforeEach(async () => {
    now = new Date("2026-11-01T14:00:00.000Z");
    bank = await newTestBank();
    const recurring = startRecurringCharges({ database: bank.database, now: clock });
    atStart = recurring.atStart;
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database }).stop,
      recurring.stop,
    ];
    connectionId = await bank.connect(BANK);
    bank.fake.addPages(BANK, { accounts: [CARD] });
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('${MEMBER}', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    );
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  it("keeps the owner's example through a sync after each edit: $25 Visible Wireless, then $45", async () => {
    // $25 a month on the 5th through Privacy.com, July to October.
    await sync(...[0, 1, 2, 3].map((at) => masked(`v${at}`, addMonths("2026-07-05", at), 2_500)));
    const found = await only();
    expect(found.merchant.name).toBe("Privacy.com");

    edited(
      await editCharge(
        bank.database,
        found.id,
        { name: "Visible Wireless", category: "Phone and internet" },
        now,
      ),
    );
    await runFollowUp(clock);
    await sync();
    expect(await only()).toMatchObject({
      id: found.id,
      name: "Visible Wireless",
      category: "Phone and internet",
      categoryByHand: true,
    });
    for (const id of ["v0", "v1", "v2", "v3"]) {
      expect(await chosen(id)).toBe("Phone and internet (Recurring charge)");
    }

    // "$45 from Nov 5": the next one is at $45 at once.
    const set = edited(
      await setChargePriceChange(
        bank.database,
        found.id,
        { fromDate: "2026-11-05", amount: 4_500 },
        now,
      ),
    );
    expect(set.latestAmount).toBe(4_500);
    expect(set.priceChanges).toEqual([
      { id: expect.any(String), fromDate: "2026-11-05", amount: 4_500, byHand: true },
    ]);
    await sync();

    // A masked Merchant's price change joins at its first $45 charge, since the Member set it.
    now = new Date("2026-11-20T14:00:00.000Z");
    await sync(masked("v4", "2026-11-05", 4_500));
    expect(await members()).toEqual(["v0 2500", "v1 2500", "v2 2500", "v3 2500", "v4 4500"]);
    now = new Date("2026-12-20T14:00:00.000Z");
    await sync(masked("v5", "2026-12-05", 4_500));

    const after = await only();
    expect(await members(after)).toEqual([
      "v0 2500",
      "v1 2500",
      "v2 2500",
      "v3 2500",
      "v4 4500",
      "v5 4500",
    ]);
    expect(after).toMatchObject({
      id: found.id,
      name: "Visible Wireless",
      category: "Phone and internet",
      latestAmount: 4_500,
      status: "active",
    });
    expect(after.priceChanges.filter((change) => change.byHand)).toHaveLength(1);
    expect(await chosen("v5")).toBe("Phone and internet (Recurring charge)");
  });

  it("joins the Transactions since a price change with a past start date, and keeps them", async () => {
    now = new Date("2026-10-20T14:00:00.000Z");
    await sync(
      ...[0, 1, 2].map((at) => masked(`v${at}`, addMonths("2026-07-05", at), 2_500)),
      // One charge at $45 is no price change for a masked Merchant until a second shows it.
      masked("v3", "2026-10-05", 4_500),
    );
    const found = await only();
    expect(await members()).toEqual(["v0 2500", "v1 2500", "v2 2500"]);

    edited(
      await setChargePriceChange(
        bank.database,
        found.id,
        { fromDate: "2026-10-01", amount: 4_500 },
        now,
      ),
    );
    expect(await members()).toEqual(["v0 2500", "v1 2500", "v2 2500", "v3 4500"]);
    await runFollowUp(clock);
    await sync();
    expect(await members()).toEqual(["v0 2500", "v1 2500", "v2 2500", "v3 4500"]);

    // Deleting it leaves the $45 charge out again, as the checks found before.
    const [change] = (await only()).priceChanges.filter((each) => each.byHand);
    edited(await deleteChargePriceChange(bank.database, found.id, change?.id ?? "", now));
    await sync();
    expect(await members()).toEqual(["v0 2500", "v1 2500", "v2 2500"]);
    expect(await deleteChargePriceChange(bank.database, found.id, "no-such-id", now)).toBe(
      "no price change",
    );
  });

  it("records a price change the checks find, at any amount and 2 in a row", async () => {
    now = new Date("2026-12-20T14:00:00.000Z");
    await sync(
      ...[0, 1, 2].map((at) => charge(`s${at}`, addMonths("2026-07-03", at), 1_549)),
      charge("s3", "2026-10-03", 1_799),
      ...[0, 1, 2].map((at) => masked(`p${at}`, addMonths("2026-07-12", at), 999)),
      masked("p3", "2026-10-12", 1_299),
      masked("p4", "2026-11-12", 1_299),
    );

    const changes = (await charges()).map((each) => [
      each.merchant.name,
      each.priceChanges.map((change) => `${change.fromDate} ${change.amount} ${change.byHand}`),
    ]);
    expect(changes).toEqual(
      expect.arrayContaining([
        ["Streamly", ["2026-10-03 1799 false"]],
        ["Privacy.com", ["2026-10-12 1299 false"]],
      ]),
    );
    // A Member deletes only their own price change.
    const streamly = (await charges()).find((each) => each.merchant.name === "Streamly");
    const [found] = streamly?.priceChanges ?? [];
    expect(
      await deleteChargePriceChange(bank.database, streamly?.id ?? "", found?.id ?? "", now),
    ).toBe("no price change");
    expect((await charges()).find((each) => each.id === streamly?.id)?.priceChanges).toEqual(
      streamly?.priceChanges,
    );
  });

  it("keeps a removed Transaction out after each sync, and sends it through the cascade again", async () => {
    await sync(...[0, 1, 2, 3].map((at) => charge(`s${at}`, addMonths("2026-07-03", at), 1_549)));
    const found = await only();
    edited(await editCharge(bank.database, found.id, { category: "Phone and internet" }, now));
    await runFollowUp(clock);
    expect(await chosen("s1")).toBe("Phone and internet (Recurring charge)");

    const removed = edited(
      await removeChargeTransaction(bank.database, found.id, await idOf("s1"), now),
    );
    expect(removed.priceHistory).toHaveLength(3);
    await runFollowUp(clock);
    // It takes the Category it would have with no Recurring charge.
    expect(await chosen("s1")).toBe("Entertainment (provider)");

    now = new Date("2026-12-01T14:00:00.000Z");
    await sync(charge("s4", "2026-11-03", 1_549));
    expect(await members()).toEqual(["s0 1549", "s2 1549", "s3 1549", "s4 1549"]);
    expect(await chosen("s1")).toBe("Entertainment (provider)");
    expect(await chosen("s4")).toBe("Phone and internet (Recurring charge)");
    // It is one a Member may add back.
    const candidates = await chargeCandidates(bank.database, found.id);
    expect(candidates).toEqual({
      more: false,
      candidates: [
        { transactionId: await idOf("s1"), date: "2026-08-03", amount: 1_549, removedByHand: true },
      ],
    });
  });

  it("never lists a Transaction in an ended Recurring charge among the charges to add", async () => {
    await sync(
      ...[0, 1, 2, 3].map((at) => masked(`a${at}`, addMonths("2026-07-05", at), 2_500)),
      ...[0, 1, 2, 3].map((at) => masked(`b${at}`, addMonths("2026-07-20", at), 4_500)),
      masked("one-off", "2026-09-12", 1_234),
    );
    const all = await charges();
    const a = all.find((each) => each.latestAmount === 2_500);
    const b = all.find((each) => each.latestAmount === 4_500);
    if (a === undefined || b === undefined) throw new Error("Expected 2 Recurring charges.");
    const listed = async () => {
      const page = await chargeCandidates(bank.database, a.id);
      if (page === undefined || typeof page === "string") throw new Error("No page.");
      return providerIds(page.candidates.map((each) => each.transactionId));
    };
    expect(await listed()).toEqual(["b3", "b2", "one-off", "b1", "b0"]);

    await endCharge(bank.database, b.id, MEMBER, now);
    expect(await listed()).toEqual(["one-off"]);
  });

  it("lists the charges to add a page at a time: removed ones first, then 50, newest first, at one amount", async () => {
    // Privacy.com lines at other amounts, one a day back from Oct 31, and 3 at $12.34.
    const lines = Array.from({ length: 130 }, (_, at) => {
      const day = new Date(Date.UTC(2026, 9, 31) - at * 86_400_000).toISOString().slice(0, 10);
      return masked(`r${at}`, day, [10, 70, 120].includes(at) ? 1_234 : 2_000 + at * 3);
    });
    await sync(
      ...[0, 1, 2, 3, 4, 5].map((at) => masked(`v${at}`, addMonths("2026-05-05", at), 2_500)),
      ...lines,
    );
    const found = (await charges()).find((each) => each.latestAmount === 2_500);
    if (found === undefined) throw new Error("Expected the $25 Recurring charge.");
    edited(await removeChargeTransaction(bank.database, found.id, await idOf("v1"), now));
    const page = async (filter: { amount?: number; before?: string } = {}) => {
      const answer = await chargeCandidates(bank.database, found.id, filter);
      if (answer === undefined || typeof answer === "string") throw new Error(`No page: ${answer}`);
      const ids = await providerIds(answer.candidates.map((each) => each.transactionId));
      return { ids, more: answer.more, last: answer.candidates.at(-1)?.transactionId };
    };
    const newest = lines.map((txn) => txn.id);

    const first = await page();
    expect(first.ids).toEqual(["v1", ...newest.slice(0, 50)]);
    expect(first.more).toBe(true);
    const second = await page({ before: first.last });
    expect(second.ids).toEqual(newest.slice(50, 100));
    expect(second.more).toBe(true);
    const third = await page({ before: second.last });
    expect(third.ids).toEqual(newest.slice(100));
    expect(third.more).toBe(false);

    // An exact amount. The removed one still comes first, at any amount.
    expect(await page({ amount: 1_234 })).toMatchObject({
      ids: ["v1", "r10", "r70", "r120"],
      more: false,
    });
    expect((await page({ amount: 1_235 })).ids).toEqual(["v1"]);
    expect(await chargeCandidates(bank.database, found.id, { before: "no-such-id" })).toBe(
      "no Transaction",
    );
    // One in it is never listed, on any page.
    const inIt = await providerIds(found.priceHistory.map((entry) => entry.transactionId));
    for (const each of [first, second, third]) {
      expect(each.ids.filter((id) => id !== "v1" && inIt.includes(id))).toEqual([]);
    }
  });

  it("still sends the Transactions through the cascade again when the find after an edit fails", async () => {
    await sync(...[0, 1, 2, 3].map((at) => charge(`s${at}`, addMonths("2026-07-03", at), 1_549)));
    const found = await only();
    // The find fails as it rewrites the rows the checks wrote.
    await bank.database.$client.execute(
      `CREATE TRIGGER find_fails BEFORE DELETE ON recurring_charge_transactions
       WHEN OLD.by_hand IS NULL BEGIN SELECT RAISE(ABORT, 'find failed'); END`,
    );
    const asked = bank.followUpsAsked();
    await expect(
      editCharge(bank.database, found.id, { category: "Phone and internet" }, now),
    ).rejects.toThrow();
    expect(bank.followUpsAsked()).toBe(asked + 1);
    await bank.database.$client.execute("DROP TRIGGER find_fails");

    // The retry: the follow-up job the edit asked for.
    await runAsked();
    expect(await chosen("s0")).toBe("Phone and internet (Recurring charge)");
    expect(await chosen("s3")).toBe("Phone and internet (Recurring charge)");
    expect(await members()).toEqual(["s0 1549", "s1 1549", "s2 1549", "s3 1549"]);
  });

  it("keeps an added Transaction in after each sync, until the bank removes it", async () => {
    await sync(
      ...[0, 1, 2].map((at) => charge(`s${at}`, addMonths("2026-07-03", at), 1_549)),
      // A one-off at another price, off the schedule.
      charge("extra", "2026-09-20", 4_000),
    );
    const found = await only();
    expect(await chargeCandidates(bank.database, found.id)).toEqual({
      more: false,
      candidates: [
        {
          transactionId: await idOf("extra"),
          date: "2026-09-20",
          amount: 4_000,
          removedByHand: false,
        },
      ],
    });

    const added = edited(
      await addChargeTransaction(bank.database, found.id, await idOf("extra"), now),
    );
    expect(added.addedByHand).toEqual([await idOf("extra")]);
    await runFollowUp(clock);
    await sync(charge("s3", "2026-10-03", 1_549));
    expect(await members()).toEqual(["s0 1549", "s1 1549", "s2 1549", "extra 4000", "s3 1549"]);
    // The latest amount stays its last Transaction's.
    expect((await only()).latestAmount).toBe(1_549);

    bank.fake.addPages(BANK, { removed: [{ id: "extra" }] });
    await syncConnection(connectionId, clock);
    await runFollowUp(clock);
    expect(await members()).toEqual(["s0 1549", "s1 1549", "s2 1549", "s3 1549"]);
  });

  it("gives a Transaction that joins its Member's Category before the later steps of the same job", async () => {
    const seen: string[] = [];
    const stopSpy = registerFollowUpStep("overspending checks", async (unhandled) => {
      const ids = await providerIds(unhandled);
      for (const id of ids) seen.push(`${id} ${await chosen(id ?? "")}`);
      return undefined;
    });
    stops.push(stopSpy);
    await sync(
      ...[0, 1, 2].map((at) => charge(`s${at}`, addMonths("2026-07-03", at), 1_549)),
      charge("store", "2026-09-20", 4_000),
    );
    await correctCategory(bank.database, await idOf("store"), "Hobbies", {
      onlyThisTransaction: false,
      memberId: MEMBER,
    });
    await runAsked();
    const found = (await charges()).find((each) => each.latestAmount === 1_549);
    edited(
      await editCharge(bank.database, found?.id ?? "", { category: "Phone and internet" }, now),
    );
    await runAsked();
    seen.length = 0;

    now = new Date("2026-10-05T14:00:00.000Z");
    bank.fake.addPages(BANK, { added: [charge("s3", "2026-10-03", 1_549)] });
    await syncConnection(connectionId, clock);
    await runFollowUp(clock);
    expect(await chosen("s3")).toBe("Phone and internet (Recurring charge)");
    expect(seen).toEqual(["s3 Phone and internet (Recurring charge)"]);
    seen.length = 0;
    await runAsked();
    expect(await chosen("s3")).toBe("Phone and internet (Recurring charge)");
    expect(await chosen("store")).toBe("Hobbies (hand-set)");
  });

  it("keeps a hand-set Category on a Transaction that joins one with a Member's Category", async () => {
    now = new Date("2026-11-20T14:00:00.000Z");
    await sync(
      ...[0, 1, 2, 3].map((at) => masked(`a${at}`, addMonths("2026-07-05", at), 2_500)),
      masked("a4", "2026-11-05", 2_600),
    );
    await correctCategory(bank.database, await idOf("a4"), "Hobbies", {
      onlyThisTransaction: true,
      memberId: MEMBER,
    });
    await runAsked();
    const found = await only();
    edited(await editCharge(bank.database, found.id, { category: "Phone and internet" }, now));
    await runAsked();

    // A band of 10% takes a4 in. Its Category is the Member's own.
    const wider = edited(await editCharge(bank.database, found.id, { priceBand: 100 }, now));
    expect(await members(wider)).toEqual(["a0 2500", "a1 2500", "a2 2500", "a3 2500", "a4 2600"]);
    expect(await chosen("a4")).toBe("Hobbies (hand-set)");
    expect(await chosen("a3")).toBe("Phone and internet (Recurring charge)");
    await runAsked();
    expect(await chosen("a4")).toBe("Hobbies (hand-set)");
  });

  // Two Privacy.com series: A at $25 from Jul 5, and B at $45 from 0, 1 or 2 days later. One of
  // them stops after Oct while the other goes on. The one that stops is named, or both are, and
  // either A or B stops, so the edited ones are checked in both orders.
  const MERGE_CASES = [
    ["on the same day", "2026-07-05"],
    ["a day apart", "2026-07-06"],
    ["2 days apart", "2026-07-07"],
  ].flatMap(([apart, from]) =>
    (["A", "B"] as const).flatMap((stops) =>
      (["the one that stops", "both"] as const).map(
        (names) =>
          [`${apart}, ${stops} stops, ${names} named`, { from: from ?? "", stops, names }] as const,
      ),
    ),
  );
  it.each(MERGE_CASES)(
    "never takes another masked series' charges as a price change: %s",
    async (_, { from, stops, names }) => {
      now = new Date("2027-01-20T14:00:00.000Z");
      const a = [0, 1, 2, 3, 4, 5, 6].map((at) =>
        masked(`a${at}`, addMonths("2026-07-05", at), 2_500),
      );
      const b = [0, 1, 2, 3, 4, 5, 6].map((at) => masked(`b${at}`, addMonths(from, at), 4_500));
      const [stopping, going] = stops === "A" ? [a, b] : [b, a];
      const amountOf = (txns: TxnRecord[]) => -(txns[0]?.amount ?? 0);
      await sync(...a.slice(0, 4), ...b.slice(0, 4));
      const byAmount = async (txns: TxnRecord[]) => {
        const found = (await charges()).find((each) => each.latestAmount === amountOf(txns));
        if (found === undefined) throw new Error("Expected the series' Recurring charge.");
        return found;
      };
      const stopped = await byAmount(stopping);
      const goes = await byAmount(going);
      edited(await editCharge(bank.database, stopped.id, { name: "Visible Wireless" }, now));
      if (names === "both") {
        edited(await editCharge(bank.database, goes.id, { name: "Streaming" }, now));
      }
      await runAsked();

      await sync(...going.slice(4));
      const after = await charges();
      const stoppedAfter = after.find((each) => each.id === stopped.id);
      const goesAfter = after.find((each) => each.id === goes.id);
      expect(after).toHaveLength(2);
      expect(stoppedAfter?.status).toBe("inactive");
      expect(await members(stoppedAfter)).toEqual(
        stopping.slice(0, 4).map((txn) => `${txn.id} ${amountOf(stopping)}`),
      );
      expect(goesAfter?.status).toBe("active");
      expect(await members(goesAfter)).toEqual(going.map((txn) => `${txn.id} ${amountOf(going)}`));
    },
  );

  it("takes a Member's Category before the Merchant's Category rule, and never over a hand-set one", async () => {
    await sync(
      ...[0, 1, 2].map((at) => charge(`s${at}`, addMonths("2026-07-03", at), 1_549)),
      charge("store", "2026-09-20", 4_000),
    );
    // A Category rule for Streamly, from a Member's Category on a Transaction outside it.
    await correctCategory(bank.database, await idOf("store"), "Hobbies", {
      onlyThisTransaction: false,
      memberId: MEMBER,
    });
    await runFollowUp(clock);
    expect(await chosen("s0")).toBe("Hobbies (Category rule)");

    const found = await only();
    edited(await editCharge(bank.database, found.id, { category: "Phone and internet" }, now));
    await runFollowUp(clock);
    await sync();
    expect(await chosen("s0")).toBe("Phone and internet (Recurring charge)");
    expect(await chosen("store")).toBe("Hobbies (hand-set)");

    // A Category a Member sets on one of its Transactions wins.
    await correctCategory(bank.database, await idOf("s1"), "Gifts and donations", {
      onlyThisTransaction: true,
      memberId: MEMBER,
    });
    await runFollowUp(clock);
    await sync(charge("s3", "2026-10-03", 1_549));
    expect(await chosen("s1")).toBe("Gifts and donations (hand-set)");
    expect(await chosen("s3")).toBe("Phone and internet (Recurring charge)");

    // Clearing it gives the Category rule back.
    edited(await editCharge(bank.database, found.id, { category: null }, now));
    await runFollowUp(clock);
    expect(await chosen("s0")).toBe("Hobbies (Category rule)");
    expect(await chosen("s3")).toBe("Hobbies (Category rule)");
    expect(await chosen("s1")).toBe("Gifts and donations (hand-set)");
  });

  it("takes a price band in place of 7.5% for the price changes it shows", async () => {
    now = new Date("2026-12-20T14:00:00.000Z");
    await sync(
      ...[0, 1, 2].map((at) => charge(`s${at}`, addMonths("2026-07-03", at), 1_000)),
      charge("s3", "2026-10-03", 1_050),
    );
    const found = await only();
    // 5% is within 7.5%, so no price change.
    expect(found.priceChanges).toEqual([]);
    expect(found.defaultPriceBand).toBe(75);

    // In tenths of a percent: 2%.
    edited(await editCharge(bank.database, found.id, { priceBand: 20 }, now));
    await sync();
    expect((await only()).priceBand).toBe(20);
    expect(await members()).toEqual(["s0 1000", "s1 1000", "s2 1000", "s3 1050"]);
    expect((await only()).priceChanges).toEqual([
      { id: expect.any(String), fromDate: "2026-10-03", amount: 1_050, byHand: false },
    ]);

    // 10%, wider than the change, so none.
    edited(await editCharge(bank.database, found.id, { priceBand: 100 }, now));
    await sync();
    expect((await only()).priceChanges).toEqual([]);
  });

  it("moves each edit through a sync and back, with the same totals before and after", async () => {
    await sync(
      ...[0, 1, 2, 3].map((at) => charge(`s${at}`, addMonths("2026-07-03", at), 1_549)),
      charge("extra", "2026-09-20", 4_000),
    );
    const found = await only();
    const total = async () => (await only()).priceHistory.reduce((sum, e) => sum + e.amount, 0);
    const before = { categories: await byCategory(), total: await total() };
    expect(before.total).toBe(4 * 1_549);

    // A Category, then back.
    edited(await editCharge(bank.database, found.id, { category: "Phone and internet" }, now));
    await runFollowUp(clock);
    await sync();
    expect(await byCategory()).toEqual({ Entertainment: 4_000, "Phone and internet": 4 * 1_549 });
    edited(await editCharge(bank.database, found.id, { category: null }, now));
    await runFollowUp(clock);
    await sync();
    expect(await byCategory()).toEqual(before.categories);

    // A removal, then an add of the same one.
    const s2 = await idOf("s2");
    edited(await removeChargeTransaction(bank.database, found.id, s2, now));
    await sync();
    expect(await total()).toBe(3 * 1_549);
    edited(await addChargeTransaction(bank.database, found.id, s2, now));
    await sync();
    expect(await total()).toBe(before.total);
    expect(await members()).toEqual(["s0 1549", "s1 1549", "s2 1549", "s3 1549"]);

    // An add, then a removal.
    const extra = await idOf("extra");
    edited(await addChargeTransaction(bank.database, found.id, extra, now));
    await sync();
    expect(await total()).toBe(before.total + 4_000);
    edited(await removeChargeTransaction(bank.database, found.id, extra, now));
    await sync();
    expect(await total()).toBe(before.total);

    // The name, the band, and a price change, then each cleared.
    edited(await editCharge(bank.database, found.id, { name: "Movies", priceBand: 20 }, now));
    const set = edited(
      await setChargePriceChange(
        bank.database,
        found.id,
        { fromDate: "2026-11-03", amount: 1_999 },
        now,
      ),
    );
    await sync();
    expect((await only()).latestAmount).toBe(1_999);
    edited(await editCharge(bank.database, found.id, { name: null, priceBand: null }, now));
    const [change] = set.priceChanges.filter((each) => each.byHand);
    edited(await deleteChargePriceChange(bank.database, found.id, change?.id ?? "", now));
    await runFollowUp(clock);
    await sync();
    expect(await only()).toMatchObject({ id: found.id, name: null, priceBand: null });
    expect((await only()).latestAmount).toBe(1_549);
    expect(await total()).toBe(before.total);
    expect(await byCategory()).toEqual(before.categories);
  });

  it("never drops one a Member edited while a find that read it before the edit writes", async () => {
    await sync(...[0, 1, 2].map((at) => charge(`s${at}`, addMonths("2026-07-03", at), 1_549)));
    const found = await only();
    edited(await editCharge(bank.database, found.id, { name: "Movies" }, now));

    // A find that read it before the edit, and found no series, covers it and writes nothing.
    await replaceRecurringCharges(bank.database, [], { covered: [found.id] });

    expect(await only()).toMatchObject({ id: found.id, name: "Movies" });
    expect(await members()).toEqual(["s0 1549", "s1 1549", "s2 1549"]);
  });

  it("keeps a named one the checks would delete once later Transactions show a frequent shop", async () => {
    await sync(
      charge("g1", "2026-08-01", 5_000),
      charge("g2", "2026-08-08", 5_100),
      charge("g3", "2026-08-15", 5_200),
    );
    const found = await only();
    edited(await editCharge(bank.database, found.id, { name: "Weekly box" }, now));

    // Without the name, these make it a frequent shop, and the checks find no series.
    await sync(
      charge("g4", "2026-08-04", 2_000),
      charge("g5", "2026-08-11", 7_500),
      charge("g6", "2026-08-18", 900),
    );

    expect(await only()).toMatchObject({ id: found.id, name: "Weekly box" });
    expect(await members()).toEqual(["g1 5000", "g2 5100", "g3 5200"]);
  });

  it("keeps an edited one through a gap the checks would split, and never merges it", async () => {
    now = new Date("2027-03-20T14:00:00.000Z");
    await sync(...[0, 1, 2].map((at) => charge(`a${at}`, addMonths("2026-07-03", at), 1_549)));
    const found = await only();
    edited(await editCharge(bank.database, found.id, { name: "Movies" }, now));
    // After a gap of 3 months, a new run at the same price.
    await sync(...[0, 1, 2].map((at) => charge(`b${at}`, addMonths("2027-01-03", at), 1_549)));

    const all = await charges();
    const kept = all.find((each) => each.id === found.id);
    expect(kept?.name).toBe("Movies");
    expect(await members(kept)).toEqual(expect.arrayContaining(["a0 1549", "a1 1549", "a2 1549"]));
  });

  it("changes nothing for a Transaction it cannot take, or an ended Recurring charge", async () => {
    await sync(
      ...[0, 1, 2].map((at) => charge(`s${at}`, addMonths("2026-07-03", at), 1_549)),
      charge("other", "2026-09-20", 1_549, { merchantName: "Cloud Drive" }),
      charge("pending", "2026-10-30", 1_549, { pending: true }),
      // Long before the series, so they are no visits that count against it.
      charge("gone", "2026-03-10", 4_000),
      charge("relinked", "2026-03-11", 4_000),
    );
    bank.fake.addPages(BANK, { removed: [{ id: "gone" }] });
    await syncConnection(connectionId, clock);
    await bank.database.$client.execute({
      sql: "UPDATE transactions SET hidden_reason = 'replaced by re-link' WHERE provider_transaction_id = ?",
      args: ["relinked"],
    });
    await runFollowUp(clock);
    const found = await only();
    const before = await charges();

    for (const providerId of ["other", "pending", "gone", "relinked"]) {
      expect(await addChargeTransaction(bank.database, found.id, await idOf(providerId), now)).toBe(
        "no Transaction",
      );
    }
    expect(await addChargeTransaction(bank.database, found.id, "no-such-id", now)).toBe(
      "no Transaction",
    );
    expect(await removeChargeTransaction(bank.database, found.id, await idOf("other"), now)).toBe(
      "no Transaction",
    );
    expect(await editCharge(bank.database, "no-such-id", { name: "X" }, now)).toBe("not found");
    expect(await charges()).toEqual(before);
    await sync();
    expect(await members()).toEqual(["s0 1549", "s1 1549", "s2 1549"]);

    // The last Transaction stays.
    edited(await removeChargeTransaction(bank.database, found.id, await idOf("s0"), now));
    edited(await removeChargeTransaction(bank.database, found.id, await idOf("s1"), now));
    expect(await removeChargeTransaction(bank.database, found.id, await idOf("s2"), now)).toBe(
      "last Transaction",
    );

    // An ended one takes a name and a Category (D38), and no other edit.
    await endCharge(bank.database, found.id, MEMBER, now);
    const named = edited(await editCharge(bank.database, found.id, { name: "Movies" }, now));
    expect(named.name).toBe("Movies");
    expect(named.status).toBe("ended");
    const categorized = edited(
      await editCharge(bank.database, found.id, { category: "Phone and internet" }, now),
    );
    expect(categorized.category).toBe("Phone and internet");
    await runAsked();
    expect(await chosen("s2")).toBe("Phone and internet (Recurring charge)");
    expect(await chosen("s0")).toBe("Entertainment (provider)");
    const ended = await charges();
    expect(await members(ended[0])).toEqual(["s2 1549"]);
    expect(await editCharge(bank.database, found.id, { priceBand: 100 }, now)).toBe("ended");
    expect(await editCharge(bank.database, found.id, { name: "Films", priceBand: 100 }, now)).toBe(
      "ended",
    );
    expect(
      await setChargePriceChange(
        bank.database,
        found.id,
        { fromDate: "2026-11-03", amount: 1 },
        now,
      ),
    ).toBe("ended");
    expect(await addChargeTransaction(bank.database, found.id, await idOf("s0"), now)).toBe(
      "ended",
    );
    expect(await removeChargeTransaction(bank.database, found.id, await idOf("s2"), now)).toBe(
      "ended",
    );
    expect(await charges()).toEqual(ended);
    // The store's own guard, for a price band that races the end.
    expect(await editRecurringCharge(bank.database, found.id, { priceBand: 100 })).toBe(false);
    expect(await charges()).toEqual(ended);
    await sync();
    expect(await charges()).toEqual(ended);
  });

  it("finds nothing more to do on the follow-up job after an edit", async () => {
    await sync(...[0, 1, 2].map((at) => charge(`s${at}`, addMonths("2026-07-03", at), 1_549)));
    const found = await only();
    edited(await editCharge(bank.database, found.id, { category: "Phone and internet" }, now));
    await runFollowUp(clock);
    const asked = bank.followUpsAsked();

    expect(await runFollowUp(clock)).toBeUndefined();
    expect(await runFollowUp(clock)).toBeUndefined();
    expect(bank.followUpsAsked()).toBe(asked);
  });

  it("deletes an edited one's rows with a removed Connection's history", async () => {
    await sync(
      ...[0, 1, 2].map((at) => charge(`s${at}`, addMonths("2026-07-03", at), 1_549)),
      charge("extra", "2026-09-20", 4_000),
    );
    const found = await only();
    edited(await editCharge(bank.database, found.id, { name: "Movies" }, now));
    edited(await addChargeTransaction(bank.database, found.id, await idOf("extra"), now));
    edited(await removeChargeTransaction(bank.database, found.id, await idOf("s0"), now));
    edited(
      await setChargePriceChange(
        bank.database,
        found.id,
        { fromDate: "2026-11-03", amount: 1_999 },
        now,
      ),
    );

    const removing = connectionRemoving();
    expect(await removing.remove(connectionId)).toMatchObject({ outcome: "removed" });
    expect(await removing.deleteHistory(connectionId)).toMatchObject({ outcome: "deleted" });
    await runFollowUp(clock);

    expect(await charges()).toEqual([]);
    for (const table of [
      "recurring_charges",
      "recurring_charge_transactions",
      "recurring_charge_price_changes",
    ]) {
      const left = await bank.database.$client.execute(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(Number(left.rows[0]?.n)).toBe(0);
    }
  });

  it("moves a price history stored before X31 into its own rows at start-up", async () => {
    await sync(...[0, 1, 2].map((at) => charge(`s${at}`, addMonths("2026-07-03", at), 1_549)));
    const found = await only();
    await endCharge(bank.database, found.id, MEMBER, now);
    const entries = found.priceHistory;
    // As the app stored it before: the price history in the charge's row, and no rows of its own.
    await bank.database.$client.batch([
      { sql: "DELETE FROM recurring_charge_transactions", args: [] },
      {
        sql: "UPDATE recurring_charges SET price_history = ? WHERE id = ?",
        args: [JSON.stringify(entries), found.id],
      },
    ]);
    await atStart();
    await atStart();

    expect((await only()).priceHistory).toEqual(entries);
    const row = await bank.database.$client.execute("SELECT price_history FROM recurring_charges");
    expect(row.rows[0]?.price_history).toBe("[]");
    // An ended one's Transactions still start no new series.
    await sync(charge("s3", "2026-10-03", 1_549));
    expect((await charges()).map((each) => each.status)).toEqual(["ended"]);
  });
});
