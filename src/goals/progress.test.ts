import { describe, expect, it } from "vitest";
import {
  goalAmountFrom,
  loanProgress,
  saveProgress,
  spendLessProgress,
  straightLine,
  wholePercent,
} from "./progress.ts";

// Goal progress math (spec 05, Progress), in whole cents.

const $ = (dollars: number) => Math.round(dollars * 100);

describe("the percentage", () => {
  it("is a whole number from 0% to 100%", () => {
    expect(wholePercent($(5_000), $(12_000))).toBe(42);
    expect(wholePercent(-$(100), $(12_000))).toBe(0);
    expect(wholePercent($(13_000), $(12_000))).toBe(100);
  });

  it("is 100% with nothing to gain, unless the part went backward", () => {
    expect(wholePercent(0, 0)).toBe(100);
    expect(wholePercent(-1, 0)).toBe(0);
  });
});

describe("the straight line", () => {
  it("runs from the start to the Goal amount at the deadline", () => {
    // Spec 05's save example: $7,000 on July 2.
    expect(straightLine($(2_000), $(12_000), "2027-01-01", "2027-12-31", "2027-07-02")).toBe(
      $(7_000),
    );
    expect(straightLine($(2_000), $(12_000), "2027-01-01", "2027-12-31", "2027-01-01")).toBe(
      $(2_000),
    );
  });

  it("stays at the Goal amount once the deadline passes", () => {
    expect(straightLine(0, $(12_000), "2027-01-01", "2027-03-31", "2027-07-02")).toBe($(12_000));
  });
});

describe("the Goal amount from the reading's change", () => {
  it("takes a spend less Goal's change off the baseline", () => {
    expect(goalAmountFrom("spend less", { percent: 20 }, $(600))).toBe($(480));
    expect(goalAmountFrom("spend less", { amount: $(150) }, $(600))).toBe($(450));
    expect(goalAmountFrom("spend less", null, $(600))).toBeNull();
  });

  it("adds a save Goal's change to the start balance", () => {
    expect(goalAmountFrom("save toward an amount", { amount: $(10_000) }, $(2_000))).toBe(
      $(12_000),
    );
    expect(goalAmountFrom("save toward an amount", { percent: 50 }, $(2_000))).toBe($(3_000));
    expect(goalAmountFrom("save toward an amount", null, $(2_000))).toBeNull();
  });

  it("is a loan Goal's change, or with no change the whole balance at the start", () => {
    expect(goalAmountFrom("pay down a loan", { amount: $(3_000) }, $(12_000))).toBe($(3_000));
    expect(goalAmountFrom("pay down a loan", { percent: 25 }, $(12_000))).toBe($(3_000));
    expect(goalAmountFrom("pay down a loan", null, $(12_000))).toBe($(12_000));
  });
});

describe("progress", () => {
  it("is On track for a spend less Goal while P is at or under the Goal amount", () => {
    expect(spendLessProgress({ baseline: $(600), goalAmount: $(480), projected: $(480) })).toEqual({
      kind: "spend less",
      percentage: 100,
      state: "On track",
      detail: "On pace for $480 this month; Goal is $480",
    });
  });

  it("is Behind for a save Goal under the straight line", () => {
    const pace = { startsOn: "2027-01-01", deadline: "2027-12-31", today: "2027-07-02" };
    expect(
      saveProgress({ ...pace, start: $(2_000), goalAmount: $(12_000), balance: $(6_500) }),
    ).toEqual({
      kind: "save toward an amount",
      percentage: 45,
      state: "Behind",
      detail: "$6,500 of $12,000; $500 behind pace",
      met: false,
    });
  });

  it("is On track for a loan Goal at or above the straight line, and done at $0 owed", () => {
    const pace = { startsOn: "2027-01-01", deadline: "2027-12-31", today: "2027-07-02" };
    expect(loanProgress({ ...pace, goalAmount: $(15_000), paid: $(12_000), owed: 0 })).toEqual({
      kind: "pay down a loan",
      percentage: 80,
      state: "On track",
      detail: "$12,000 of $15,000 paid; $4,500 ahead of pace",
      met: true,
    });
  });
});
