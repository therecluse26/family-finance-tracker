import { describe, expect, it } from "vitest";
import { type MerchantPart, merchantsReport, TOP_MERCHANT_COUNT } from "./merchants.ts";

// Merchants (spec 07, Reports), from the parts listSpendingPartsSince gives. Spending is negative.

const MONTHS = ["2026-09", "2026-10", "2026-11"];

const part = (
  merchantName: string | null,
  amount: number,
  date: string,
  merchantId: string | null = null,
): MerchantPart => ({ merchantName, amount, date, merchantId });

describe("the Merchants report", () => {
  it("ranks the top 10 Merchant groups by their Spending in the range, by month", () => {
    const parts = Array.from({ length: 12 }, (_, n) =>
      part(`Shop ${String.fromCharCode(65 + n)}`, -(1_000 + n * 100), "2026-10-04"),
    );
    const view = merchantsReport(parts, MONTHS);

    expect(view.series).toHaveLength(TOP_MERCHANT_COUNT);
    expect(view.series[0]).toEqual({
      key: "name shopl",
      merchantId: null,
      merchantName: "Shop L",
      total: 2_100,
      byMonth: [0, 2_100, 0],
    });
    expect(view.series.at(-1)?.merchantName).toBe("Shop C");
    expect(view.choices).toEqual(
      view.series.map(({ key, merchantName }) => ({ key, merchantName })),
    );
    expect(view).toMatchObject({ merchant: null, usual: null });
  });

  it("nets Refunds by month without a floor, and leaves out a group with no Spending left", () => {
    const view = merchantsReport(
      [
        part("Corner Grocer", -6_000, "2026-09-02"),
        part("Corner Grocer", 1_500, "2026-11-03"),
        part("Harbor Grill", -3_000, "2026-10-01"),
        part("Harbor Grill", 3_000, "2026-10-04"),
      ],
      MONTHS,
    );

    expect(view.series).toEqual([
      {
        key: "name cornergrocer",
        merchantId: null,
        merchantName: "Corner Grocer",
        total: 4_500,
        byMonth: [6_000, 0, -1_500],
      },
    ]);
  });

  it("groups by provider Merchant ID, else by clean name, and names a group by its latest part", () => {
    const view = merchantsReport(
      [
        part("Streamly", -1_549, "2026-09-03", "m-1"),
        part("Streamly Inc", -1_549, "2026-10-03", "m-1"),
        part("TRADER JOES", -2_000, "2026-10-08"),
        part("Trader Joe's", -1_000, "2026-09-08"),
        // No Merchant, or a name with no letter or digit and no ID: in no group.
        part(null, -50_000, "2026-10-02"),
        part("***", -50_000, "2026-10-02"),
        // Outside the range.
        part("Streamly", -9_999, "2026-08-03", "m-1"),
        part("Streamly", -9_999, "2026-12-03", "m-1"),
      ],
      MONTHS,
    );

    expect(view.series).toEqual(
      [
        {
          key: "name traderjoes",
          merchantId: null,
          merchantName: "TRADER JOES",
          total: 3_000,
          byMonth: [1_000, 2_000, 0],
        },
        {
          key: "id m-1",
          merchantId: "m-1",
          merchantName: "Streamly Inc",
          total: 3_098,
          byMonth: [1_549, 1_549, 0],
        },
      ].sort((a, b) => b.total - a.total),
    );
  });

  it("shows one group with its usual month, and offers it in the filter outside the top 10", () => {
    const parts = [
      ...Array.from({ length: 10 }, (_, n) => part(`Big ${n}`, -90_000, "2026-10-01")),
      part("Small Shop", -1_000, "2026-09-01"),
      part("Small Shop", -3_000, "2026-10-01"),
      part("Small Shop", -2_000, "2026-11-01"),
    ];
    const view = merchantsReport(parts, MONTHS, "name smallshop");

    expect(view.series).toEqual([
      {
        key: "name smallshop",
        merchantId: null,
        merchantName: "Small Shop",
        total: 6_000,
        byMonth: [1_000, 3_000, 2_000],
      },
    ]);
    expect(view.usual).toBe(2_000);
    expect(view.choices).toHaveLength(11);
    expect(view.choices.at(-1)).toEqual({ key: "name smallshop", merchantName: "Small Shop" });
  });

  it("gives no series for a key that names no group", () => {
    const parts = [part("Corner Grocer", -6_000, "2026-09-02")];
    for (const key of ["name nosuch", "cornergrocer", "__proto__", "constructor", ""]) {
      expect(merchantsReport(parts, MONTHS, key)).toEqual({
        merchant: key,
        choices: [{ key: "name cornergrocer", merchantName: "Corner Grocer" }],
        series: [],
        usual: null,
      });
    }
  });
});
