import { describe, expect, it } from "vitest";
import {
  cleanMerchant,
  isFixedName,
  type Merchant,
  merchantKey,
  paymentAppLine,
  sameMerchant,
} from "./index.ts";

// Merchant names and identity (spec 04, Merchants). Every bank description here is made up.

const fromBank = (description: string) =>
  cleanMerchant({ description, merchantName: null, merchantId: null });

describe("Merchant names", () => {
  it("uses the provider's Merchant name when it has one", () => {
    expect(
      cleanMerchant({
        description: "SQ *BLUE DOOR COFFEE 10/05",
        merchantName: "Blue Door Coffee Roasters",
        merchantId: "merchant-bdc",
      }),
    ).toEqual({
      merchant: { id: "merchant-bdc", name: "Blue Door Coffee Roasters" },
      needsAi: false,
    });
  });

  it("keeps the provider's Merchant name as it is, even past 4 words", () => {
    expect(
      cleanMerchant({
        description: "HVDG 0042",
        merchantName: "  Happy Valley   Dog Grooming and Spa ",
        merchantId: null,
      }),
    ).toEqual({
      merchant: { id: null, name: "Happy Valley Dog Grooming and Spa" },
      needsAi: false,
    });
  });

  // Made-up bank descriptions and the fixed clean names the rules give them.
  it.each([
    // Payment-processor prefixes.
    ["SQ *BLUE DOOR COFFEE", "Blue Door Coffee"],
    ["TST* PINE STREET TAVERN", "Pine Street Tavern"],
    ["TST*MAPLE GRILL 10/05", "Maple Grill"],
    ["PAYPAL *SUNSHINEYOGA", "Sunshineyoga"],
    ["GOOGLE *YOUTUBE PREMIUM", "Youtube Premium"],
    // Store numbers and phone numbers, with the city and state after them.
    ["STARBUCKS STORE 12345 SEATTLE WA", "Starbucks"],
    ["WAL-MART #1234 BENTONVILLE AR", "Wal-Mart"],
    ["TARGET T-1234 MINNEAPOLIS MN", "Target"],
    ["SHELL OIL 57444 AUSTIN TX", "Shell Oil"],
    ["TRADER JOE'S #123 PORTLAND OR", "Trader Joe's"],
    ["MCDONALD'S F12345 ORLANDO FL", "Mcdonald's"],
    ["NORTHWIND STREAMING 866-555-0142 CA", "Northwind Streaming"],
    ["VERIZON (800) 555-1212", "Verizon"],
    // A number with no place after it goes alone, and the name after it stays.
    ["POS PURCHASE GREENLEAF MARKET #0412", "Greenleaf Market"],
    ["MARKET 12 FOODS", "Market Foods"],
    ["AMZN MKTP US*2K4JD8", "Amzn Mktp Us"],
    // Card numbers, masked card numbers, and reference numbers.
    ["BLUEBIRD CAFE XXXX4821", "Bluebird Cafe"],
    ["XXXXXX1234 SHELL", "Shell"],
    ["REF#12345678 NETFLIX", "Netflix"],
    ["PAYMENT ID:000123456789 ATT", "Att"],
    // The bank's lead-ins, and dates.
    ["PURCHASE 1005 BLUEBIRD BOOKS CARD1234", "Bluebird Books"],
    ["RECURRING DEBIT 1005 NORTHWIND STREAMING", "Northwind Streaming"],
    ["ONLINE PAYMENT 1234567890 TO NORTHWIND CARD", "Northwind Card"],
    ["CARD 1234 AMAZON", "Amazon"],
    ["CHECKCARD 1005 RIVERSIDE HARDWARE", "Riverside Hardware"],
    ["DEBIT CARD PURCHASE 2026-10-05 LAKESIDE PHARMACY", "Lakeside Pharmacy"],
    ["ACME FITNESS CLUB OCT 05", "Acme Fitness Club"],
    ["CITY PARKING 10-05-2026", "City Parking"],
    // Case: a word with "&" keeps it, and so does a description with lowercase letters.
    ["H&M", "H&M"],
    ["AT&T*BILL PAYMENT", "AT&T Bill Payment"],
    ["Orchard Books", "Orchard Books"],
  ])("cleans %j to %j", (description, name) => {
    expect(fromBank(description)).toEqual({ merchant: { id: null, name }, needsAi: false });
  });

  // Made-up bank descriptions the rules cannot fix or cannot decide. Each keeps the rule-cleaned
  // text and is marked for AI cleanup.
  it.each([
    // A last word that may be a state code, with nothing that marks a place: a city or the name?
    ["ACH DEBIT 1005 NORTHWIND GAS CO", "Northwind Gas Co"],
    ["BEST BUY CO", "Best Buy Co"],
    ["JOHNSON AND SONS CO", "Johnson And Sons Co"],
    ["GRILL AND CHILL OK", "Grill And Chill Ok"],
    ["PLUG IN", "Plug In"],
    ["BURGER BARN SAN DIEGO CA", "Burger Barn San Diego Ca"],
    ["PURCHASE AUTHORIZED ON 10/05 CORNER BAKERY CHICAGO IL", "Corner Bakery Chicago Il"],
    // More than 4 words.
    ["HAPPY VALLEY DOG GROOMING AND SPA", "Happy Valley Dog Grooming And Spa"],
    // A word of digits or symbols only: "&" and "24-7".
    ["BARNES & NOBLE #2345 NEW YORK NY", "Barnes & Noble"],
    ["24-7 FITNESS", "24-7 Fitness"],
  ])("cleans %j to %j, for AI cleanup", (description, name) => {
    expect(fromBank(description)).toEqual({ merchant: { id: null, name }, needsAi: true });
  });

  it("stores no name when the rules leave nothing, never the raw description", () => {
    for (const description of ["76 12345 HOUSTON TX", "4111111111111111", "SQ *", "0042 7781 19"]) {
      expect(fromBank(description), description).toEqual({ merchant: null, needsAi: true });
    }
    // With the provider's Merchant ID, the Merchant stays, with no name yet.
    expect(
      cleanMerchant({ description: "4111111111111111", merchantName: null, merchantId: "m-9" }),
    ).toEqual({ merchant: { id: "m-9", name: "" }, needsAi: true });
  });

  it("keeps no run of 4 or more digits in any clean name the rules give", () => {
    // Made-up descriptions built from a fixed seed: names, numbers, masks, dates, and places.
    let seed = 20261103;
    const pick = <T>(list: readonly T[]): T => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return list[seed % list.length] as T;
    };
    const pieces = [
      "BLUEBIRD",
      "CAFE",
      "NORTHWIND",
      "GAS",
      "CO",
      "TX",
      "#4821",
      "XXXX4821",
      "CARD1234",
      "REF#12345678",
      "ID:000123456789",
      "1005",
      "57444",
      "(800) 555-1212",
      "866-555-0142",
      "10/05",
      "2026-10-05",
      "SQ *",
      "TST*",
      "PURCHASE",
      "ACH DEBIT",
      "STORE 0412",
      "*2K4JD8",
      "4111111111111111",
      "T-1234",
      "F12345",
      "A1B2C3D4E5",
      "12345-6789",
      "1-800-555-0100",
    ];
    for (let n = 0; n < 2000; n += 1) {
      const description = Array.from({ length: 1 + (n % 7) }, () => pick(pieces)).join(" ");
      const name = fromBank(description).merchant?.name ?? "";
      expect(name, description).not.toMatch(/\d{4}/);
    }
  });

  it("gives a paper check no Merchant", () => {
    for (const description of ["CHECK 1042", "CHECK PAID #1043", "CHK 88", "Check"]) {
      expect(fromBank(description)).toEqual({ merchant: null, needsAi: false });
    }
  });

  it("keeps the provider's Merchant ID with a rule-cleaned name", () => {
    expect(
      cleanMerchant({
        description: "SQ *BLUE DOOR COFFEE",
        merchantName: null,
        merchantId: "merchant-bdc",
      }),
    ).toEqual({ merchant: { id: "merchant-bdc", name: "Blue Door Coffee" }, needsAi: false });
  });
});

// Payment-app lines (spec 03, Payment apps): the person a line names is the Merchant; with no
// person, the payment app is.
describe("payment-app lines", () => {
  it.each([
    // No person, no shop: the payment app is the Merchant.
    ["VENMO PAYMENT 1234567890 WEB ID", "Venmo", "no one"],
    ["ZELLE PAYMENT TO 5551234", "Zelle", "no one"],
    ["PAYPAL *INST XFER", "PayPal", "no one"],
    ["CASH APP*SENT", "Cash App", "no one"],
    ["VENMO CASHOUT", "Venmo", "no one"],
    ["VENMO ADDFUNDS", "Venmo", "no one"],
    // A person is the Merchant.
    ["VENMO *MORGAN LEE", "Morgan Lee", { person: "Morgan Lee" }],
    ["ZELLE PAYMENT TO JOHN SMITH", "John Smith", { person: "John Smith" }],
    ["CASH APP*JOHN SMITH", "John Smith", { person: "John Smith" }],
    ["Zelle payment from TAYLOR BROOKS Conf# 7f3k2", "Taylor Brooks", { person: "Taylor Brooks" }],
    ["Zelle to Morgan Lee", "Morgan Lee", { person: "Morgan Lee" }],
    // A shop: an ordinary purchase, which the cleanup rules name.
    ["PAYPAL *ETSY SHOP", "Etsy Shop", "another Merchant"],
  ])("%j has the Merchant %j", (description, name, party) => {
    expect(paymentAppLine({ description })?.party).toEqual(party);
    expect(fromBank(description).merchant).toEqual({ id: null, name });
  });

  it.each([
    "PURCHASE 1005 BLUEBIRD BOOKS",
    "BEST BUY CO",
    "XXXX4821",
    "REF#12345678",
    "(800) 555-1212",
    "TRANSFER TO SAVINGS 8802",
  ])("%j is no payment-app line", (description) => {
    expect(paymentAppLine({ description })).toBeUndefined();
  });

  it("finds a line by its payment_app counterparty or its Plaid code alone", () => {
    expect(
      paymentAppLine({
        description: "P2P SEND 0042",
        counterparties: [{ name: "Venmo", type: "payment_app" }],
      }),
    ).toEqual({ app: "Venmo", party: "no one" });
    expect(
      paymentAppLine({
        description: "MOBILE SEND 0042",
        providerCategory: "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS",
      }),
    ).toEqual({ app: null, party: "no one" });
  });

  it("makes a line that names another Merchant an ordinary purchase, and drops a person's Merchant ID", () => {
    const line = {
      description: "PAYPAL TO SUNSHINE YOGA",
      merchantName: "Sunshine Yoga Studio",
      counterparties: [{ name: "PayPal", type: "payment_app" }],
    };
    expect(paymentAppLine(line)?.party).toBe("another Merchant");
    expect(cleanMerchant({ ...line, merchantId: "m-yoga" }).merchant).toEqual({
      id: "m-yoga",
      name: "Sunshine Yoga Studio",
    });
    expect(
      cleanMerchant({
        description: "VENMO *MORGAN LEE",
        merchantName: "Venmo",
        merchantId: "m-venmo",
        counterparties: [{ name: "Venmo", type: "payment_app" }],
      }).merchant,
    ).toEqual({ id: null, name: "Morgan Lee" });
  });
});

describe("the fixed-name rule", () => {
  it.each([
    ["Starbucks", true],
    ["Blue Door Coffee Roasters", true],
    ["7-Eleven", true],
    ["Trader Joe's", true],
    ["Blue Door Coffee Roasters Inc", false],
    ["", false],
    ["Gate 42", false],
    ["Barnes & Noble", false],
    ["Pine Tavern ***", false],
  ])("%j is fixed: %s", (name, fixed) => {
    expect(isFixedName(name)).toBe(fixed);
  });
});

describe("Merchant identity", () => {
  const named = (name: string, id: string | null = null): Merchant => ({ id, name });

  it("compares clean names without case, spaces, or punctuation", () => {
    expect(merchantKey("Trader Joe's")).toBe("traderjoes");
    expect(sameMerchant(named("Trader Joe's"), named("TRADER JOES"))).toBe(true);
    expect(sameMerchant(named("Wal-Mart"), named("wal mart"))).toBe(true);
    expect(sameMerchant(named("Blue Door Coffee"), named("Blue Door Cafe"))).toBe(false);
  });

  it("goes by the provider's Merchant ID when both have one", () => {
    expect(sameMerchant(named("Blue Door Coffee", "m-1"), named("BDC Roasters", "m-1"))).toBe(true);
    // Two Merchant IDs that differ are two Merchants, even with the same clean name.
    expect(sameMerchant(named("Pine Tavern", "m-1"), named("Pine Tavern", "m-2"))).toBe(false);
  });

  it("goes by the clean name when either one has no Merchant ID", () => {
    expect(sameMerchant(named("Pine Tavern", "m-1"), named("PINE TAVERN"))).toBe(true);
    expect(sameMerchant(named("Pine Tavern"), named("Maple Grill", "m-2"))).toBe(false);
  });

  it("never matches a Transaction with no Merchant", () => {
    expect(sameMerchant(null, null)).toBe(false);
    expect(sameMerchant(null, named("Pine Tavern"))).toBe(false);
    expect(sameMerchant(named("***"), named("---"))).toBe(false);
  });
});
