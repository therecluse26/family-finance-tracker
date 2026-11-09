import { describe, expect, it } from "vitest";
import {
  CHARGE_COUNT,
  type ReportCharge,
  type ReportPayment,
  type ReportPriceChange,
  recurringReport,
} from "./recurring.ts";

// Recurring charges over time (spec 07, Reports), from the rows listRecurringReportRows gives.

const MONTHS = ["2026-09", "2026-10", "2026-11"];
const TODAY = "2026-11-07";

const charge = (id: string, fields: Partial<ReportCharge> = {}): ReportCharge => ({
  id,
  name: null,
  merchantId: null,
  merchantName: id,
  status: "active",
  latestAmount: 1_000,
  ...fields,
});
const paid = (
  chargeId: string,
  date: string,
  amount: number,
  postedDate = date,
): ReportPayment => ({
  chargeId,
  date,
  postedDate,
  amount,
});
const change = (
  chargeId: string,
  fromDate: string,
  amount: number,
  byHand = false,
): ReportPriceChange => ({ chargeId, fromDate, amount, byHand });

describe("the Recurring charges report", () => {
  it("gives the 8 largest charges their own series and sums the rest as Other", () => {
    const charges = Array.from({ length: 10 }, (_, n) => charge(`c${n}`));
    const payments = charges.map((each, n) => paid(each.id, "2026-10-05", 1_000 + n));
    const view = recurringReport({ charges, payments, priceChanges: [] }, MONTHS, TODAY);

    expect(view.charges).toHaveLength(CHARGE_COUNT);
    expect(view.charges.map((each) => each.id)).toEqual([
      "c9",
      "c8",
      "c7",
      "c6",
      "c5",
      "c4",
      "c3",
      "c2",
    ]);
    expect(view.other).toEqual({ count: 2, byMonth: [0, 1_000 + 1_001, 0] });
    expect(view.totals).toEqual([0, 10 * 1_000 + 45, 0]);
    expect(view.changes).toHaveLength(10);
  });

  it("counts a payment in the month of its purchase date, and only months in the range", () => {
    const view = recurringReport(
      {
        charges: [charge("streamly", { name: "Movie nights", merchantName: "Streamly" })],
        payments: [
          paid("streamly", "2026-08-03", 1_549),
          paid("streamly", "2026-09-30", 1_549, "2026-10-02"),
          paid("streamly", "2026-10-30", 1_549, "2026-11-01"),
        ],
        priceChanges: [],
      },
      MONTHS,
      TODAY,
    );

    expect(view.charges).toEqual([
      {
        id: "streamly",
        merchantId: null,
        name: "Movie nights",
        merchantName: "Streamly",
        total: 3_098,
        byMonth: [1_549, 1_549, 0],
      },
    ]);
  });

  it("compares the amount now with the last payment on or before the same day a year ago", () => {
    const view = recurringReport(
      {
        charges: [
          charge("monthly", { latestAmount: 1_799 }),
          charge("yearly", { latestAmount: 12_000 }),
          charge("new", { latestAmount: 500 }),
          charge("ended", { status: "ended", latestAmount: 900 }),
        ],
        payments: [
          paid("yearly", "2024-11-10", 9_900),
          paid("monthly", "2025-10-03", 1_449),
          paid("monthly", "2025-11-07", 1_549),
          paid("monthly", "2025-11-08", 1_649),
          paid("yearly", "2025-11-10", 12_000),
          paid("ended", "2025-11-01", 800),
          paid("monthly", "2026-10-03", 1_799),
          paid("yearly", "2026-11-05", 12_000),
          paid("new", "2026-10-15", 500),
          paid("ended", "2026-09-01", 900),
        ],
        priceChanges: [],
      },
      MONTHS,
      TODAY,
    );

    const byId = Object.fromEntries(view.changes.map((each) => [each.id, each]));
    expect(byId.monthly).toMatchObject({ now: 1_799, yearAgo: 1_549, change: 250 });
    // A yearly charge's price a year ago was the one it paid before that day.
    expect(byId.yearly).toMatchObject({ now: 12_000, yearAgo: 9_900, change: 2_100 });
    expect(byId.new).toMatchObject({ now: 500, yearAgo: null, change: null });
    expect(byId.ended).toMatchObject({ status: "ended", now: null, yearAgo: 800, change: null });
  });

  it("marks each price change in the range once, in the month of its date", () => {
    const view = recurringReport(
      {
        charges: [charge("streamly"), charge("quiet")],
        payments: [
          paid("streamly", "2026-09-03", 1_549),
          paid("streamly", "2026-10-03", 1_799),
          paid("streamly", "2026-11-03", 1_799),
        ],
        priceChanges: [
          change("streamly", "2026-08-03", 1_549),
          change("streamly", "2026-10-03", 1_799),
          change("streamly", "2026-10-03", 1_800, true),
          // A charge with no payment in the range has no marker.
          change("quiet", "2026-10-10", 700),
        ],
      },
      MONTHS,
      TODAY,
    );

    expect(view.priceChanges).toEqual([
      {
        chargeId: "streamly",
        name: "streamly",
        merchantName: "streamly",
        month: "2026-10",
        fromDate: "2026-10-03",
        amount: 1_800,
        before: 1_549,
      },
    ]);
    expect(view.changes.map((each) => each.id)).toEqual(["streamly"]);
  });

  it("keeps Feb 29 as the day a year back", () => {
    const view = recurringReport(
      {
        charges: [charge("gym", { latestAmount: 4_000 })],
        payments: [paid("gym", "2027-02-28", 3_500), paid("gym", "2028-02-29", 4_000)],
        priceChanges: [],
      },
      ["2028-02"],
      "2028-02-29",
    );
    expect(view.changes[0]).toMatchObject({ yearAgo: 3_500, change: 500 });
  });
});
