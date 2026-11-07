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

// Account-number lead-ins (spec 04, Names): the words that introduce a card or Account number go
// with the number.
describe("account-number lead-ins", () => {
  it.each([
    // The fake bank's lines, with no card payment code.
    ["PAYMENT TO CHASE CARD ENDING IN 7731", "Chase"],
    ["SUMMIT AUTO LOAN PMT ACCT ENDING 1234", "Summit Auto Loan Pmt"],
    // Forms the rules never name one by one.
    ["NORTHWIND UTILITIES ACCT ENDING 4821", "Northwind Utilities"],
    ["NORTHWIND UTILITIES CARD ENDING IN 4821", "Northwind Utilities"],
    ["NORTHWIND UTILITIES ENDING IN X4821", "Northwind Utilities"],
    ["NORTHWIND UTILITIES ACCOUNT # 4821", "Northwind Utilities"],
    ["NORTHWIND UTILITIES ACCT NO. 4821", "Northwind Utilities"],
    ["NORTHWIND UTILITIES A/C NO 4821", "Northwind Utilities"],
    ["NORTHWIND UTILITIES ENDS WITH 4821", "Northwind Utilities"],
    ["NORTHWIND UTILITIES CARD LAST 4 4821", "Northwind Utilities"],
    ["NORTHWIND UTILITIES ENDING IN: XXXX-4821", "Northwind Utilities"],
    ["NORTHWIND UTILITIES XXXX 4821", "Northwind Utilities"],
    ["NORTHWIND UTILITIES ACCT ENDING 48 21", "Northwind Utilities"],
    ["northwind utilities acct_ending_4821", "northwind utilities"],
    ["ENDING IN 4821 NORTHWIND UTILITIES", "Northwind Utilities"],
    ["NORTHWIND UTILITIES CARD ENDING IN 4821 PORTLAND OR", "Northwind Utilities"],
    // Other dashes, a zero-width space, and other scripts' digits.
    ["NORTHWIND UTILITIES ACCT ENDING – 4821", "Northwind Utilities"],
    ["NORTHWIND UTILITIES ACCT—ENDING‑4821", "Northwind Utilities"],
    ["NORTHWIND UTILITIES ACCT ENDING ４８２１", "Northwind Utilities"],
    ["NORTHWIND UTILITIES ACCT ENDING ٤٨٢١", "Northwind Utilities"],
    ["NORTHWIND UTILITIES ACCT ENDING \u{1D7D2}\u{1D7D6}\u{1D7D0}\u{1D7CF}", "Northwind Utilities"],
    ["NORTHWIND UTILITIES ENDING IN Ｘ４８２１", "Northwind Utilities"],
    ["NORTHWIND UTILITIES CARD ENDING 48​21", "Northwind Utilities"],
    // A name that holds one of the lead-in words keeps every word.
    ["ENDING BOOKS", "Ending Books"],
    ["NEVERENDING STORY CAFE", "Neverending Story Cafe"],
    ["BLUEBIRD BOOKS ENDING", "Bluebird Books Ending"],
    ["CARD CORNER", "Card Corner"],
    ["AMAZON ACCOUNT", "Amazon Account"],
    ["GIFT CARD 25", "Gift Card"],
    ["XBOX 4821", "Xbox"],
    ["FOXXY NAILS 4821", "Foxxy Nails"],
  ])("cleans %j to %j", (description, name) => {
    expect(fromBank(description)).toEqual({ merchant: { id: null, name }, needsAi: false });
  });

  it("drops a lead-in the bank cut short, and marks the name for AI cleanup", () => {
    expect(fromBank("CHASE CARD ENDING IN")).toEqual({
      merchant: { id: null, name: "Chase" },
      needsAi: true,
    });
    expect(fromBank("NORTHWIND UTILITIES ACCT NUMBER")).toEqual({
      merchant: { id: null, name: "Northwind Utilities" },
      needsAi: true,
    });
    for (const description of ["ENDING IN", "ACCT ENDING 4821", "CARD ENDING IN 4821"]) {
      expect(fromBank(description), description).toEqual({ merchant: null, needsAi: true });
    }
  });

  it("leaves no lead-in word at the end of any clean name", () => {
    let seed = 20261106;
    const pick = <T>(list: readonly T[]): T => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return list[seed % list.length] as T;
    };
    const names = ["BLUEBIRD BOOKS", "NORTHWIND", "SYNCHRONY BANK PAYMENT", "PAYMENT TO CHASE"];
    const leadIns = ["ENDING IN", "ACCT ENDING", "CARD ENDING IN", "ACCOUNT #", "ACCT NO.", "XXXX"];
    const gaps = [" ", " - ", ": ", "–", " · ", ""];
    const numbers = ["4821", "X4821", "XXXX4821", "４８２１", "*4821"];
    for (let n = 0; n < 1000; n += 1) {
      const description = `${pick(names)} ${pick(leadIns)}${pick(gaps)}${pick(numbers)}`;
      const name = fromBank(description).merchant?.name ?? "";
      expect(name, description).not.toMatch(/\b(?:ending|in|acct|account|no|x)\W*$/i);
      expect(name, description).not.toMatch(/\d|４/);
    }
  });
});

// Card payment lines (spec 04, Names): "<bank> card payment", or "Card payment".
describe("card payment lines", () => {
  const cardPayment = (description: string) =>
    cleanMerchant({
      description,
      merchantName: null,
      merchantId: null,
      category: { name: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
    });

  it.each([
    // The fake bank's lines.
    ["PAYMENT TO CHASE CARD ENDING IN 7731", "Chase card payment"],
    ["SYNCHRONY BANK PAYMENT ACCT ENDING 5520", "Synchrony Bank card payment"],
    ["CAPITAL ONE MOBILE PMT", "Capital One card payment"],
    ["CAPITAL ONE MOBILE PYMT", "Capital One card payment"],
    ["Payment Thank You-Mobile", "Card payment"],
    ["PAYMENT - THANK YOU", "Card payment"],
    ["THANK YOU-MOBILE", "Card payment"],
    // Other banks' forms.
    ["CHASE ONLINE PAYMENT 2026 THANK YOU", "Chase card payment"],
    ["DISCOVER E-PAYMENT 4821", "Discover card payment"],
    ["AMEX EPAYMENT ACH PMT 4821", "Amex card payment"],
    ["CITI AUTOPAY 4821 WEB ID: 0042", "Citi card payment"],
    ["CREDIT ONE BANK PAYMENT", "Credit One Bank card payment"],
    ["CHASE CREDIT CRD AUTOPAY", "Chase card payment"],
    ["PAYMENT TO CHASE CARD ENDING IN ７７３１", "Chase card payment"],
    // An ACH line names the payer after "DES:". That person never reaches the name.
    [
      "CHASE CREDIT CRD DES:AUTOPAY ID:XXXXX12345 INDN:DANA OKAFOR CO ID:XXXXX PPD",
      "Chase card payment",
    ],
  ])("names %j %j", (description, name) => {
    expect(cardPayment(description)).toEqual({ merchant: { id: null, name }, needsAi: false });
  });

  it("keeps the provider's Merchant ID, and the provider's Merchant name wins", () => {
    expect(
      cleanMerchant({
        description: "PAYMENT TO CHASE CARD ENDING IN 7731",
        merchantName: null,
        merchantId: "m-chase",
        category: { name: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
      }).merchant,
    ).toEqual({ id: "m-chase", name: "Chase card payment" });
    expect(
      cleanMerchant({
        description: "PAYMENT TO CHASE CARD ENDING IN 7731",
        merchantName: "Chase",
        merchantId: "m-chase",
        category: { name: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
      }).merchant,
    ).toEqual({ id: "m-chase", name: "Chase" });
  });

  it("names the bank by Plaid's financial institution when the line has one", () => {
    expect(
      cleanMerchant({
        description: "ONLINE PAYMENT 0042 TO CARDMEMBER SVCS",
        merchantName: null,
        merchantId: null,
        counterparties: [{ name: "Harbor National Bank", type: "financial_institution" }],
        category: { name: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
      }),
    ).toEqual({
      merchant: { id: null, name: "Harbor National Bank card payment" },
      needsAi: false,
    });
  });

  // No line keeps a person's name in a fixed name. Made-up payers, in the forms banks use.
  it.each([
    // Wells Fargo: the payer after the IDs, with no field name.
    ["CHASE CREDIT CRD EPAY 260105 8273645101 JAMIE RIVERA", "Chase card payment", false],
    ["WF Credit Card AUTO PAY 260105 123456 JAMIE RIVERA", "Wf card payment", false],
    // ACH fields: the bank is the originator, and the payer is in a field.
    [
      "ORIG CO NAME:CITI CARD ONLINE ORIG ID:CITICTP CO ENTRY DESCR:PAYMENT SEC:WEB " +
        "IND NAME:JAMIE RIVERA",
      "Citi card payment",
      false,
    ],
    ["CAPITAL ONE IND NAME:JAMIE RIVERA TRN:1234", "Capital One card payment", false],
    ["CAPITAL ONE NAME:JAMIE RIVERA", "Capital One card payment", false],
    ["CAPITAL ONE RECEIVER:JAMIE RIVERA", "Capital One card payment", false],
    [
      "CAPITAL ONE DES:CRCARDPMT ID:XXXXX INDN:JAMIE RIVERA CO ID:XXXXX WEB",
      "Capital One card payment",
      false,
    ],
    // Only a known card issuer is sure to be a bank; the words after it may be the payer.
    ["PAYMENT TO CHASE JAMIE RIVERA", "Chase card payment", false],
    ["FIRST NATIONAL BANK OF OMAHA PAYMENT", "First National Bank Of Omaha card payment", false],
    // A payer the rules cannot tell from a bank: "Card payment", for AI cleanup.
    ["PAYMENT FROM JAMIE RIVERA", "Card payment", true],
    ["PAYMENT TO JAMIE RIVERA", "Card payment", true],
    ["BLUEBIRD CU PAYMENT", "Card payment", true],
    ["GIFT CARD 2500", "Card payment", true],
    ["CREDIT IB0ABCDEF", "Card payment", true],
    // Payment words, a card number, and a word that repeats the bank go.
    ["DISCOVER DC PYMNTS 4821", "Discover card payment", false],
    ["CITI AUTOPAY PAYMENT CITICARDAP", "Citi card payment", false],
    ["ONLINE BANKING PAYMENT CONFIRMATION 12345678", "Card payment", false],
    ["CHASE CARD 4821 PAYMENT", "Chase card payment", false],
    ["CHASE CARD ENDING IN 4́8́2́1́", "Chase card payment", false],
  ])("names %j %j", (description, name, needsAi) => {
    expect(cardPayment(description)).toEqual({ merchant: { id: null, name }, needsAi });
  });

  // The issuer reads as other clean names do, whatever the line's case.
  it.each([
    ["chase credit crd epay", "Chase card payment"],
    ["BANK OF AMERICA ONLINE PMT Ref 4821", "Bank Of America card payment"],
    ["Capital one mobile pmt", "Capital One card payment"],
    ["USAA CREDIT CARD PAYMENT", "Usaa card payment"],
    ["citi autopay payment Citicardap", "Citi card payment"],
  ])("title-cases the issuer in %j", (description, name) => {
    expect(cardPayment(description)).toEqual({ merchant: { id: null, name }, needsAi: false });
  });
});

// Lines that only look like a card number (spec 04, Names): their words stay, and the name is
// marked for AI cleanup when the rules cannot tell.
describe("numbers that may be part of a name", () => {
  it.each([
    ["GIFT CARD 2500", "Gift Card"],
    ["STARBUCKS CARD 1234", "Starbucks Card"],
    ["HALLMARK CARD 2024", "Hallmark Card"],
    ["ENDS WITH 99 BOUTIQUE", "Ends With Boutique"],
    ["XXX 1 BAR", "Xxx Bar"],
  ])("keeps the words of %j as %j, for AI cleanup", (description, name) => {
    expect(fromBank(description)).toEqual({ merchant: { id: null, name }, needsAi: true });
  });

  it.each([
    ["X 1999 BAR", "X Bar"],
    ["MOVIE X 2024 FEST", "Movie X Fest"],
    ["CARD NO 5 PERFUME", "Card Perfume"],
    ["X GAMES", "X Games"],
    ["CARD FACTORY", "Card Factory"],
    ["ENDING SOON OUTLET", "Ending Soon Outlet"],
    ["CAFÉ LUNA", "Café Luna"],
    ["Café Luna", "Café Luna"],
  ])("keeps %j as %j", (description, name) => {
    expect(fromBank(description)).toEqual({ merchant: { id: null, name }, needsAi: false });
  });

  // An order code after "*" goes as one, so each order is not its own Merchant.
  it.each([
    ["AMAZON MKTPL *2K4JD8", "Amazon Mktpl"],
    ["AMZN MKTP US *1A2B3C", "Amzn Mktp Us"],
    ["UBER * 3PTRIP", "Uber"],
  ])("drops the order code in %j", (description, name) => {
    expect(fromBank(description)).toEqual({ merchant: { id: null, name }, needsAi: false });
  });
});

// K13: a card or Account number in any form, and any mask of it, goes with its lead-in.
describe("card numbers in other forms", () => {
  it.each([
    "NORTHWIND CARD XXXX XXXX XXXX 4821",
    "NORTHWIND CARD **** **** **** 4821",
    "NORTHWIND ACCT NUMBER: XXXX-XXXX-4821",
    "NORTHWIND LAST4 4821",
    "NORTHWIND ACCT 4821",
    "NORTHWIND A/C 4821",
    "NORTHWIND ENDING IN 4́8́2́1́",
    "NORTHWIND ÉNDING IN 4821",
    "NORTHWIND ÉNDING IN 4821",
    "NORTHWIND ACCT ENDING 4.8.2.1",
    "NORTHWIND ACCT ENDING 4 8 2 1",
    "NORTHWIND ENDING IN ⁴⁸²¹",
    "NORTHWIND ENDING IN ④⑧②①",
    "NORTHWIND ENDING IN ❹❽❷❶",
    "NORTHWIND ENDING INXXXX4821",
    "NORTHWIND 4.8.2.1",
    "NORTHWIND ④⑧②①",
    // Characters a reader never sees, or that look like a gap, but that Unicode counts as letters
    // or marks: Hangul fillers, Mongolian and other variation selectors, the grapheme joiner, an
    // unassigned invisible code point, and modifier letters that look like a dash or a colon.
    "NORTHWIND ENDING IN 4\u3164821",
    "NORTHWIND ENDING IN 4\u115F8\u11602\uFFA01",
    "NORTHWIND 4\u3164821",
    "NORTHWIND ENDING\u3164IN\u31644821",
    "NORTHWIND ACCT\uFFA0ENDING 4821",
    "NORTHWIND ENDING IN 4\u180B8\u180D2\u180F1",
    "NORTHWIND ENDING IN 4\uFE0F8\u{E0100}21",
    "NORTHWIND ENDING IN 4\u034F8\u17B421",
    "NORTHWIND ENDING IN 4\u20658\u{E0FFF}21",
    "NORTHWIND ENDING IN 4\uFF708\uFF702\uFF701",
    "NORTHWIND ENDING IN 4\u30FC8\u30FC2\u30FC1",
    "NORTHWIND 4\u02D08\u02D02\u02D01",
    "NORTHWIND CARD \u02E3\u02E3\u02E3\u02E3 4821",
    "NORTHWIND ACCT ENDING \u2800 4821",
    // A number in brackets or quotes takes them with it.
    "NORTHWIND ACCT ENDING IN (4821)",
    "NORTHWIND ACCT [4821]",
    "NORTHWIND ACCT {XXXX4821}",
    'NORTHWIND ACCT "4821"',
    "NORTHWIND ACCT \u201C4821\u201D",
    "NORTHWIND ACCT #4821.",
    "NORTHWIND (ACCT ENDING IN 4821)",
    "NORTHWIND ( ACCT ENDING IN 4821 )",
    "NORTHWIND [CARD XXXX 4821",
    "NORTHWIND \uFF08ACCT 4821\uFF09",
  ])("cleans %j to Northwind", (description) => {
    expect(fromBank(description)).toEqual({
      merchant: { id: null, name: "Northwind" },
      needsAi: false,
    });
  });

  it.each([
    ["NORTHWIND (NYC) ACCT 4821", "Northwind (nyc)"],
    ["DONUTS' ACCT 4821", "Donuts'"],
    ["BLUEBIRD BOOKS (PORTLAND) ACCT ENDING IN (4821)", "Bluebird Books (portland)"],
    ["CAFÉ LUNA ACCT 4821, THANK YOU", "Café Luna Thank You"],
  ])("keeps the brackets and quotes that are not around the number in %j", (description, name) => {
    expect(fromBank(description).merchant?.name).toBe(name);
  });

  // The rules run in the sync, so no line may take long, however it is built (K3).
  // The short lines come first, so a slow rule fails in a second instead of hanging the run.
  it("cleans a 40,000-character line in a few milliseconds", () => {
    const line = (piece: string, length: number) =>
      piece.repeat(Math.ceil(length / piece.length)).slice(0, length);
    const pieces = [
      "*",
      "•",
      "*•",
      "x",
      "X ",
      "XX ",
      "- ",
      "1 ",
      "1.",
      " # 1",
      "x*",
      "LAST 4 ",
      "ENDING IN ",
      "❹ ",
      // A card payment line of many short words, each starting with the one before it.
      "A AB ",
      "CHASE CHASEX ",
      "ACCT (4821) ",
      "( ",
      "\u3164",
      "4\u3164",
      "4\uFF70",
    ];
    const lines = [250, 10_000, 40_000].flatMap((length) =>
      pieces.flatMap((piece) => ["", " 4821 SHOP"].map((end) => `${line(piece, length)}${end}`)),
    );
    for (const description of lines) {
      for (const category of [null, { name: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" }]) {
        const txn = { description, merchantName: null, merchantId: null, category };
        // The fastest of 3 runs, so a busy host does not fail the test.
        let fastest = Number.POSITIVE_INFINITY;
        for (let run = 0; run < 3; run += 1) {
          const start = performance.now();
          cleanMerchant(txn);
          fastest = Math.min(fastest, performance.now() - start);
        }
        expect(fastest, JSON.stringify(description.slice(0, 20))).toBeLessThan(50);
      }
    }
  });
});

// The hard Merchant lines (K7), through the real cleanup rules.
describe("the hard Merchant lines", () => {
  it.each([
    // No provider Merchant name: the payment app is the Merchant.
    ["VENMO PAYMENT 1234567890 WEB ID", { merchant: { id: null, name: "Venmo" }, needsAi: false }],
    ["ZELLE PAYMENT TO 5551234", { merchant: { id: null, name: "Zelle" }, needsAi: false }],
    ["PAYPAL *INST XFER", { merchant: { id: null, name: "PayPal" }, needsAi: false }],
    ["CASH APP*SENT", { merchant: { id: null, name: "Cash App" }, needsAi: false }],
    ["VENMO CASHOUT", { merchant: { id: null, name: "Venmo" }, needsAi: false }],
    // A person or a shop.
    ["VENMO *MORGAN LEE", { merchant: { id: null, name: "Morgan Lee" }, needsAi: false }],
    ["ZELLE PAYMENT TO JOHN SMITH", { merchant: { id: null, name: "John Smith" }, needsAi: false }],
    ["PAYPAL *ETSY SHOP", { merchant: { id: null, name: "Etsy Shop" }, needsAi: false }],
    ["CASH APP*JOHN SMITH", { merchant: { id: null, name: "John Smith" }, needsAi: false }],
    // Store numbers, lead-ins, and digit runs.
    [
      "PURCHASE 1005 BLUEBIRD BOOKS",
      { merchant: { id: null, name: "Bluebird Books" }, needsAi: false },
    ],
    ["BEST BUY CO", { merchant: { id: null, name: "Best Buy Co" }, needsAi: true }],
    ["XXXX4821", { merchant: null, needsAi: true }],
    ["REF#12345678", { merchant: null, needsAi: true }],
    ["(800) 555-1212", { merchant: null, needsAi: true }],
  ])("cleans %j", (description, cleanup) => {
    expect(fromBank(description)).toEqual(cleanup);
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
