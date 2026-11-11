import { describe, expect, it } from "vitest";
import { calendarDate, checkedProduct, cutText, parseCents, storeLink } from "./checks.ts";

describe("Checks on Price source data (spec 15, Prices and Deals)", () => {
  it("keeps a price only when it parses to whole cents above $0.00 and below $10,000.00", () => {
    expect(parseCents(7.29)).toBe(729);
    expect(parseCents(0.01)).toBe(1);
    expect(parseCents(9999.99)).toBe(999_999);
    expect(parseCents("$3.5")).toBe(350);
    expect(parseCents(" 12 ")).toBe(1200);
    for (const bad of [0, -1, 7.295, 10_000, 10_000.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseCents(bad)).toBeNull();
    }
    for (const bad of ["", "0.00", "1,299.00", "3.999", "$-2", "2.5e1", "12 oz", "NaN", "10000"]) {
      expect(parseCents(bad)).toBeNull();
    }
    expect(parseCents(null)).toBeNull();
    expect(parseCents({ amount: 1 })).toBeNull();
  });

  it("cuts text to 200 characters, never inside a character, and drops control characters", () => {
    expect(cutText("x".repeat(250))).toHaveLength(200);
    const emoji = cutText(`${"a".repeat(199)}🥜🥜`);
    expect([...(emoji ?? "")]).toHaveLength(200);
    expect(emoji?.endsWith("🥜")).toBe(true);
    expect(cutText("Peanut\u0000 butter\n\t16 oz ")).toBe("Peanut butter 16 oz");
    expect(cutText("   ")).toBeNull();
    expect(cutText({})).toBeNull();
  });

  it("keeps a Product link only when it is https: on the Store's own domain, as stored (K15)", () => {
    const good = "https://www.target.com/p/fake-pantry-large-eggs/-/A-99000201";
    expect(storeLink("target", good)).toBe(good);
    expect(storeLink("target", "https://www.target.com/p/eggs;size=12/-/A-1")).toBe(
      "https://www.target.com/p/eggs;size=12/-/A-1",
    );
    const refused = [
      "http://www.target.com/p/eggs",
      "https://www.target.com;evil.example/p/eggs",
      "https://www.target.com/p/{eggs}",
      "https://www.target.com/p/%2e%2e/eggs",
      "https://www.target.com/%2e%2e/admin",
      "https://www．target.com/p/eggs",
      "https://www.target.com/p/eg\tgs",
      "\thttps://www.target.com/p/eggs",
      " https://www.target.com/p/eggs",
      "https://www.target.com/p/eggs ",
      "https://WWW.target.com/p/eggs",
      "https://www.target.com:443/p/eggs",
      "https://www.target.com:8443/p/eggs",
      "https://user@www.target.com/p/eggs",
      "https://www.target.com.evil.example/p/eggs",
      "https://evil.example/?www.target.com",
      "https://www.walmart.com/ip/eggs/1",
      "javascript:alert(1)//www.target.com",
      "//www.target.com/p/eggs",
      "/p/eggs",
    ];
    for (const link of refused) expect(storeLink("target", link), link).toBeNull();
    expect(storeLink("target", 42)).toBeNull();
    expect(storeLink("not a store", good)).toBeNull();
  });

  it("keeps a date only when it is a real one", () => {
    expect(calendarDate("2026-11-14")).toBe("2026-11-14");
    expect(calendarDate("2026-11-14T23:59:59-05:00")).toBe("2026-11-14");
    for (const bad of ["2026-02-30", "2026-13-01", "11/14/2026", "2026-11-14x", "", null]) {
      expect(calendarDate(bad)).toBeNull();
    }
  });

  it("drops a Product with a price that fails, or with no price, and keeps a Deal only below the regular price", () => {
    const base = { readKey: "1", name: "Fake Eggs" };
    expect(checkedProduct("kroger", { ...base, regularPrice: 3.89 })?.regularPrice).toBe(389);
    expect(checkedProduct("kroger", { ...base, regularPrice: 3.899 })).toBeNull();
    expect(checkedProduct("kroger", { ...base, regularPrice: 3.89, dealPrice: -1 })).toBeNull();
    expect(checkedProduct("kroger", { ...base, regularPrice: 12_000 })).toBeNull();
    expect(checkedProduct("kroger", { ...base, regularPrice: null })).toBeNull();
    expect(checkedProduct("kroger", { ...base, regularPrice: "" })).toBeNull();
    expect(checkedProduct("kroger", { ...base, readKey: null, regularPrice: 1 })).toBeNull();
    expect(checkedProduct("kroger", { ...base, name: " ", regularPrice: 1 })).toBeNull();
    const higher = checkedProduct("kroger", { ...base, regularPrice: 3, dealPrice: 4 });
    expect(higher).toMatchObject({ regularPrice: 300, dealPrice: null, dealEndsOn: null });
    const deal = checkedProduct("kroger", {
      ...base,
      regularPrice: 4,
      dealPrice: 3,
      dealEndsOn: "2026-11-31",
    });
    expect(deal).toMatchObject({ regularPrice: 400, dealPrice: 300, dealEndsOn: null });
    const long = checkedProduct("kroger", { ...base, name: "n".repeat(300), regularPrice: 1 });
    expect(long?.name).toHaveLength(200);
    expect(checkedProduct("kroger", { ...base, regularPrice: 1, upc: "12;3" })?.upc).toBeNull();
  });
});
