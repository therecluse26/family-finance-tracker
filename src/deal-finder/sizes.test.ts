import { describe, expect, it } from "vitest";
import { packagesToBuy, productSize, readSize, unitPrice } from "./sizes.ts";

// Package sizes, packages to buy and unit prices (spec 15, Units and package sizes). Every Product
// here is made up.

describe("readSize", () => {
  it.each([
    ["16 oz", { kind: "amount", base: 16 }],
    ["16 fl oz", { kind: "amount", base: 16 }],
    ["16 fl. oz.", { kind: "amount", base: 16 }],
    ["1.5 lb", { kind: "amount", base: 24 }],
    ["1 gal", { kind: "amount", base: 128 }],
    ["12 ct", { kind: "count", base: 12 }],
    ["12-ct", { kind: "count", base: 12 }],
    ["2 x 40 oz", { kind: "amount", base: 80 }],
    ["2 × 40 oz", { kind: "amount", base: 80 }],
    ["per lb", { kind: "amount", base: 16 }],
    ["a dozen", { kind: "count", base: 12 }],
    ["2 dozen", { kind: "count", base: 24 }],
  ])("reads %s", (text, size) => {
    expect(readSize(text)).toEqual(size);
  });

  it.each([null, "", "family size", "0 oz", "12 apples", "4 ozark apples"])(
    "reads no size from %s",
    (text) => {
      expect(readSize(text)).toBeNull();
    },
  );

  it("reads a Product's size, else the size in its name", () => {
    expect(productSize({ size: null, name: "Sample Creamy Peanut Butter, 16 oz" })).toEqual({
      kind: "amount",
      base: 16,
    });
    expect(productSize({ size: "24 ct", name: "Eggs, 12 ct" })).toEqual({
      kind: "count",
      base: 24,
    });
    expect(productSize({ size: null, name: "Bananas" })).toBeNull();
  });
});

describe("packagesToBuy", () => {
  it("divides the quantity by the package size and rounds up", () => {
    expect(packagesToBuy({ quantity: 2, unit: "lb" }, readSize("1 lb"))).toBe(2);
    expect(packagesToBuy({ quantity: 40, unit: "oz" }, readSize("16 oz"))).toBe(3);
    expect(packagesToBuy({ quantity: 1, unit: "gal" }, readSize("64 fl oz"))).toBe(2);
    expect(packagesToBuy({ quantity: 12, unit: "ct" }, readSize("24 ct"))).toBe(1);
  });

  it("counts `each` against a count, and one package otherwise", () => {
    expect(packagesToBuy({ quantity: 18, unit: "each" }, readSize("12 ct"))).toBe(2);
    expect(packagesToBuy({ quantity: 3, unit: "each" }, readSize("16 oz"))).toBe(3);
    expect(packagesToBuy({ quantity: 2, unit: "pack" }, readSize("12 ct"))).toBe(2);
  });

  it("answers null when the sizes cannot be compared", () => {
    expect(packagesToBuy({ quantity: 2, unit: "lb" }, readSize("12 ct"))).toBeNull();
    expect(packagesToBuy({ quantity: 2, unit: "lb" }, null)).toBeNull();
    expect(packagesToBuy({ quantity: 0, unit: "lb" }, readSize("1 lb"))).toBeNull();
  });
});

describe("unitPrice", () => {
  it("prices one of the List item's unit", () => {
    expect(unitPrice(800, { unit: "lb" }, readSize("2 lb"))).toBe(400);
    expect(unitPrice(320, { unit: "oz" }, readSize("16 oz"))).toBe(20);
    expect(unitPrice(1200, { unit: "each" }, readSize("12 ct"))).toBe(100);
    expect(unitPrice(500, { unit: "pack" }, readSize("12 ct"))).toBe(500);
  });

  it("answers null when the sizes cannot be compared", () => {
    expect(unitPrice(500, { unit: "lb" }, readSize("12 ct"))).toBeNull();
    expect(unitPrice(500, { unit: "oz" }, null)).toBeNull();
  });
});
