import { addConnection, type Database, listConnections } from "../db/index.ts";
import type { AccountSnapshot, Cents, TxnRecord } from "./adapter.ts";
import type { FakeBankAdapter, FakePage } from "./fake.ts";
import { syncConnection } from "./sync.ts";

// The demo Household: a made-up Household that runs through the fake adapter. Later tests and the
// visual review use it, and `pnpm seed:demo` loads it into a dev app.db. Its banks have the shape
// of the example institutions (spec 01, Who it serves), and it holds each case of the
// Treatment table (spec 03). Every name, number, and amount in it is made up. It is never part of
// the image, and no screen offers the fake provider.
//
// The data comes from a fixed seed, so every run builds the same records.

// The two demo Members. Zelle lines name them by first and last name.
export const DEMO_MEMBERS = [
  { firstName: "Jamie", lastName: "Rivera", email: "jamie.rivera@example.com" },
  { firstName: "Alex", lastName: "Rivera", email: "alex.rivera@example.com" },
] as const;

// The span of the history: 18 months.
export const DEMO_FIRST_DAY = "2025-05-01";
export const DEMO_LAST_DAY = "2026-10-31";

// Pinecrest is not a Connection: the Household keeps its savings there as an Unconnected
// account. Only Transfers to it show, in Ally checking.
export const DEMO_PINECREST = { name: "Pinecrest Bank", mask: "6014" } as const;

export type DemoBank = {
  bankId: string;
  bankName: string;
  accounts: AccountSnapshot[];
  // The pages of the bank's first sync: the history, then pending Transactions that posted.
  pages: FakePage[];
};

// --- Building blocks --------------------------------------------------------------------------

// A small seeded random number generator (mulberry32), so the fixture never changes.
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const random = seeded(20_250_501);
const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
const chance = (p: number) => random() < p;

const ID_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
// A Plaid-shaped ID: 37 letters and digits.
const plaidId = () => Array.from({ length: 37 }, () => ID_LETTERS[between(0, 61)]).join("");

function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

// Each month of the history, as YYYY-MM.
const MONTHS: string[] = [];
for (
  let date = DEMO_FIRST_DAY;
  date <= DEMO_LAST_DAY;
  date = addDays(`${date.slice(0, 7)}-28`, 4)
) {
  MONTHS.push(date.slice(0, 7));
}

// A day in a month, moved to the month's last day when the month is shorter.
function dayOf(month: string, day: number): string {
  const last = addDays(`${addDays(`${month}-28`, 4).slice(0, 7)}-01`, -1);
  return `${month}-${String(Math.min(day, Number(last.slice(8)))).padStart(2, "0")}`;
}

type Confidence = "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

type Merchant = { name: string; entityId: string; website: string | null };

const merchants = new Map<string, Merchant>();
function merchant(name: string, website: string | null = null): Merchant {
  let found = merchants.get(name);
  if (found === undefined) {
    found = { name, entityId: plaidId().slice(0, 22), website };
    merchants.set(name, found);
  }
  return found;
}

type Line = {
  account: AccountSnapshot;
  date: string;
  // Whole cents. Money into the Account is positive.
  amount: Cents;
  description: string;
  merchant?: Merchant;
  // Plaid's detailed category code, with its confidence.
  category: string;
  confidence: Confidence;
  // Other parties named on it, such as a bank or a payment app.
  parties?: { name: string; type: string }[];
  pending?: boolean;
  pendingId?: string;
  channel?: "online" | "in store" | "other";
};

// Plaid's primary categories. Each detailed code starts with one.
const PRIMARY_CATEGORIES = [
  "BANK_FEES",
  "ENTERTAINMENT",
  "FOOD_AND_DRINK",
  "GENERAL_MERCHANDISE",
  "HOME_IMPROVEMENT",
  "INCOME",
  "LOAN_DISBURSEMENTS",
  "LOAN_PAYMENTS",
  "PERSONAL_CARE",
  "RENT_AND_UTILITIES",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "TRANSPORTATION",
];

// A Transaction record, with the Plaid-shaped raw data it came from. Plaid's amount is in dollars,
// and positive for money out.
function record(line: Line): TxnRecord {
  const id = plaidId();
  const primary = PRIMARY_CATEGORIES.find((name) => line.category.startsWith(`${name}_`));
  if (primary === undefined) throw new Error(`No primary category for ${line.category}.`);
  const authorizedDate = line.channel === "in store" ? addDays(line.date, -between(0, 1)) : null;
  const counterparties = [
    ...(line.merchant === undefined ? [] : [{ name: line.merchant.name, type: "merchant" }]),
    ...(line.parties ?? []),
  ];
  return {
    id,
    accountId: line.account.id,
    amount: line.amount,
    postedDate: line.date,
    authorizedDate,
    pending: line.pending ?? false,
    pendingTransactionId: line.pendingId ?? null,
    description: line.description,
    merchantName: line.merchant?.name ?? null,
    merchantId: line.merchant?.entityId ?? null,
    counterparties,
    category: { name: line.category, confidence: line.confidence, version: "v2", mcc: null },
    raw: {
      transaction_id: id,
      account_id: line.account.id,
      amount: -line.amount / 100,
      iso_currency_code: "USD",
      date: line.date,
      authorized_date: authorizedDate,
      pending: line.pending ?? false,
      pending_transaction_id: line.pendingId ?? null,
      original_description: line.description,
      merchant_name: line.merchant?.name ?? null,
      merchant_entity_id: line.merchant?.entityId ?? null,
      website: line.merchant?.website ?? null,
      payment_channel: line.channel ?? "other",
      counterparties: counterparties.map((party) => ({
        name: party.name,
        type: party.type,
        entity_id: line.merchant?.name === party.name ? line.merchant.entityId : null,
        confidence_level: "HIGH",
      })),
      personal_finance_category: {
        primary,
        detailed: line.category,
        confidence_level: line.confidence,
        version: "v2",
      },
    },
  };
}

// Mostly a high confidence, sometimes lower, as on real data (spec 04, Provider categories).
function usualConfidence(): Confidence {
  const roll = random();
  if (roll < 0.55) return "VERY_HIGH";
  if (roll < 0.83) return "HIGH";
  if (roll < 0.93) return "MEDIUM";
  if (roll < 0.98) return "LOW";
  return "UNKNOWN";
}

function account(
  fields: Pick<AccountSnapshot, "id" | "name" | "type" | "subtype" | "mask"> &
    Partial<AccountSnapshot>,
): AccountSnapshot {
  return {
    currentBalance: null,
    availableBalance: null,
    creditLimit: null,
    card: null,
    loan: null,
    raw: null,
    ...fields,
  };
}

// --- The Accounts -----------------------------------------------------------------------------

const ALLY_CHECKING = account({
  id: "demo-ally-checking",
  name: "Interest Checking",
  type: "depository",
  subtype: "checking",
  mask: "4417",
});
const ALLY_SAVINGS = account({
  id: "demo-ally-savings",
  name: "Online Savings",
  type: "depository",
  subtype: "savings",
  mask: "8802",
});
const CAPITAL_ONE = account({
  id: "demo-capital-one-card",
  name: "Rewards Card",
  type: "credit",
  subtype: "credit card",
  mask: "3391",
  creditLimit: 500_000,
});
const CHASE = account({
  id: "demo-chase-card",
  name: "Chase Card",
  type: "credit",
  subtype: "credit card",
  mask: "7731",
  creditLimit: 1_200_000,
});
const SYNCHRONY = account({
  id: "demo-synchrony-card",
  name: "Home Store Card",
  type: "credit",
  subtype: "credit card",
  mask: "5520",
  creditLimit: 400_000,
});
const LARKSPUR = account({
  id: "demo-larkspur-loan",
  name: "Personal Loan",
  type: "loan",
  subtype: "personal",
  mask: "0057",
});

// Each Account's balance on the morning of the first day, by provider account ID. Money owed is
// negative.
const OPENING = new Map<string, Cents>([
  [ALLY_CHECKING.id, 380_000],
  [ALLY_SAVINGS.id, 1_250_000],
  [CAPITAL_ONE.id, -42_000],
  [CHASE.id, -88_000],
  [SYNCHRONY.id, -135_000],
]);

// --- The history ------------------------------------------------------------------------------

const lines: Line[] = [];
const add = (line: Line) => lines.push(line);
const [JAMIE, ALEX] = DEMO_MEMBERS;
const ALLY = { name: "Ally Bank", type: "financial_institution" };
const confirmation = () => plaidId().slice(0, 8).toLowerCase();

// Paychecks every 2 weeks, on Fridays, with a raise in January 2026.
const employer = merchant("Northwind Logistics");
for (let date = "2025-05-02"; date <= DEMO_LAST_DAY; date = addDays(date, 14)) {
  add({
    account: ALLY_CHECKING,
    date,
    amount: date < "2026-01-01" ? 180_037 : 186_590,
    description: "NORTHWIND LOGISTICS PAYROLL PPD ID: 4419920137",
    merchant: employer,
    category: "INCOME_SALARY",
    confidence: "VERY_HIGH",
  });
}

for (const month of MONTHS) {
  // A second, monthly paycheck.
  add({
    account: ALLY_CHECKING,
    date: dayOf(month, 15),
    amount: 142_000,
    description: "HARBOR DENTAL GROUP DIR DEP",
    merchant: merchant("Harbor Dental Group"),
    category: "INCOME_SALARY",
    confidence: "HIGH",
  });
  // Rent and utilities.
  add({
    account: ALLY_CHECKING,
    date: dayOf(month, 1),
    amount: -185_000,
    description: "OAKWOOD PROPERTY MGMT RENT WEB PMT",
    merchant: merchant("Oakwood Property Management"),
    category: "RENT_AND_UTILITIES_RENT",
    confidence: "HIGH",
  });
  add({
    account: ALLY_CHECKING,
    date: dayOf(month, 10),
    amount: -between(6_800, 11_200),
    description: "CITY OF MAPLEFORD UTILITIES BILLPAY",
    merchant: merchant("City of Mapleford Utilities"),
    category: "RENT_AND_UTILITIES_WATER",
    confidence: "MEDIUM",
  });
  add({
    account: ALLY_CHECKING,
    date: dayOf(month, 12),
    amount: -between(8_400, 8_900),
    description: "BRIGHTWAVE WIRELESS AUTOPAY",
    merchant: merchant("Brightwave Wireless"),
    category: "RENT_AND_UTILITIES_TELEPHONE",
    confidence: "VERY_HIGH",
  });
  // Transfers to the Pinecrest savings, an Unconnected account, with "transfer" wording.
  add({
    account: ALLY_CHECKING,
    date: dayOf(month, 3),
    amount: -100_000,
    description: `ONLINE TRANSFER TO PINECREST BANK XXXXXX${DEMO_PINECREST.mask}`,
    category: "TRANSFER_OUT_ACCOUNT_TRANSFER",
    confidence: "HIGH",
    parties: [{ name: DEMO_PINECREST.name, type: "financial_institution" }],
  });
  // Checking to savings, both connected, at the same bank.
  const toSavings = dayOf(month, 5);
  add({
    account: ALLY_CHECKING,
    date: toSavings,
    amount: -40_000,
    description: `Internet transfer to Online Savings account XXXXXX${ALLY_SAVINGS.mask}`,
    category: "TRANSFER_OUT_ACCOUNT_TRANSFER",
    confidence: "VERY_HIGH",
    parties: [ALLY],
  });
  add({
    account: ALLY_SAVINGS,
    date: toSavings,
    amount: 40_000,
    description: `Internet transfer from Interest Checking account XXXXXX${ALLY_CHECKING.mask}`,
    category: "TRANSFER_IN_ACCOUNT_TRANSFER",
    confidence: "VERY_HIGH",
    parties: [ALLY],
  });
  add({
    account: ALLY_SAVINGS,
    date: dayOf(month, 31),
    amount: between(1_100, 1_900),
    description: "Interest Paid",
    category: "INCOME_INTEREST_EARNED",
    confidence: "VERY_HIGH",
    parties: [ALLY],
  });

  // Monthly Recurring charges. The streaming price goes up in February 2026.
  add({
    account: CAPITAL_ONE,
    date: dayOf(month, 8),
    amount: month < "2026-02" ? -1_549 : -1_799,
    description: "STREAMFLIX.COM 866-555-0142",
    merchant: merchant("Streamflix", "streamflix.example"),
    category: "ENTERTAINMENT_TV_AND_MOVIES",
    confidence: "VERY_HIGH",
    channel: "online",
  });
  add({
    account: CAPITAL_ONE,
    date: dayOf(month, 18),
    amount: -1_199,
    description: "TUNEBOX MUSIC SUBSCRIPTION",
    merchant: merchant("Tunebox", "tunebox.example"),
    category: "ENTERTAINMENT_MUSIC_AND_AUDIO",
    confidence: "HIGH",
    channel: "online",
  });
  add({
    account: CHASE,
    date: dayOf(month, 2),
    amount: -4_999,
    description: "IRONWORKS FITNESS CLUB DUES",
    merchant: merchant("Ironworks Fitness"),
    category: "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS",
    confidence: "HIGH",
  });

  // Groceries and gas every week, and restaurants a few times a week.
  for (let week = 0; week < 4; week += 1) {
    const day = 2 + week * 7;
    add({
      account: CAPITAL_ONE,
      date: dayOf(month, day + between(0, 2)),
      amount: -between(6_000, 18_000),
      description: `GREENLEAF MARKET #0${between(210, 219)}`,
      merchant: merchant("Greenleaf Market"),
      category: "FOOD_AND_DRINK_GROCERIES",
      confidence: usualConfidence(),
      channel: "in store",
    });
    add({
      account: CAPITAL_ONE,
      date: dayOf(month, day + between(3, 5)),
      amount: -between(3_000, 6_000),
      description: `QUICKFUEL #${between(4400, 4499)} MAPLEFORD`,
      merchant: merchant("QuickFuel"),
      category: "TRANSPORTATION_GAS",
      confidence: "VERY_HIGH",
      channel: "in store",
    });
    for (let meal = 0; meal < between(1, 3); meal += 1) {
      const place = [
        ["Blue Door Cafe", "SQ *BLUE DOOR CAFE"],
        ["Taqueria Sol", "TAQUERIA SOL MAPLEFORD"],
        ["Pasta Corner", "PASTA CORNER #12"],
        ["Noodle House", "TST* NOODLE HOUSE"],
      ][between(0, 3)] as [string, string];
      add({
        account: CHASE,
        date: dayOf(month, day + between(0, 6)),
        amount: -between(1_200, 6_500),
        description: place[1],
        merchant: merchant(place[0]),
        category: "FOOD_AND_DRINK_RESTAURANT",
        confidence: usualConfidence(),
        channel: "in store",
      });
    }
  }
  // Online shopping, and a store card at a home store.
  for (let order = 0; order < between(1, 3); order += 1) {
    add({
      account: CHASE,
      date: dayOf(month, between(1, 28)),
      amount: -between(1_500, 8_000),
      description: `SHOPMART MKTPLACE*${plaidId().slice(0, 9).toUpperCase()}`,
      merchant: merchant("ShopMart Marketplace", "shopmart.example"),
      category: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES",
      confidence: chance(0.5) ? "MEDIUM" : "HIGH",
      channel: "online",
    });
  }
  add({
    account: SYNCHRONY,
    date: dayOf(month, between(6, 25)),
    amount: -between(4_000, 25_000),
    description: "HOMEWORKS SUPPLY #1187",
    merchant: merchant("HomeWorks Supply"),
    category: "HOME_IMPROVEMENT_HARDWARE",
    confidence: usualConfidence(),
    channel: "in store",
  });
  // Payment-app lines.
  add({
    account: ALLY_CHECKING,
    date: dayOf(month, between(6, 26)),
    amount: -between(2_000, 8_000),
    description: `VENMO PAYMENT ${between(1_000_000_000, 1_999_999_999)} WEB ID: 3264681992`,
    merchant: merchant("Venmo"),
    category: "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS",
    confidence: "HIGH",
    parties: [{ name: "Venmo", type: "payment_app" }],
  });
  if (month.endsWith("-03") || month.endsWith("-07") || month.endsWith("-11")) {
    add({
      account: ALLY_CHECKING,
      date: dayOf(month, between(6, 26)),
      amount: between(3_000, 12_000),
      description: `VENMO CASHOUT ${between(1_000_000_000, 1_999_999_999)} PPD ID: 5264681992`,
      merchant: merchant("Venmo"),
      category: "TRANSFER_IN_TRANSFER_IN_FROM_APPS",
      confidence: "MEDIUM",
      parties: [{ name: "Venmo", type: "payment_app" }],
    });
  }
  if (month.endsWith("-01") || month.endsWith("-06")) {
    add({
      account: ALLY_CHECKING,
      date: dayOf(month, between(6, 26)),
      amount: -10_000,
      description: `VENMO ADDFUNDS ${between(1_000_000_000, 1_999_999_999)} WEB ID: 3264681992`,
      merchant: merchant("Venmo"),
      category: "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS",
      confidence: "HIGH",
      parties: [{ name: "Venmo", type: "payment_app" }],
    });
  }
  // Zelle to a Member's own name, to a babysitter, and from a friend who pays back a dinner.
  if (month.endsWith("-02") || month.endsWith("-05") || month.endsWith("-08")) {
    add({
      account: ALLY_CHECKING,
      date: dayOf(month, 9),
      amount: -25_000,
      description: `Zelle payment to ${ALEX.firstName.toUpperCase()} ${ALEX.lastName.toUpperCase()} Conf# ${confirmation()}`,
      category: "TRANSFER_OUT_ACCOUNT_TRANSFER",
      confidence: "LOW",
      parties: [{ name: "Zelle", type: "payment_app" }],
    });
  }
  add({
    account: ALLY_CHECKING,
    date: dayOf(month, 24),
    amount: -12_000,
    description: `Zelle payment to MORGAN LEE Conf# ${confirmation()}`,
    category: "TRANSFER_OUT_ACCOUNT_TRANSFER",
    confidence: "LOW",
    parties: [{ name: "Zelle", type: "payment_app" }],
  });
  if (month.endsWith("-04") || month.endsWith("-09") || month.endsWith("-12")) {
    add({
      account: ALLY_CHECKING,
      date: dayOf(month, 27),
      amount: between(2_000, 4_500),
      description: `Zelle payment from TAYLOR BROOKS Conf# ${confirmation()}`,
      category: "TRANSFER_IN_ACCOUNT_TRANSFER",
      confidence: "UNKNOWN",
      parties: [{ name: "Zelle", type: "payment_app" }],
    });
  }
}

// Money from Jamie's own name back to checking, by Zelle.
add({
  account: ALLY_CHECKING,
  date: "2026-04-11",
  amount: 30_000,
  description: `Zelle payment from ${JAMIE.firstName.toUpperCase()} ${JAMIE.lastName.toUpperCase()} Conf# ${confirmation()}`,
  category: "TRANSFER_IN_ACCOUNT_TRANSFER",
  confidence: "LOW",
  parties: [{ name: "Zelle", type: "payment_app" }],
});

// Cash at an ATM.
for (const [date, amount] of [
  ["2025-06-21", -10_000],
  ["2025-12-19", -20_000],
  ["2026-05-02", -6_000],
  ["2026-09-12", -10_000],
] as const) {
  add({
    account: ALLY_CHECKING,
    date,
    amount,
    description: `ATM WITHDRAWAL 00${between(4000, 4999)} 5TH AVE & MAIN ST MAPLEFORD`,
    category: "TRANSFER_OUT_WITHDRAWAL",
    confidence: "VERY_HIGH",
    channel: "in store",
  });
}

// One yearly Recurring charge.
for (const date of ["2025-06-14", "2026-06-14"]) {
  add({
    account: CHASE,
    date,
    amount: -13_900,
    description: "SHOPMART PLUS*ANNUAL MEMBERSHIP",
    merchant: merchant("ShopMart Plus", "shopmart.example"),
    category: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES",
    confidence: "HIGH",
    channel: "online",
  });
}

// Refunds: money back from the Merchant of an earlier purchase.
const outdoors = merchant("Trailhead Outfitters");
add({
  account: CHASE,
  date: "2025-11-08",
  amount: -6_499,
  description: "TRAILHEAD OUTFITTERS #33",
  merchant: outdoors,
  category: "GENERAL_MERCHANDISE_SPORTING_GOODS",
  confidence: "HIGH",
  channel: "in store",
});
add({
  account: CHASE,
  date: "2025-11-15",
  amount: 6_499,
  description: "TRAILHEAD OUTFITTERS #33 RETURN",
  merchant: outdoors,
  category: "GENERAL_MERCHANDISE_SPORTING_GOODS",
  confidence: "MEDIUM",
  channel: "in store",
});
add({
  account: CHASE,
  date: "2026-07-22",
  amount: 3_299,
  description: "SHOPMART MKTPLACE REFUND",
  merchant: merchant("ShopMart Marketplace", "shopmart.example"),
  category: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES",
  confidence: "MEDIUM",
  channel: "online",
});

// One Duplicate charge: the same Merchant, amount, and day, twice.
for (let copy = 0; copy < 2; copy += 1) {
  add({
    account: CHASE,
    date: "2026-03-07",
    amount: -1_840,
    description: "SQ *BLUE DOOR CAFE",
    merchant: merchant("Blue Door Cafe"),
    category: "FOOD_AND_DRINK_RESTAURANT",
    confidence: "HIGH",
    channel: "in store",
  });
}

// One Large purchase.
add({
  account: CHASE,
  date: "2025-08-20",
  amount: -274_900,
  description: "OAK & IRON FURNITURE CO",
  merchant: merchant("Oak & Iron Furniture"),
  category: "HOME_IMPROVEMENT_FURNITURE",
  confidence: "HIGH",
  channel: "in store",
});

// Larkspur: the payout into checking, then a monthly payment. Plaid sends no loan details for
// a personal loan, so the loan Account has only its balance.
const LOAN_AMOUNT = 1_500_000;
const LOAN_PAYMENT = 45_218;
const LOAN_APR = 9.49;
const lender = merchant("Larkspur");
add({
  account: ALLY_CHECKING,
  date: "2025-08-12",
  amount: LOAN_AMOUNT,
  description: "LARKSPUR LOAN DISBURSEMENT",
  merchant: lender,
  category: "LOAN_DISBURSEMENTS_PERSONAL",
  confidence: "HIGH",
  parties: [{ name: "Larkspur", type: "financial_institution" }],
});
let loanOwed = LOAN_AMOUNT;
for (const month of MONTHS.filter((month) => month >= "2025-09")) {
  add({
    account: ALLY_CHECKING,
    date: dayOf(month, 15),
    amount: -LOAN_PAYMENT,
    description: "LARKSPUR LOAN PMT WEB ID: 9900213344",
    merchant: lender,
    category: "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT",
    confidence: "VERY_HIGH",
    parties: [{ name: "Larkspur", type: "financial_institution" }],
  });
  loanOwed -= LOAN_PAYMENT - Math.round((loanOwed * LOAN_APR) / 100 / 12);
}
// The loan Account has no Transactions, so its balance is what is still owed.
OPENING.set(LARKSPUR.id, -loanOwed);

// Card payments from checking, each month, for the card's balance at the end of the month before.
// Chase and Synchrony lines name the card's last 4 digits; Capital One lines name only the bank.
// Synchrony carries a balance: it pays less, charges interest, and one payment is late.
const owedAt = (card: AccountSnapshot, date: string) =>
  (OPENING.get(card.id) ?? 0) +
  lines
    .filter((line) => line.account === card && line.date <= date)
    .reduce((sum, line) => sum + line.amount, 0);
const CARD_PAYMENTS = [
  {
    card: CAPITAL_ONE,
    day: 20,
    out: "CAPITAL ONE MOBILE PMT",
    in: "CAPITAL ONE MOBILE PYMT",
    bank: "Capital One",
  },
  {
    card: CHASE,
    day: 22,
    out: `PAYMENT TO CHASE CARD ENDING IN ${CHASE.mask}`,
    in: "Payment Thank You-Mobile",
    bank: "Chase",
  },
  {
    card: SYNCHRONY,
    day: 18,
    out: `SYNCHRONY BANK PAYMENT ACCT ENDING ${SYNCHRONY.mask}`,
    in: "PAYMENT - THANK YOU",
    bank: "Synchrony Bank",
  },
];
for (const month of MONTHS.slice(1)) {
  const monthBefore = addDays(`${month}-01`, -1);
  for (const { card, day, out, in: received, bank } of CARD_PAYMENTS) {
    const owed = -owedAt(card, monthBefore);
    if (owed <= 0) continue;
    const late = card === SYNCHRONY && month === "2026-02";
    const amount = card === SYNCHRONY ? Math.min(owed, 20_000) : owed;
    const paid = late ? dayOf(month, 27) : dayOf(month, day);
    add({
      account: ALLY_CHECKING,
      date: paid,
      amount: -amount,
      description: out,
      category: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
      confidence: "VERY_HIGH",
      parties: [{ name: bank, type: "financial_institution" }],
    });
    add({
      account: card,
      date: addDays(paid, 1),
      amount,
      description: received,
      category: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
      confidence: "HIGH",
    });
    if (late) {
      add({
        account: card,
        date: dayOf(month, 19),
        amount: -4_000,
        description: "LATE FEE",
        category: "BANK_FEES_LATE_PAYMENT",
        confidence: "VERY_HIGH",
      });
    }
    if (card === SYNCHRONY) {
      add({
        account: card,
        date: dayOf(month, 28),
        amount: -Math.round((-owedAt(card, dayOf(month, 27)) * 26.99) / 100 / 12),
        description: "INTEREST CHARGE ON PURCHASES",
        category: "BANK_FEES_INTEREST_CHARGE",
        confidence: "VERY_HIGH",
      });
    }
  }
}

// --- Pending Transactions ---------------------------------------------------------------------

// Pending lines at the end of the history. Each one either posts, in the bank's next page, or is
// still pending. A tip raises one restaurant charge when it posts.
type Pending = { line: Line; posts?: { date: string; amount: Cents } };
const PENDING: Pending[] = [
  {
    line: {
      account: CHASE,
      date: "2026-10-28",
      amount: -4_200,
      description: "PASTA CORNER #12",
      merchant: merchant("Pasta Corner"),
      category: "FOOD_AND_DRINK_RESTAURANT",
      confidence: "HIGH",
      channel: "in store",
    },
    posts: { date: "2026-10-30", amount: -5_040 },
  },
  {
    line: {
      account: CAPITAL_ONE,
      date: "2026-10-29",
      amount: -11_873,
      description: "GREENLEAF MARKET #0214",
      merchant: merchant("Greenleaf Market"),
      category: "FOOD_AND_DRINK_GROCERIES",
      confidence: "VERY_HIGH",
      channel: "in store",
    },
    posts: { date: "2026-10-30", amount: -11_873 },
  },
  {
    line: {
      account: ALLY_CHECKING,
      date: "2026-10-29",
      amount: -6_412,
      description: "BRIGHTWAVE WIRELESS ONE-TIME PMT",
      merchant: merchant("Brightwave Wireless"),
      category: "RENT_AND_UTILITIES_TELEPHONE",
      confidence: "HIGH",
    },
    posts: { date: "2026-10-31", amount: -6_412 },
  },
  {
    line: {
      account: CHASE,
      date: "2026-10-31",
      amount: -2_675,
      description: "TST* NOODLE HOUSE",
      merchant: merchant("Noodle House"),
      category: "FOOD_AND_DRINK_RESTAURANT",
      confidence: "MEDIUM",
      channel: "in store",
    },
  },
  {
    line: {
      account: CAPITAL_ONE,
      date: "2026-10-31",
      amount: -4_388,
      description: "QUICKFUEL #4471 MAPLEFORD",
      merchant: merchant("QuickFuel"),
      category: "TRANSPORTATION_GAS",
      confidence: "VERY_HIGH",
      channel: "in store",
    },
  },
];

// --- The banks --------------------------------------------------------------------------------

const BY_DATE = (a: TxnRecord, b: TxnRecord) => a.postedDate.localeCompare(b.postedDate);
const posted = lines
  .filter((line) => line.date >= DEMO_FIRST_DAY && line.date <= DEMO_LAST_DAY)
  .map(record)
  .sort(BY_DATE);
const pending = PENDING.map(({ line, posts }) => {
  const held = record({ ...line, pending: true });
  const later =
    posts === undefined
      ? undefined
      : record({ ...line, date: posts.date, amount: posts.amount, pendingId: held.id });
  return { held, later };
});

const sum = (records: TxnRecord[], accountId: string) =>
  records
    .filter((txn) => txn.accountId === accountId)
    .reduce((total, txn) => total + txn.amount, 0);
const postedRecords = [...posted, ...pending.flatMap(({ later }) => (later ? [later] : []))];
const stillPending = pending.filter(({ later }) => later === undefined).map(({ held }) => held);

// Each Account's balances at the end of the history: posted Transactions move the current
// balance; pending ones move only the available balance.
function withBalances(snapshot: AccountSnapshot): AccountSnapshot {
  const current = (OPENING.get(snapshot.id) ?? 0) + sum(postedRecords, snapshot.id);
  const held = sum(stillPending, snapshot.id);
  const limit = snapshot.creditLimit;
  const available =
    snapshot.type === "loan" ? null : limit === null ? current + held : limit + current + held;
  return {
    ...snapshot,
    currentBalance: current,
    availableBalance: available,
    raw: {
      account_id: snapshot.id,
      name: snapshot.name,
      mask: snapshot.mask,
      type: snapshot.type,
      subtype: snapshot.subtype,
      // Plaid's balances are in dollars, and what is owed on a card or loan is positive.
      balances: {
        current: (snapshot.type === "depository" ? current : -current) / 100,
        available: available === null ? null : available / 100,
        limit: limit === null ? null : limit / 100,
        iso_currency_code: "USD",
      },
    },
  };
}

// Card details as Plaid's Liabilities data sends them.
function withCard(
  snapshot: AccountSnapshot,
  details: { purchaseApr: number; cashApr: number; minimum: Cents; dueDate: string },
): AccountSnapshot {
  return {
    ...snapshot,
    card: {
      aprs: [
        { type: "purchase_apr", apr: details.purchaseApr },
        { type: "cash_apr", apr: details.cashApr },
      ],
      statementBalance: owedAt(snapshot, "2026-09-30"),
      minimumPayment: details.minimum,
      dueDate: details.dueDate,
      statementIssueDate: "2026-09-30",
    },
  };
}

function bank(bankId: string, bankName: string, accounts: AccountSnapshot[]): DemoBank {
  const ids = new Set(accounts.map((snapshot) => snapshot.id));
  const mine = (txn: TxnRecord) => ids.has(txn.accountId);
  const history = [...posted.filter(mine), ...pending.map(({ held }) => held).filter(mine)];
  const posting = pending.filter(({ held }) => mine(held));
  const pages: FakePage[] = [];
  // Plaid sends at most 500 records a page.
  for (let start = 0; start < history.length || start === 0; start += 500) {
    pages.push({ added: history.slice(start, start + 500) });
  }
  pages.push({
    added: posting.flatMap(({ later }) => (later ? [later] : [])),
    removed: posting.filter(({ later }) => later).map(({ held }) => ({ id: held.id })),
    historyLoaded: true,
  });
  const snapshots = accounts.map(withBalances);
  pages[0] = { ...pages[0], accounts: snapshots };
  return { bankId, bankName, accounts: snapshots, pages };
}

export const DEMO_BANKS: readonly DemoBank[] = [
  bank("fake-ally", "Ally Bank", [ALLY_CHECKING, ALLY_SAVINGS]),
  bank("fake-capital-one", "Capital One", [
    withCard(CAPITAL_ONE, {
      purchaseApr: 28.49,
      cashApr: 29.99,
      minimum: 3_500,
      dueDate: "2026-11-20",
    }),
  ]),
  bank("fake-chase", "Chase", [
    withCard(CHASE, { purchaseApr: 21.24, cashApr: 29.24, minimum: 4_000, dueDate: "2026-11-22" }),
  ]),
  bank("fake-synchrony", "Synchrony Bank", [
    withCard(SYNCHRONY, {
      purchaseApr: 26.99,
      cashApr: 29.99,
      minimum: 6_100,
      dueDate: "2026-11-18",
    }),
  ]),
  bank("fake-larkspur", "Larkspur", [LARKSPUR]),
];

// Every Transaction record of the demo Household, in its banks' pages.
export function demoRecords(): TxnRecord[] {
  return DEMO_BANKS.flatMap((demo) =>
    demo.pages.flatMap((page) => [...(page.added ?? []), ...(page.changed ?? [])]),
  );
}

// Loads the demo Household into app.db through the fake adapter: one Connection for each demo
// bank, then a sync of each. The bank module must be running on `fake`. A bank that already has a
// fake Connection syncs again from its saved cursor, so a second run adds nothing.
export async function seedDemoHousehold(
  database: Database,
  fake: FakeBankAdapter,
  now?: () => Date,
): Promise<void> {
  const existing = await listConnections(database);
  for (const demo of DEMO_BANKS) {
    fake.addPages(demo.bankId, ...demo.pages);
    const found = existing.find(
      (connection) => connection.provider === "fake" && connection.bankId === demo.bankId,
    );
    const connectionId =
      found?.id ??
      (await addConnection(database, {
        provider: "fake",
        bankId: demo.bankId,
        bankName: demo.bankName,
        origin: "linked",
        syncMinute: 17,
      }));
    await syncConnection(connectionId, now);
  }
}
