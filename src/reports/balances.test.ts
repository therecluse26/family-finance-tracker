import { describe, expect, it } from "vitest";
import type { AccountDayEndsView, AccountView } from "../server/bank-views.ts";
import { balanceLines, type DailyDetails, reportDays } from "./balances.ts";

// Balances and debt's lines (spec 07, Reports), from each Account's balance at each month-end.

const MONTHS = ["2026-08", "2026-09", "2026-10"];
const DAYS = ["2026-08-31", "2026-09-30", "2026-10-20"];

function account(fields: Partial<AccountView> & { id: string; kind: string }): AccountView {
  return {
    connectionId: "conn-1",
    name: `Account ${fields.id}`,
    subtype: null,
    institutionName: null,
    mask: null,
    currentBalance: 0,
    availableBalance: null,
    creditLimit: null,
    estimated: false,
    excluded: false,
    closed: false,
    closedAt: null,
    ...fields,
  };
}

// An Account's balance at each of DAYS; `estimated` marks each day, all known by default.
function line(
  fields: Partial<AccountView> & { id: string; kind: string },
  balances: number[],
  estimated: boolean[] = balances.map(() => false),
): AccountDayEndsView {
  return {
    account: account(fields),
    ends: balances.map((balance, index) => ({
      date: DAYS[index] ?? "",
      balance,
      estimated: estimated[index] ?? false,
      beforeFirstSync: false,
    })),
  };
}

const detail = (date: string, fields: Partial<DailyDetails>): DailyDetails => ({
  date,
  creditLimit: null,
  loanPrincipal: null,
  ...fields,
});

describe("Balances and debt's lines", () => {
  it("ends each month on its last day, and the current month today", () => {
    expect(reportDays(["2024-02", "2026-09", "2026-10"], "2026-10-20")).toEqual([
      "2024-02-29",
      "2026-09-30",
      "2026-10-20",
    ]);
  });

  it("sums Cash on hand, and Debt as what is owed, estimated where any Account is", () => {
    const lines = balanceLines({
      months: MONTHS,
      days: DAYS,
      cash: [
        line(
          { id: "checking", kind: "depository" },
          [100_000, 120_000, 90_000],
          [true, false, false],
        ),
        line({ id: "savings", kind: "depository" }, [500_000, 500_000, 510_000]),
      ],
      debts: [
        line({ id: "card", kind: "credit" }, [-40_000, -30_000, 5_000]),
        line({ id: "loan", kind: "loan", connectionId: null }, [-900_000, -880_000, -860_000]),
      ],
      details: new Map(),
    });

    expect(lines.cashOnHand).toEqual([
      { month: "2026-08", date: "2026-08-31", amount: 600_000, estimated: true },
      { month: "2026-09", date: "2026-09-30", amount: 620_000, estimated: false },
      { month: "2026-10", date: "2026-10-20", amount: 600_000, estimated: false },
    ]);
    // A card in credit lowers the Debt.
    expect(lines.debt.map((point) => point.amount)).toEqual([940_000, 910_000, 855_000]);
  });

  it("gives each card with a credit limit its credit use, that day's limit first, and one line for all cards", () => {
    const lines = balanceLines({
      months: MONTHS,
      days: DAYS,
      cash: [],
      debts: [
        // Its saved limit rises from $4,000 to $5,000 on Sep 15. Before its first saved balance,
        // on Sep 1, its Account's own $3,000 limit counts.
        line(
          { id: "rewards", kind: "credit", creditLimit: 300_000 },
          [-60_000, -100_000, 20_000],
          [true, false, false],
        ),
        line({ id: "store", kind: "credit", creditLimit: 100_000 }, [-50_000, -25_000, -10_000]),
        line({ id: "no-limit", kind: "credit" }, [-70_000, -70_000, -70_000]),
      ],
      details: new Map([
        [
          "rewards",
          [
            detail("2026-09-01", { creditLimit: 400_000 }),
            detail("2026-09-15", { creditLimit: 500_000 }),
            detail("2026-10-01", {}),
          ],
        ],
        ["no-limit", [detail("2026-09-01", {})]],
      ]),
    });

    // A card with no credit limit gets no line.
    expect(lines.creditUse.cards.map((card) => card.id)).toEqual(["rewards", "store"]);
    expect(lines.creditUse.cards[0]?.points).toEqual([
      { month: "2026-08", date: "2026-08-31", share: 0.2, estimated: true },
      { month: "2026-09", date: "2026-09-30", share: 0.2, estimated: false },
      // A day whose saved balance has no limit takes the Account's; a card in credit uses none.
      { month: "2026-10", date: "2026-10-20", share: 0, estimated: false },
    ]);
    expect(lines.creditUse.cards[1]?.points.map((point) => point.share)).toEqual([0.5, 0.25, 0.1]);
    // All cards: what they owe over their limits together, the card with no limit left out.
    expect(lines.creditUse.all).toEqual([
      { month: "2026-08", date: "2026-08-31", share: 110_000 / 400_000, estimated: true },
      { month: "2026-09", date: "2026-09-30", share: 125_000 / 600_000, estimated: false },
      { month: "2026-10", date: "2026-10-20", share: 10_000 / 400_000, estimated: false },
    ]);
  });

  it("has no credit use with no card that has a limit", () => {
    const lines = balanceLines({
      months: MONTHS,
      days: DAYS,
      cash: [],
      debts: [line({ id: "no-limit", kind: "credit" }, [-70_000, -70_000, -70_000])],
      details: new Map(),
    });
    expect(lines.creditUse).toEqual({ cards: [], all: [] });
  });

  it("gives each loan its principal: a synced loan's from its bank, a Manual loan's estimated", () => {
    const lines = balanceLines({
      months: MONTHS,
      days: DAYS,
      cash: [],
      debts: [
        // First synced on Sep 10: no principal before it.
        line(
          { id: "car", kind: "loan" },
          [-2_100_000, -2_050_000, -2_000_000],
          [true, false, false],
        ),
        line(
          { id: "manual", kind: "loan", connectionId: null },
          [-800_000, -790_000, -780_000],
          [true, true, true],
        ),
        // A loan whose bank sends no principal gets no line.
        line({ id: "no-principal", kind: "loan" }, [-50_000, -50_000, -50_000]),
      ],
      details: new Map([
        [
          "car",
          [
            detail("2026-09-10", { loanPrincipal: 2_040_000 }),
            detail("2026-10-10", { loanPrincipal: 1_990_000 }),
          ],
        ],
        ["no-principal", [detail("2026-09-10", {})]],
      ]),
    });

    expect(lines.loans.map((loan) => loan.id)).toEqual(["car", "manual"]);
    expect(lines.loans[0]?.points).toEqual([
      { month: "2026-08", date: "2026-08-31", principal: null, estimated: true },
      { month: "2026-09", date: "2026-09-30", principal: 2_040_000, estimated: false },
      { month: "2026-10", date: "2026-10-20", principal: 1_990_000, estimated: false },
    ]);
    expect(
      lines.loans[1]?.points.map(({ principal, estimated }) => ({ principal, estimated })),
    ).toEqual([
      { principal: 800_000, estimated: true },
      { principal: 790_000, estimated: true },
      { principal: 780_000, estimated: true },
    ]);
  });
});
