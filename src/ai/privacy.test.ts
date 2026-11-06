import type { JSONValue } from "ai";
import { describe, expect, it } from "vitest";
import { loginTables } from "../db/index.ts";
import { newTestDatabase } from "../db/testing.ts";
import { readHouseholdFacts, saveHouseholdFacts } from "../household/index.ts";
import {
  MEMBER_TYPED,
  memberLabel,
  type PrivacyAccount,
  type PrivacyFacts,
  PrivacyRefusal,
  privacyFilter,
  TYPED_PART,
} from "./privacy.ts";
import * as typedValues from "./typed.ts";
import { typedAmount, typedCount, typedDate, typedMonth } from "./typed.ts";

// The typed value mark's field name, which typed.ts makes at start-up and never exports. A test
// reads it here only to forge a mark.
const TYPED = Object.keys(typedCount(0))[0] ?? "";

// The privacy filter on its own (spec 08, Privacy filter): what each kind of text becomes before
// it leaves for the AI provider. The names, addresses, and numbers are made up.

const account = (more: Partial<PrivacyAccount> & { id: string }): PrivacyAccount => ({
  name: "Plaid Checking",
  memberName: null,
  institutionName: "Ally Bank",
  kind: "depository",
  subtype: "checking",
  mask: null,
  ...more,
});

const FACTS: PrivacyFacts = {
  members: [
    { name: "Dana Whitfield", email: "dana.w@example.com", labelNumber: 0 },
    { name: "Ravi Okafor", email: "ravi@example.org", labelNumber: 1 },
  ],
  removedMembers: [],
  accounts: [
    account({ id: "a1", name: "Ally Online Savings", subtype: "savings", mask: "4821" }),
    account({ id: "a2", name: "Rainy day fund", subtype: "savings", mask: "7730" }),
    account({ id: "a3", name: "Everyday Checking", mask: "0094", memberName: "Dana's bills" }),
    account({
      id: "a4",
      name: "HSA",
      kind: "unconnected",
      subtype: "HSA",
      institutionName: null,
      mask: null,
    }),
  ],
  zipCode: "10001",
  ages: [41, 39, 8],
};

const filter = privacyFilter(FACTS);

// A card number that passes the Luhn check, made at test time. Its digits are drawn from 3, 5, 6,
// and 9, so no group of it is a stored last 4 or the ZIP code.
function newCardNumber(): string {
  const digits = [
    4,
    ...Array.from({ length: 14 }, () => [3, 5, 6, 9][Math.floor(Math.random() * 4)] ?? 3),
  ];
  const doubled = (digit: number) => (digit * 2 > 9 ? digit * 2 - 9 : digit * 2);
  const sum = digits
    .toReversed()
    .reduce((total, digit, place) => total + (place % 2 === 0 ? doubled(digit) : digit), 0);
  return [...digits, (10 - (sum % 10)) % 10].join("");
}

const card = newCardNumber();
const grouped = (digits: string, between: string) => digits.match(/\d{4}/g)?.join(between) ?? "";

describe("the privacy filter's text rules", () => {
  it.each([
    // Member names, by join order, as whole words in any case.
    ["Dana paid Ravi back", "Member A paid Member B back"],
    ["DANA WHITFIELD and ravi okafor", "Member A and Member B"],
    ["dana's coffee", "Member A's coffee"],
    ["Danaher Corp and Ravioli Place", "Danaher Corp and Ravioli Place"],
    // A last name on its own, too.
    ["Whitfield household", "Member A household"],
    // A name broken up by dots, invisible characters, or fullwidth letters.
    ["Paid D.a.n.a back", "Paid Member A back"],
    ["Paid Da\u200Bna and R\u00ADavi", "Paid Member A and Member B"],
    ["Paid \uFF24\uFF41\uFF4E\uFF41", "Paid Member A"],
    // Names of people outside the Household pass.
    ["Zelle from Jordan Pike", "Zelle from Jordan Pike"],
    // Email addresses, a Member's or not.
    ["Sent to dana.w@example.com", "Sent to [removed]"],
    ["Invoice from DANA.W@EXAMPLE.COM", "Invoice from [removed]"],
    ["PAYPAL *jordan.pike@mail.test", "PAYPAL [removed]"],
    // Each Account's last 4 digits, and any masked number.
    ["Transfer to savings 4821", "Transfer to savings [removed]"],
    ["CARD XXXX4821 PURCHASE", "CARD [removed] PURCHASE"],
    ["Card ****5555 declined", "Card [removed] declined"],
    ["Account ...6677", "Account [removed]"],
    ["Visa x9912 at Target", "Visa [removed] at Target"],
    ["Card ending in 3141", "Card ending in [removed]"],
    // Any run of 8 or more digits.
    ["Ref 12345678 and ID:000123456789", "Ref [removed] and ID:[removed]"],
    ["Acct 1234567 stays", "Acct 1234567 stays"],
    // Digit groups split by symbols.
    ["STORE 12-34-56-78", "STORE [removed]"],
    ["CODE 123.456.789 X", "CODE [removed] X"],
    ["CALL 1-800-555-1212", "CALL [removed]"],
    ["Card 4111 1111 1111 1111", "Card [removed]"],
    ["Card 4111-1111-1111-1111", "Card [removed]"],
    // A card number split by any horizontal whitespace, or by , + ~ / . with or without spaces.
    ["Card 4111  2222  3333  5555 was replaced", "Card [removed] was replaced"],
    ["Card 4111\t2222\t3333\t5555 was replaced", "Card [removed] was replaced"],
    ["Card 4111\u00A02222\u00A03333\u00A05555 was replaced", "Card [removed] was replaced"],
    ["Card 4111\u202F2222\u30003333 5555 was replaced", "Card [removed] was replaced"],
    ["Card 4111,2222,3333,5555 was replaced", "Card [removed] was replaced"],
    ["Card 4111+2222+3333+5555 was replaced", "Card [removed] was replaced"],
    ["Card 4111~2222~3333~5555 was replaced", "Card [removed] was replaced"],
    ["Card 4111/2222/3333/5555 was replaced", "Card [removed] was replaced"],
    ["Card 4111 . 2222 . 3333 . 5555 was replaced", "Card [removed] was replaced"],
    ["Card 4111.2222 3333 5555 was replaced", "Card [removed] was replaced"],
    ["Card 4111 - 2222 - 3333 - 5555 was replaced", "Card [removed] was replaced"],
    ["Card \uFF14\uFF11\uFF11\uFF11 2222 3333 5555", "Card [removed]"],
    ["Card 41\u200B11 2222 3333 5555", "Card [removed]"],
    ["Number 4111111111111111", "Number [removed]"],
    // A card number split across line breaks of any kind, with or without spaces. The line
    // breaks around it stay.
    ["Card 4111\n1111\n1111\n1111", "Card [removed]"],
    ["Card 4111-\r\n1111 1111 1111", "Card [removed]"],
    ["Card 4111\r1111\r1111\r1111", "Card [removed]"],
    ["Card 4111\u20281111\u20291111\r\n1111", "Card [removed]"],
    ["Card 4111\n 1111 \n1111 \r\n 1111", "Card [removed]"],
    ["Card 4111 -\n 1111 /\r\n1111.\n1111", "Card [removed]"],
    ["Line one 4111\n1111\n1111\n1111\nline two", "Line one [removed]\nline two"],
    ["Paid 412.50\n380.20\r\n1,250.00\nat 9:30", "Paid 412.50\n380.20\r\n1,250.00\nat 9:30"],
    // Dates, times, amounts, and short ranges pass.
    ["On 2026-10-05T12:30:00.123Z", "On 2026-10-05T12:30:00.123Z"],
    ["Paid $1,234.56 on 10/05/2026 at 9:30", "Paid $1,234.56 on 10/05/2026 at 9:30"],
    ["Spent 12.50 13.75 and 450.00", "Spent 12.50 13.75 and 450.00"],
    ["From 10-15 Transactions", "From 10-15 Transactions"],
    ["On 2026-10-14, 2026-10-15 and 2026-10-16", "On 2026-10-14, 2026-10-15 and 2026-10-16"],
    ["Paid 412.50, 380.20, 1,250.00 at 9:30 10:45", "Paid 412.50, 380.20, 1,250.00 at 9:30 10:45"],
    ["Worth $1,234,567.89", "Worth $1,234,567.89"],
    // An Account's last 4 digits split by a space or a dash.
    ["Transfer to savings 48 21", "Transfer to savings [removed]"],
    ["Transfer to savings 48-21", "Transfer to savings [removed]"],
    ["Transfer to savings 4\u00A0821", "Transfer to savings [removed]"],
    // Or by a line break.
    ["Transfer to savings 48\n21", "Transfer to savings [removed]"],
    ["Transfer to savings 48\r\n 21\nthen", "Transfer to savings [removed]\nthen"],
    ["Transfer to savings 48\u202921", "Transfer to savings [removed]"],
    // The ZIP code, and ages.
    ["Lives in 10001 and 10001-2233", "Lives in [removed] and [removed]"],
    // The ZIP code split up, inside an amount, or in fullwidth digits.
    ["Lives in 100 01 and 10\t001", "Lives in [removed] and [removed]"],
    ["Lives in 10001.00", "Lives in [removed].00"],
    ["Lives in \uFF11\uFF10\uFF10\uFF10\uFF11", "Lives in [removed]"],
    // Or split by a line break.
    ["Lives in 100\n01", "Lives in [removed]"],
    ["Lives in 10\r\n 001\nnow", "Lives in [removed]\nnow"],
    ["Lives in 1000\r1 and 10001\n-2233", "Lives in [removed] and [removed]"],
    ["Lives in 100\u202801", "Lives in [removed]"],
    ["zip code: 94110", "zip code: [removed]"],
    ["ages 41, 39 and 8", "ages [removed]"],
    ["ages 12 and 15", "ages [removed] and [removed]"],
    ["Age: 52", "Age: [removed]"],
    ["a 41-year-old and a 7 years old", "a [removed]-year-old and a [removed] years old"],
    ["people [41, 39, 8]", "people [[removed]]"],
    // The stored ages listed in any order, or two of them, with or without an age word.
    [
      "Ages 8, 41, 39 for the three of us; also 39, 8, 41",
      "Ages [removed] for the three of us; also [removed]",
    ],
    ["kids: 39 / 8 and 41", "kids: [removed]"],
    ["We are 39 and 8", "We are [removed]"],
    ["41\t39", "[removed]"],
    // Across line breaks.
    ["We are 39\nand 8", "We are [removed]"],
    ["Ages:\r\n41,\r\n 39,\n 8\ndone", "Ages:\r\n[removed]\ndone"],
    ["kids\n8\r39\u202841", "kids\n[removed]"],
    ["a 30-year mortgage at 6.5", "a 30-year mortgage at 6.5"],
    // One stored age that the text does not name as an age passes: removing every 8 would also
    // remove amounts and counts.
    ["Son is 8", "Son is 8"],
    // Account names become labels.
    ["Moved money to Rainy Day Fund", "Moved money to Ally Bank savings 2"],
    ["From dana's bills", "From Ally Bank checking"],
  ])("%j becomes %j", (input, output) => {
    expect(filter.text(input)).toBe(output);
  });

  it("keeps its place markers out of the text it is given", () => {
    expect(filter.text("0 Dana")).toBe("0 Member A");
  });
});

describe("the privacy filter's labels", () => {
  it("labels Members A to Z, then AA, by the order they joined", () => {
    expect([0, 1, 25, 26, 27, 52].map(memberLabel)).toEqual([
      "Member A",
      "Member B",
      "Member Z",
      "Member AA",
      "Member AB",
      "Member BA",
    ]);
  });

  it("labels Accounts by bank and type, and numbers a label that two Accounts share", () => {
    expect(Object.fromEntries(filter.accountLabels)).toEqual({
      a1: "Ally Bank savings",
      a2: "Ally Bank savings 2",
      a3: "Ally Bank checking",
      a4: "HSA",
    });
  });

  it("keeps each Account's number whatever order the Accounts come in", () => {
    const reversed = privacyFilter({ ...FACTS, accounts: [...FACTS.accounts].reverse() });

    expect(reversed.accountLabels).toEqual(filter.accountLabels);
  });

  it("names both Members when two share a first name", () => {
    const twins = privacyFilter({
      ...FACTS,
      members: [
        { name: "Sam Lee", email: "sam.lee@example.com", labelNumber: 0 },
        { name: "Sam Ortiz", email: "sam.o@example.com", labelNumber: 1 },
      ],
    });

    expect(twins.text("Sam Ortiz paid Sam")).toBe("Member B paid Member A or Member B");
  });

  it("removes a Member's name from a bank's name in a label", () => {
    const own = privacyFilter({
      ...FACTS,
      accounts: [account({ id: "b1", institutionName: "Dana Credit Union" })],
    });

    expect(own.accountLabels.get("b1")).toBe("Member A Credit Union checking");
  });

  it("turns each Member label in AI text back into that Member's name", () => {
    expect(
      filter.showMemberNames("Member A spent less than Member B. Member C and Member Ab stay."),
    ).toBe("Dana Whitfield spent less than Ravi Okafor. Member C and Member Ab stay.");
    expect(filter.showMemberNames(filter.text("Dana and Ravi"))).toBe(
      "Dana Whitfield and Ravi Okafor",
    );
  });

  it("labels each Member by their own label number, and shows a removed Member's kept name for theirs", () => {
    const after = privacyFilter({
      ...FACTS,
      members: [{ name: "Ravi Okafor", email: "ravi@example.org", labelNumber: 1 }],
      removedMembers: [{ labelNumber: 0, name: "Dana Whitfield" }],
    });

    expect(after.text("Ravi paid")).toBe("Member B paid");
    expect(after.showMemberNames("Member A paid and Member B saved. Member C stays.")).toBe(
      "Dana Whitfield paid and Ravi Okafor saved. Member C stays.",
    );
  });
});

describe("the privacy filter's JSON rules", () => {
  it("filters every name and value in a tool result", () => {
    expect(
      filter.json({
        payer: "Ravi Okafor",
        "Dana's total": 4821,
        amounts: [12.5, 123456789],
        nested: [{ memo: "Card ****1234", ok: true, none: null }],
      }),
    ).toEqual({
      payer: "Member B",
      "Member A's total": "[removed]",
      amounts: [12.5, "[removed]"],
      nested: [{ memo: "Card [removed]", ok: true, none: null }],
    });
  });

  it("filters a Quick batch row field by field, so it stays one JSON object with its row number", () => {
    const named = privacyFilter({
      ...FACTS,
      accounts: [...FACTS.accounts, account({ id: "a5", name: "Account birch-card" })],
    });
    const rows = [
      // An Account name spelled by a field name and the next value.
      { row: 1, in_account: "Birch Card Services credit card" },
      // A card number in plain spaced groups, and a Member's name after a tab made a space.
      { row: 2, memo: grouped(card, " "), next: "Ravi Okafor" },
    ];
    const sent = named.params({
      prompt: [
        {
          role: "user",
          content: rows.map((row) => ({ type: "text" as const, text: JSON.stringify(row) })),
        },
      ],
    });
    const texts = ((sent.prompt[0]?.content ?? []) as { text: string }[]).map((part) => part.text);
    expect(texts.map((text) => JSON.parse(text))).toEqual([
      { row: 1, in_account: "Birch Card Services credit card" },
      { row: 2, memo: "[removed]", next: "Member B" },
    ]);
  });

  it("filters a Member's typed text that looks like a batch row as text, and never refuses it", () => {
    // Read as a row, its newline would come back as a letter escape, and the call would be refused.
    const typed = '{"row":1,"note":"lunch with Ravi Okafor\\nsplit it"}';
    const sent = filter.params({
      prompt: [
        { role: "user", content: [{ type: "text", text: typed }], providerOptions: MEMBER_TYPED },
      ],
    });
    expect(sent.prompt[0]?.content).toEqual([
      { type: "text", text: '{"row":1,"note":"lunch with Member B\\nsplit it"}' },
    ]);
  });

  it("refuses a field that names a Household fact", () => {
    for (const field of ["zip", "zipCode", "postal_code", "age", "AGES", "ownerAge"]) {
      expect(() => filter.json({ [field]: 1 })).toThrow(PrivacyRefusal);
    }
  });

  it("refuses a value that is not plain JSON data", () => {
    for (const value of [new Date(), new Map(), 1n, () => 1, Symbol("x")]) {
      expect(() => filter.json({ value })).toThrow(PrivacyRefusal);
    }
  });

  it("refuses the Household facts, as read and as saved", async () => {
    const test = await newTestDatabase();
    try {
      const at = new Date();
      await test.database
        .insert(loginTables.user)
        .values({ id: "m1", name: "Dana", email: "d@example.com", createdAt: at, updatedAt: at });
      const saved = await saveHouseholdFacts(
        test.database,
        { zipCode: "10001", ages: [41, 39, 8], rentOrOwn: "rent" },
        "m1",
      );
      const read = await readHouseholdFacts(test.database);

      for (const facts of [read, typeof saved === "string" ? undefined : saved.saved]) {
        expect(facts).toBeDefined();
        expect(() => filter.json({ facts })).toThrow(PrivacyRefusal);
        expect(() => filter.json([facts])).toThrow(PrivacyRefusal);
      }
    } finally {
      test.close();
    }
  });

  it("keeps a field named __proto__ as a field", () => {
    const value = JSON.parse('{"__proto__": {"memo": "Dana"}}') as unknown;

    const out = filter.json(value) as Record<string, unknown>;

    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({ memo: "Member A" });
  });
});

describe("the privacy filter on names written with or without accents", () => {
  const accented = privacyFilter({
    ...FACTS,
    members: [
      { name: "José Ortega", email: "jo@example.com", labelNumber: 0 },
      { name: "Zoë Brandt", email: "zb@example.com", labelNumber: 1 },
      { name: "Bjørn Ødegaard", email: "bo@example.com", labelNumber: 2 },
    ],
  });

  it.each([
    ["ZELLE FROM JOSE ORTEGA; VENMO ZOE BRANDT", "ZELLE FROM Member A; VENMO Member B"],
    ["José paid Zoe", "Member A paid Member B"],
    ["Jose\u0301 Ortega and Zoe\u0308".normalize("NFC"), "Member A and Member B"],
    ["Jose\u0301 Ortega and Zoe\u0308", "Member A and Member B"],
    ["BJORN ODEGAARD and bjørn", "Member C and Member C"],
    ["Joseph and Zoey pass", "Joseph and Zoey pass"],
  ])("%j becomes %j", (input, output) => {
    expect(accented.text(input)).toBe(output);
  });

  it("matches an accented name in the text to a Member's plain name", () => {
    const plain = privacyFilter({
      ...FACTS,
      members: [{ name: "Jose Ortega", email: "jo@example.com", labelNumber: 0 }],
    });

    expect(plain.text("José Ortega and JOSÉ")).toBe("Member A and Member A");
  });

  it("refuses a request that still holds a Member's name, written any of these ways", () => {
    for (const name of ["JOSE", "Jose\u0301", "ZOE", "Zoë"]) {
      expect(() =>
        accented.params({
          prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
          tools: [{ type: "function", name, inputSchema: { type: "object" } }],
        }),
      ).toThrow(PrivacyRefusal);
    }
  });
});

describe("the privacy filter on names of three words or with a hyphen", () => {
  const household = privacyFilter({
    ...FACTS,
    members: [
      { name: "Zo\u00EB O'Neil-Park", email: "zoe@example.com", labelNumber: 0 },
      { name: "Marcus Bell", email: "marcus@example.com", labelNumber: 1 },
      { name: "Luis Ortega Ruiz", email: "luis@example.com", labelNumber: 2 },
    ],
  });

  // Bank and payment-app lines, as the app builds them from Transactions.
  it.each([
    ["Luis Ortega Ruiz paid rent", "Member C paid rent"],
    ["Payment from Luis Ortega", "Payment from Member C"],
    ["ZELLE FROM LUIS ORTEGA", "ZELLE FROM Member C"],
    ["ZELLE TO ORTEGA RUIZ", "ZELLE TO Member C"],
    ["L. ORTEGA", "Member C"],
    ["VENMO *RUIZ", "VENMO *Member C"],
    ["Zo\u00EB O'Neil-Park", "Member A"],
    ["ZOE ONEIL-PARK", "Member A"],
    ["Payment from Zo\u00EB O'Neil", "Payment from Member A"],
    ["ZELLE TO ZOE PARK", "ZELLE TO Member A"],
    ["ZELLE FROM ONEIL PARK ZOE", "ZELLE FROM Member A"],
    [
      "ACH CREDIT INDN:BELL MARCUS CO ID:1234567890 PPD",
      "ACH CREDIT INDN:Member B CO ID:[removed] PPD",
    ],
    // A word of a Member's name is replaced wherever it stands on its own.
    ["PARK PLACE GARAGE", "Member A PLACE GARAGE"],
  ])("%j becomes %j, and the final check passes it", (line, sent) => {
    expect(household.text(line)).toBe(sent);
    expect(
      household.params({ prompt: [{ role: "user", content: [{ type: "text", text: line }] }] })
        .prompt,
    ).toEqual([{ role: "user", content: [{ type: "text", text: sent }] }]);
  });

  // A full name glued inside a longer word, such as to a payment-app prefix. A single word of a
  // name keeps the word-edge rule, so "Parkway" and "Bellwether" stay.
  it.each([
    ["VENMOMARCUSBELL PMT", "VENMOMember B PMT"],
    ["PayPalBellMarcus", "PayPalMember B"],
    ["MARCUSBELLPHOTO 12", "Member BPHOTO 12"],
    ["XFERLUISORTEGARUIZ", "XFERMember C"],
    ["SQ*ZOEONEILPARKSTUDIO", "SQ*Member ASTUDIO"],
    ["PARKWAY BELLWETHER", "PARKWAY BELLWETHER"],
  ])("%j becomes %j, and the final check passes it", (line, sent) => {
    expect(household.text(line)).toBe(sent);
    expect(
      household.params({ prompt: [{ role: "user", content: [{ type: "text", text: line }] }] })
        .prompt,
    ).toEqual([{ role: "user", content: [{ type: "text", text: sent }] }]);
  });

  it("refuses a request that still holds a full name glued inside a longer word", () => {
    for (const name of ["VENMOMARCUSBELL", "payPalBellMarcus", "rentRuizLuisPmt"]) {
      expect(() =>
        household.params({
          prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
          tools: [{ type: "function", name, inputSchema: { type: "object" } }],
        }),
      ).toThrow(PrivacyRefusal);
    }
  });

  it("refuses a request that still holds a middle name or a hyphen part", () => {
    for (const name of ["ORTEGA", "Park", "oneil"]) {
      expect(() =>
        household.params({
          prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
          tools: [{ type: "function", name, inputSchema: { type: "object" } }],
        }),
      ).toThrow(PrivacyRefusal);
    }
  });
});

describe("the privacy filter on dates, times, and amounts", () => {
  const yearly = privacyFilter({
    ...FACTS,
    accounts: [
      account({ id: "y1", mask: "2026" }),
      account({ id: "y2", mask: "1000", subtype: "savings" }),
    ],
  });

  it.each([
    [
      "2026-10-14 | TRADER JOE'S #552 | -84.17 | Groceries",
      "2026-10-14 | TRADER JOE'S [removed] | -84.17 | Groceries",
    ],
    [
      // A last 4 is removed inside an amount, but never inside a date or a time.
      "Paid 1000.00 and 1,000.00 at 10:00 on 10/14/2026",
      "Paid [removed].00 and [removed].00 at 10:00 on 10/14/2026",
    ],
    [
      "On 2026-10-14T10:00:00Z, card 2026 paid 1000",
      "On 2026-10-14T10:00:00Z, card [removed] paid [removed]",
    ],
    // The ZIP code goes even inside an amount.
    ["Refund 10001.50 in 10001", "Refund [removed].50 in [removed]"],
  ])("%j becomes %j", (input, output) => {
    expect(yearly.text(input)).toBe(output);
  });

  it("keeps dates in a tool result, and removes a last 4 on its own or in an amount", () => {
    expect(yearly.json({ date: "2026-10-14", amount: 1000.5, last4: 1000, year: 2026 })).toEqual({
      date: "2026-10-14",
      amount: "[removed].5",
      last4: "[removed]",
      year: "[removed]",
    });
  });

  it("sends a request with a date that looks like a last 4", () => {
    const sent = yearly.params({
      prompt: [{ role: "user", content: [{ type: "text", text: "2026-10-14 spent 1000.00" }] }],
    });

    expect(sent.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "2026-10-14 spent [removed].00" }] },
    ]);
  });
});

describe("the privacy filter on typed values", () => {
  // Last 4s that equal a year, an amount's digits, and a count. A bank name that holds one makes
  // an Account label that holds it.
  const matching = privacyFilter({
    ...FACTS,
    accounts: [
      account({ id: "t1", mask: "2026" }),
      account({ id: "t2", mask: "4821", institutionName: "Bank 4821", subtype: "savings" }),
      account({ id: "t3", mask: "1250", subtype: "credit card" }),
    ],
  });
  const label = matching.accountLabels.get("t2") ?? "";

  // A tool's result, with typed values and text that hold the same last 4s.
  const lookup = () => ({
    month: typedMonth("2026-10"),
    date: typedDate("2026-10-31"),
    count: typedCount(4821),
    total: typedAmount(-4821),
    rows: [
      { amount: typedAmount(482_100), name: "2026" },
      { amount: typedAmount(-125_000), name: "PURCHASE 1005 BLUEBIRD BOOKS 4821" },
      { amount: typedAmount(2026), name: "Ravi Okafor" },
    ],
    description: "Card 2026 paid 48.21 on 2026-10-14",
    account: label,
    asText: { month: "2026-10", total: "-48.21", count: 4821 },
  });
  const toolResult = (value: unknown) => [
    {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "c1",
          toolName: "lookup",
          output: { type: "json" as const, value: value as JSONValue },
        },
      ],
    },
  ];
  const resultIn = (prompt: unknown) =>
    (prompt as { content: { output: { value: unknown } }[] }[])[0]?.content[0]?.output.value;

  it("sends each typed value bare, as the app built it, and filters every text around it", () => {
    expect(label).toBe("Bank 4821 savings");
    const sent = matching.params({ prompt: toolResult(matching.json(lookup())) });

    expect(resultIn(sent.prompt)).toEqual({
      month: "2026-10",
      date: "2026-10-31",
      count: 4821,
      total: "-48.21",
      rows: [
        { amount: "4821.00", name: "[removed]" },
        { amount: "-1250.00", name: "PURCHASE 1005 BLUEBIRD BOOKS [removed]" },
        { amount: "20.26", name: "Member B" },
      ],
      description: "Card [removed] paid [removed] on 2026-10-14",
      account: "Bank [removed] savings",
      asText: { month: "[removed]-10", total: "-[removed]", count: "[removed]" },
    });
    expect(JSON.stringify(sent)).not.toContain("typed value");
    expect(JSON.stringify(sent)).not.toMatch(/\\[^\\"]/);
  });

  it("keeps typed values marked in a tool result it filters on its own", () => {
    const filtered = matching.json(lookup()) as Record<string, unknown>;

    expect(filtered.total).toEqual(typedAmount(-4821));
    expect(filtered.month).toEqual(typedMonth("2026-10"));
    expect(filtered.account).toBe("Bank [removed] savings");
  });

  it("filters a value marked typed outside a tool result, as any other object", () => {
    const sent = matching.params({
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "lookup",
              input: { total: { [TYPED]: "-48.21" } },
            },
          ],
        },
      ],
      providerOptions: { openai: { note: { [TYPED]: "2026-10" } } },
    });

    // The mark's field name is text here, filtered as any field name is. Its random hex can hold a
    // digit run the filter cuts, so the test expects whatever the filter makes of it.
    const name = matching.text(TYPED);
    expect(sent.prompt[0]?.content).toEqual([
      expect.objectContaining({ input: { total: { [name]: "-[removed]" } } }),
    ]);
    expect(sent.providerOptions).toEqual({ openai: { note: { [name]: "[removed]-10" } } });
  });

  it.each([
    ["a name", { [TYPED]: "Ravi Okafor" }],
    ["a card number", { [TYPED]: card }],
    ["a last 4 with another field", { [TYPED]: "48.21", note: "Card 4821" }],
    ["a number with decimals", { [TYPED]: 48.21 }],
    ["a count of 16 digits", { [TYPED]: 4_111_111_111_111_111 }],
    ["a count of 10^9", { [TYPED]: 1_000_000_000 }],
    ["an amount of 14 dollar digits", { [TYPED]: "41111111111111.11" }],
    ["an amount of 10^12 cents", { [TYPED]: "-10000000000.00" }],
  ])("refuses a value marked typed that holds %s", (_, value) => {
    expect(() => matching.json({ value })).toThrow(PrivacyRefusal);
    expect(() => matching.params({ prompt: toolResult({ value }) })).toThrow(PrivacyRefusal);
  });

  it("makes a typed value only from a whole number, a date, or a month, checked at run time", () => {
    expect(() => typedDate("VENMO *MORGAN LEE")).toThrow(TypeError);
    expect(() => typedDate("2026-02-30")).toThrow(TypeError);
    expect(() => typedDate(20261031 as never)).toThrow(TypeError);
    expect(() => typedMonth("4821")).toThrow(TypeError);
    expect(() => typedMonth("2026-10 Ravi")).toThrow(TypeError);
    expect(() => typedMonth(202610 as never)).toThrow(TypeError);
    expect(() => typedCount(-1)).toThrow(TypeError);
    expect(() => typedCount(2.5)).toThrow(TypeError);
    expect(() => typedCount("4821" as never)).toThrow(TypeError);
    expect(() => typedCount(1_000_000_000)).toThrow(TypeError);
    expect(() => typedAmount(Number.NaN)).toThrow(TypeError);
    expect(() => typedAmount(-0.4)).toThrow(TypeError);
    expect(() => typedAmount("4821" as never)).toThrow(TypeError);
    expect(() => typedAmount(10 ** 12)).toThrow(TypeError);
    expect(() => typedAmount(-(10 ** 12))).toThrow(TypeError);
    expect(typedAmount(10 ** 12 - 1)).toEqual({ [TYPED]: "9999999999.99" });
    expect(typedCount(999_999_999)).toEqual({ [TYPED]: 999_999_999 });
    expect(typedAmount(-123_450)).toEqual({ [TYPED]: "-1234.50" });
  });

  it("marks a typed value with a field name no text can spell, which typed.ts never exports", () => {
    expect(TYPED).toMatch(/^typed value [0-9a-f]{32}$/);
    expect(Object.values(typedValues).filter((each) => typeof each !== "function")).toEqual([]);
  });
});

describe("the privacy filter on the Household summary's typed parts", () => {
  // Last 4s that equal the summary's own amounts, a year, and a count; the ZIP code equals an
  // amount's dollars.
  const matching = privacyFilter({
    ...FACTS,
    accounts: [
      account({ id: "s1", mask: "4999" }),
      account({ id: "s2", mask: "1850", subtype: "savings" }),
      account({ id: "s3", mask: "2026", subtype: "credit card" }),
    ],
    zipCode: "18950",
  });

  // A text part of a typed value, as src/ai/prompt.ts makes one.
  const typedPart = (value: unknown, text?: string) => ({
    type: "text" as const,
    text: text ?? String(Object.values(value as object)[0]),
    providerOptions: { privacyFilter: { [TYPED_PART]: value as JSONValue } },
  });
  const summary = (...content: { type: "text"; text: string }[]) => [
    { role: "user" as const, content },
  ];
  const text = (value: string) => ({ type: "text" as const, text: value });

  it("sends each typed part bare, filters each text part, and joins them as the AI reads them", () => {
    const sent = matching.params({
      prompt: summary(
        text("- Fitness: "),
        typedPart(typedAmount(4_999)),
        text(", Housing "),
        typedPart(typedAmount(185_000)),
        text(" on "),
        typedPart(typedDate("2026-11-20")),
        text(" in "),
        typedPart(typedMonth("2026-11")),
        text(", checking "),
        typedPart(typedAmount(1_895_032)),
        text(", "),
        typedPart(typedCount(4999)),
        text(' times.\n- "Pay card 4999 by ZIP 18950", by Ravi Okafor'),
      ),
    });

    expect(sent.prompt).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: '- Fitness: 49.99, Housing 1850.00 on 2026-11-20 in 2026-11, checking 18950.32, 4999 times.\n- "Pay card [removed] by ZIP [removed]", by Member B',
          },
        ],
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain("privacyFilter");
    expect(JSON.stringify(sent)).not.toContain("typed value");
  });

  it("keeps a message's own provider options, such as a cache mark", () => {
    const cache = { anthropic: { cacheControl: { type: "ephemeral" } } };
    const sent = matching.params({
      prompt: [
        {
          role: "user",
          content: [text("Fitness "), typedPart(typedAmount(4_999))],
          providerOptions: cache,
        },
      ],
    });

    expect(sent.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "Fitness 49.99" }], providerOptions: cache },
    ]);
  });

  it.each([
    ["a text that is not its value", typedPart(typedAmount(4_999), "4999")],
    ["a value in another form", typedPart({ [TYPED]: "Pay card 4999" })],
    ["a card number", typedPart({ [TYPED]: card })],
    ["a mark with no typed value", typedPart("4999", "4999")],
    ["a mark with another field", typedPart({ [TYPED]: "49.99", note: "card 4999" }, "49.99")],
  ])("refuses a typed part that holds %s", (_, part) => {
    expect(() => matching.params({ prompt: summary(text("Fitness "), part) })).toThrow(
      PrivacyRefusal,
    );
  });

  it("refuses a typed part in a message a Member typed, from the AI, or in a tool result", () => {
    // 12.34 matches no fact, so only the rule refuses it.
    const part = typedPart(typedAmount(1_234));

    expect(() =>
      matching.params({
        prompt: [{ role: "user", content: [part], providerOptions: MEMBER_TYPED }],
      }),
    ).toThrow(PrivacyRefusal);
    expect(() => matching.params({ prompt: [{ role: "assistant", content: [part] }] })).toThrow(
      PrivacyRefusal,
    );
    expect(() =>
      matching.params({
        prompt: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                toolName: "lookup",
                output: { type: "text", value: "Done." },
                providerOptions: part.providerOptions,
              },
            ],
          },
        ],
      }),
    ).toThrow(PrivacyRefusal);
  });

  describe("read joined, as the AI reads it", () => {
    // The reviewer's probe: last 4s 4822 and 7037, and Merchant names that end in digits.
    const probe = privacyFilter({
      ...FACTS,
      accounts: [
        account({ id: "p1", mask: "4822" }),
        account({ id: "p2", mask: "7037", subtype: "credit card" }),
      ],
      zipCode: "18950",
    });
    const sentText = (...content: { type: "text"; text: string }[]) =>
      (probe.params({ prompt: summary(...content) }).prompt[0] as { content: { text: string }[] })
        .content[0]?.text;

    it("takes a Merchant's digits out when they make a last 4 or a long run with a typed count", () => {
      expect(
        sentText(
          text("- Pasta 482 "),
          typedPart(typedCount(2)),
          text(" for "),
          typedPart(typedAmount(11_271)),
          text("; Shop 4111111 "),
          typedPart(typedCount(2)),
          text(" for "),
          typedPart(typedAmount(6_041)),
        ),
      ).toBe("- Pasta [removed] 2 for 112.71; Shop [removed] 2 for 60.41");
    });

    it("takes out a last 4 split across a typed value's edge, from the text side only", () => {
      expect(sentText(text("Card 48"), typedPart(typedCount(22)), text(" times"))).toBe(
        "Card [removed]22 times",
      );
      expect(sentText(text("Paid "), typedPart(typedCount(48)), text("22 Main St"))).toBe(
        "Paid 48[removed] Main St",
      );
      expect(sentText(text("Paid "), typedPart(typedAmount(7_0)), text("37 times"))).toBe(
        "Paid 0.70[removed] times",
      );
    });

    it("takes out a card number made of text digits around a typed count", () => {
      expect(sentText(text("Ref 4111 11"), typedPart(typedCount(1111)), text("11 1111 ok"))).toBe(
        "Ref [removed]1111[removed] ok",
      );
    });

    it("takes out a mask, a name, or an email address that text makes around a typed value", () => {
      expect(sentText(text("Mail ab"), typedPart(typedCount(12)), text("@example.com now"))).toBe(
        "Mail [removed]12[removed] now",
      );
      expect(sentText(text("Card ****"), typedPart(typedCount(4821)), text(" paid"))).toBe(
        "Card [removed]4821 paid",
      );
      expect(sentText(text("Paid Da"), typedPart(typedCount(12)), text("na today"))).toBe(
        "Paid [removed]12[removed] today",
      );
    });

    it("keeps the app's own numbers when only words of text lie between them", () => {
      const ages = privacyFilter({ ...FACTS, ages: [20, 30] });
      const sent = ages.params({
        prompt: summary(
          text("Today is day "),
          typedPart(typedCount(20)),
          text(" of "),
          typedPart(typedCount(30)),
          text(" days."),
        ),
      }).prompt[0] as { content: { text: string }[] };

      expect(sent.content[0]?.text).toBe("Today is day 20 of 30 days.");
    });

    it.each([
      ["no text", [typedPart(typedCount(48)), typedPart(typedCount(22))]],
      ["an empty text", [typedPart(typedCount(48)), text(""), typedPart(typedCount(22))]],
    ])("refuses two typed values with %s between them", (_, parts) => {
      expect(() => sentText(text("Paid "), ...parts, text(" times"))).toThrow(PrivacyRefusal);
    });

    // A tool result's JSON joins its values with only quotes and commas between them.
    const toolResult = (value: unknown) => [
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "c1",
            toolName: "lookup",
            output: { type: "json" as const, value: value as JSONValue },
          },
        ],
      },
    ];
    const sentValue = (value: unknown) =>
      (
        probe.params({ prompt: toolResult(value) }).prompt[0] as {
          content: { output: { value: unknown } }[];
        }
      ).content[0]?.output.value;

    it("removes a tool result's text value that makes a fact with a typed value next to it", () => {
      expect(
        sentValue({
          rows: [
            ["Pasta 482", typedCount(2), typedAmount(11_271)],
            ["Shop 4111111", typedCount(2), typedAmount(6_041)],
          ],
        }),
      ).toEqual({
        rows: [
          ["[removed]", 2, "112.71"],
          ["[removed]", 2, "60.41"],
        ],
      });
      expect(sentValue([typedCount(48), "22 Main St"])).toEqual([48, "[removed]"]);
      expect(sentValue(["Ref 4111 11", typedCount(1111), "11 1111 ok"])).toEqual([
        "[removed]",
        1111,
        "[removed]",
      ]);
    });

    it("keeps a tool result's typed values with only commas between them", () => {
      expect(sentValue([typedCount(48), typedCount(22)])).toEqual([48, 22]);
    });

    it("refuses a tool result with a fact across a field name and a typed value", () => {
      expect(() => sentValue({ "Ref 48": typedCount(22) })).toThrow(PrivacyRefusal);
    });
  });
});

describe("the privacy filter's check of the whole request", () => {
  const will = privacyFilter({
    ...FACTS,
    members: [{ name: "Will Avery", email: "wa@example.com", labelNumber: 0 }],
    accounts: [account({ id: "w1", mask: "1000" })],
  });

  it("leaves the app's own tool and response schemas out of its check", () => {
    const schema = {
      type: "object",
      description: "What you will see",
      properties: { months: { type: "array", maxItems: 1000 } },
    };

    const sent = will.params({
      prompt: [{ role: "user", content: [{ type: "text", text: "Will asked" }] }],
      tools: [
        { type: "function", name: "spending", description: "Who will pay", inputSchema: schema },
      ],
      responseFormat: { type: "json", schema, description: "What Will sees" },
    });

    expect(sent.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "Member A asked" }] },
    ]);
    expect(sent.tools).toEqual([
      { type: "function", name: "spending", description: "Who Member A pay", inputSchema: schema },
    ]);
    expect(sent.responseFormat).toEqual({
      type: "json",
      schema,
      description: "What Member A sees",
    });
  });

  const hello = [{ role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }];

  it("filters the headers, the provider options, and the stop sequences", () => {
    const sent = filter.params({
      prompt: hello,
      headers: { "x-note": "From Dana Whitfield", "x-empty": undefined },
      providerOptions: { openai: { user: "ravi@example.org", note: "Card 4111 2222 3333 5555" } },
      stopSequences: ["Dana:", "Ages 41, 39"],
    });

    expect(sent.headers).toEqual({ "x-note": "From Member A", "x-empty": undefined });
    expect(sent.providerOptions).toEqual({ openai: { user: "[removed]", note: "Card [removed]" } });
    expect(sent.stopSequences).toEqual(["Member A:", "Ages [removed]"]);
  });

  it("refuses a fact named in the provider options", () => {
    expect(() =>
      filter.params({ prompt: hello, providerOptions: { openai: { zipCode: "x" } } }),
    ).toThrow(PrivacyRefusal);
  });

  it("checks every string it does not rewrite, as the filter normalizes it", () => {
    // A tool's own provider options pass the filter unchanged, so only the check stands guard.
    const leaks = [
      "\uFF24\uFF41\uFF4E\uFF41",
      "Da\u200Bna",
      "D.a.n.a",
      "Whitfield",
      "1\u00A00001",
      "10001.00",
      "8, 41 and 39",
      "48 21",
      "ravi@example.org",
      // Split across line breaks, which JSON writes as \r and \n.
      "48\n21",
      "48\r\n 21",
      "100\n01",
      "10\r001",
      "100\u202801",
      "8\n41\r\n39",
      // Other digit scripts, marks, words, and glued names.
      "\u0664\u0668\u0662\u0661",
      "\u0661\u0660\u0660\u0660\u0661",
      "4\u03018\u03012\u03011\u0301",
      "1\uFE0F\u20E30\uFE0F\u20E30\uFE0F\u20E30\uFE0F\u20E31\uFE0F\u20E3",
      "48:21",
      "4,821",
      "forty-one, thirty-nine and eight",
      "41.0 and 39.0",
      "DanaWhitfield",
      "dana_whitfield",
      "OKAFORRAVI",
      // A card number with up to 6 symbols between its groups.
      grouped(card, " -/-/ "),
      grouped(card, "-/-/-/"),
    ];
    for (const leak of leaks) {
      expect(() =>
        filter.params({
          prompt: hello,
          tools: [
            { type: "function", name: "t", inputSchema: {}, providerOptions: { x: { leak } } },
          ],
        }),
      ).toThrow(PrivacyRefusal);
    }
  });

  it("refuses a card number split between two parts of the prompt", () => {
    const parts = (digits: string) => [
      `a=${digits.slice(0, 4)}&b=${digits.slice(4, 8)}`,
      `&c=${digits.slice(8, 12)}&d=${digits.slice(12)}`,
    ];
    const ask = (texts: string[]) =>
      filter.params({
        prompt: [{ role: "user", content: texts.map((text) => ({ type: "text", text })) }],
      });

    expect(() => ask(parts(card))).toThrow(PrivacyRefusal);
    // The same digits with a check digit that fails pass: they are not a card number.
    const notACard = card.slice(0, 15) + String((Number(card.at(-1)) + 1) % 10);
    expect(ask(parts(notACard)).prompt).toEqual([
      { role: "user", content: parts(notACard).map((text) => ({ type: "text", text })) },
    ]);
  });

  it("removes a card number split by 4 to 6 symbols, or into fields, and keeps one that is not", () => {
    const notACard = card.slice(0, 15) + String((Number(card.at(-1)) + 1) % 10);
    for (const between of [" -/-/ ", "-/-/-/", ' | ", "', '","b":"']) {
      expect(filter.text(`Card ${grouped(card, between)} end`)).toBe("Card [removed] end");
      expect(filter.text(`Card ${grouped(notACard, between)} end`)).toBe(
        `Card ${grouped(notACard, between)} end`,
      );
    }
  });
});

describe("the privacy filter on app-built text", () => {
  // A Household whose stored age 9 and last 4 with a leading 0 often turn up inside IDs.
  const household = privacyFilter({
    ...FACTS,
    accounts: [account({ id: "h1", mask: "4821" }), account({ id: "h2", mask: "0937" })],
    zipCode: "07030",
    ages: [44, 42, 9],
  });
  const ask = (text: string) =>
    household.params({ prompt: [{ role: "user", content: [{ type: "text", text }] }] });

  it("never refuses Transaction lines with IDs, row numbers, dates, and amounts", () => {
    expect(() => ask("731e6f8d-9c26-4803-997a-9ab80a2895fd SHELL $40.00")).not.toThrow();
    for (let batch = 0; batch < 100; batch++) {
      const lines = Array.from(
        { length: 50 },
        (_, row) =>
          `${row + 1}. ${crypto.randomUUID()} 2026-10-${String((row % 28) + 1).padStart(2, "0")} ` +
          `SHELL OIL ${(row * 37) % 1000}.${String(row % 100).padStart(2, "0")} 9 items`,
      );
      expect(() => ask(lines.join("\n"))).not.toThrow();
      expect(() =>
        household.params({
          prompt: [
            { role: "user", content: [{ type: "text", text: "Rows" }] },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "c1",
                  toolName: "rows",
                  output: {
                    type: "json",
                    value: lines.map((line, row) => ({
                      row: row + 1,
                      id: line.split(" ")[1] ?? "",
                      cents: row * 9,
                      n: 9,
                    })),
                  },
                },
              ],
            },
          ],
        }),
      ).not.toThrow();
    }
  });

  it("keeps Quick batch lines with row numbers, dates, and amounts as they are", () => {
    const lines = [
      "1. 2026-10-14 TRADER JOE'S -84.17",
      "2. 2026-10-14 SHELL OIL 57444 -40.00",
      "9. 10/14/2026 9:30 PAYROLL +2,400.00",
      "42. 2026-10-15 NETFLIX.COM -15.49",
    ];
    for (const line of lines) expect(household.text(line)).toBe(line);
  });

  // Long inputs of one shape, through the whole request: a list of small numbers no longer takes
  // seconds. The best of 3 runs is timed in CPU time, which a busy machine does not stretch, so it
  // does not fail the test.
  it.each([
    "3/",
    "1, ",
    "5 & ",
    "12, ",
    "7 and ",
    "forty-four, ",
    "44 42 9 ",
    "age is ",
    "*#",
    "1----",
    "48\n21 x ",
    "4111 ",
    "Dana ",
    '{"a":"4111","b":"1111"},',
    `a${"\u0301".repeat(20)} `,
    "Dana Whitfield paid 4000 1234 5678 9017 on 2026-10-14 $12.50 ZIP 07030 ages 44, 42, 9 x4821\n",
  ])("filters 64,000 characters of %j quickly", (shape) => {
    const long = shape.repeat(Math.ceil(64_000 / shape.length));
    const times = [0, 1, 2].map(() => {
      const start = process.cpuUsage();
      try {
        ask(long);
      } catch {
        // A refusal is an answer too.
      }
      const used = process.cpuUsage(start);
      return (used.user + used.system) / 1_000;
    });
    expect(Math.min(...times)).toBeLessThan(100);
  });
});
