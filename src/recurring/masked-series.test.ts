import { describe, expect, it } from "vitest";
import { MASKED_CHARGE_RULE, replayMerchant, type SeriesTxn } from "./series.ts";

// Two series of a masked Merchant whose windows overlap (spec 06, A masked Merchant's series): A at
// $15.49 on the 12th and B at $14.99 on the same day or 2 days later, for 8 months. A price change
// in one never takes the other's charges, whichever Transaction of a day sorts first. The replay
// orders a day's Transactions by ID, so each case is tried with A's March ID before and after B's.

const MONTHS = ["2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01"];
const LATER = ["2026-02", "2026-03", "2026-04"];

const txn = (id: string, date: string, amount: number): SeriesTxn => ({
  id,
  date,
  amount,
  accountId: "card",
  category: null,
});

// Each series' charges as "month amount id", and its status, on 2026-04-20: B's first.
const replay = (txns: SeriesTxn[]) =>
  replayMerchant(
    [...txns].sort((a, b) => (a.date < b.date || (a.date === b.date && a.id < b.id) ? -1 : 1)),
    new Set(),
    "2026-04-20",
    MASKED_CHARGE_RULE,
  )
    .map((each) => ({
      status: each.status,
      charges: each.txns.map(
        (charge) => `${charge.date.slice(0, 7)} ${charge.amount} ${charge.id}`,
      ),
    }))
    .sort((a, b) => (a.charges[0] ?? "").localeCompare(b.charges[0] ?? ""));

const history = (prefix: string, months: string[], day: string, amount: number) =>
  months.map((month, at) => txn(`${prefix}${at}`, `${month}-${day}`, amount));

describe.each([
  ["the same day", "12"],
  ["2 days apart", "14"],
])("2 masked series %s", (_, bDay) => {
  const base = [...history("a-", MONTHS, "12", 1_549), ...history("b-", MONTHS, bDay, 1_499)];
  const bLater = (prefix: string) => history(prefix, LATER, bDay, 1_499);
  const bCharges = (prefix: string) => [
    ...MONTHS.map((month, at) => `${month} 1499 b-${at}`),
    ...LATER.map((month, at) => `${month} 1499 ${prefix}${at}`),
  ];
  const aBefore = MONTHS.map((month, at) => `${month} 1549 a-${at}`);

  it.each([
    ["sorts first", "0-", "1-"],
    ["sorts last", "9-", "1-"],
  ])("keeps each one's charges when A changes price and A's ID %s", (_, aPrefix, bPrefix) => {
    const aLater = history(aPrefix, LATER, "12", 1_799);

    expect(replay([...base, ...aLater, ...bLater(bPrefix)])).toEqual([
      { status: "active", charges: bCharges(bPrefix) },
      {
        status: "active",
        charges: [...aBefore, ...LATER.map((month, at) => `${month} 1799 ${aPrefix}${at}`)],
      },
    ]);
  });

  it.each([
    ["sorts first", "0-", "1-"],
    ["sorts last", "9-", "1-"],
  ])("keeps B's charges when A ends and a one-off's ID %s", (_, oneOffPrefix, bPrefix) => {
    const oneOff = txn(`${oneOffPrefix}one-off`, "2026-02-12", 6_000);

    expect(replay([...base, oneOff, ...bLater(bPrefix)])).toEqual([
      { status: "active", charges: bCharges(bPrefix) },
      { status: "inactive", charges: aBefore },
    ]);
  });

  // A tries a day's one-off first, as it is nearer A's amount, and then B's charge as its changed
  // charge: B's next charge cannot confirm it, even when a spare charge at B's price could.
  it("keeps B's charges when A ends and B's price shows twice the month after", () => {
    const oneOff = txn("0-one-off", "2026-02-12", 6_000);
    const spare = txn("9-spare", `2026-03-${bDay}`, 1_499);

    expect(replay([...base, oneOff, spare, ...bLater("1-")])).toEqual([
      { status: "active", charges: bCharges("1-") },
      { status: "inactive", charges: aBefore },
    ]);
  });

  // B takes the one-off at its price, so B's own February charge is free, and A tries it as its
  // changed charge: B's next charge cannot confirm it.
  it("keeps B's charges when A ends and a one-off at B's price comes first", () => {
    const oneOff = txn("0-one-off", "2026-02-12", 1_499);
    const [, ...rest] = bCharges("1-").slice(MONTHS.length);

    expect(replay([...base, oneOff, ...bLater("1-")])).toEqual([
      {
        status: "active",
        charges: [...bCharges("1-").slice(0, MONTHS.length), "2026-02 1499 0-one-off", ...rest],
      },
      { status: "inactive", charges: aBefore },
    ]);
  });
});
