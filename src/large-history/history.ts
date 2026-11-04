import type { FakePage } from "../bank/fake.ts";
import type { AccountSnapshot, TxnRecord } from "../bank/index.ts";

// The large history (CLAUDE.md, K9): 5 years of one made-up Household's bank data, about 20,000
// Transactions, for the fake adapter. It holds each kind of line the bank, Matching,
// Categorization, Merchant and Review list code must handle at scale. Every name, number, and
// amount in it is made up.
//
// The data comes from a fixed seed, so every run builds the same records. Change GENERATOR_VERSION
// with any change to the output, so the cached build is made again.
export const GENERATOR_VERSION = 2;

// The time the history is synced at: the morning after its last day. Recurring charges are
// active or inactive as of this time.
export const HISTORY_NOW = () => new Date("2026-11-01T14:00:00.000Z");

export const HISTORY_FIRST_DAY = "2021-11-01";
export const HISTORY_LAST_DAY = "2026-10-31";
// The day after the history, for a later sync.
export const LATER_DAY = "2026-11-01";

// Each K7 Merchant line (CLAUDE.md), as the bank sends it. Each one is in the history.
export const K7_LINES = [
  "VENMO PAYMENT 1234567890 WEB ID",
  "ZELLE PAYMENT TO 5551234",
  "PAYPAL *INST XFER",
  "CASH APP*SENT",
  "VENMO CASHOUT",
  "VENMO *MORGAN LEE",
  "ZELLE PAYMENT TO JOHN SMITH",
  "PAYPAL *ETSY SHOP",
  "CASH APP*JOHN SMITH",
  "PURCHASE 1005 BLUEBIRD BOOKS",
  "BEST BUY CO",
  "XXXX4821",
  "REF#12345678",
  "(800) 555-1212",
] as const;

export type HistoryBank = {
  bankId: string;
  bankName: string;
  accounts: AccountSnapshot[];
  // The pages a first sync gets: the history 500 records a page, then a page of provider changes
  // and removals.
  pages: FakePage[];
  // A later sync's page: one more day, with one change and one removal.
  laterPage: FakePage;
};

export type GeneratedHistory = {
  banks: HistoryBank[];
  // Every Transaction the first sync leaves showing: the provider's changes applied, and its
  // removals left out. For hand sums.
  shown: TxnRecord[];
  // The provider IDs the first sync's last page changes, and removes.
  changedIds: string[];
  removedIds: string[];
};

// --- Building blocks --------------------------------------------------------------------------

// A small seeded random number generator (mulberry32).
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

// 0 for Sunday, 6 for Saturday.
const weekday = (date: string) => new Date(`${date}T00:00:00.000Z`).getUTCDay();

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
    raw: {
      account_id: fields.id,
      name: fields.name,
      mask: fields.mask,
      type: fields.type,
      subtype: fields.subtype,
    },
    ...fields,
  };
}

// --- The Accounts -----------------------------------------------------------------------------

const CHECKING = account({
  id: "lh-checking",
  name: "Everyday Checking",
  type: "depository",
  subtype: "checking",
  mask: "4417",
  currentBalance: 612_250,
  availableBalance: 612_250,
});
const SAVINGS = account({
  id: "lh-savings",
  name: "High Yield Savings",
  type: "depository",
  subtype: "savings",
  mask: "8802",
  currentBalance: 2_418_000,
  availableBalance: 2_418_000,
});
// Its payments name only the bank.
const MERIDIAN_CARD = account({
  id: "lh-meridian-card",
  name: "Meridian Rewards",
  type: "credit",
  subtype: "credit card",
  mask: "3391",
  currentBalance: -184_420,
  creditLimit: 900_000,
  card: {
    aprs: [{ type: "purchase_apr", apr: 24.99 }],
    statementBalance: -171_300,
    minimumPayment: 3_500,
    dueDate: "2026-11-20",
    statementIssueDate: "2026-10-24",
  },
});
// Its payments name its last 4 digits.
const HARBOR_CARD = account({
  id: "lh-harbor-card",
  name: "Harbor Cash Card",
  type: "credit",
  subtype: "credit card",
  mask: "7731",
  currentBalance: -96_115,
  creditLimit: 1_500_000,
  card: {
    aprs: [{ type: "purchase_apr", apr: 21.49 }],
    statementBalance: -88_040,
    minimumPayment: 4_000,
    dueDate: "2026-11-22",
    statementIssueDate: "2026-10-26",
  },
});
const AUTO_LOAN = account({
  id: "lh-auto-loan",
  name: "Auto Loan",
  type: "loan",
  subtype: "auto",
  mask: "5150",
  currentBalance: -412_380,
  loan: {
    apr: 6.9,
    principal: 3_200_000,
    interestPaidThisYear: 31_870,
    minimumPayment: 61_250,
    dueDate: "2026-11-05",
  },
});
const BROKERAGE = account({
  id: "lh-brokerage",
  name: "Individual Brokerage",
  type: "investment",
  subtype: "brokerage",
  mask: "2290",
  currentBalance: 4_870_400,
});

const LAKESHORE = { name: "Lakeshore Credit Union", type: "financial_institution" };
const MERIDIAN = { name: "Meridian Card Services", type: "financial_institution" };
const HARBOR = { name: "Harbor National Bank", type: "financial_institution" };
const SUMMIT = { name: "Summit Auto Finance", type: "financial_institution" };
const BRIGHTPATH = { name: "Brightpath Investing", type: "financial_institution" };
// A bank the Household keeps no Connection to, so Transfers to it show on one side only.
const NORTHGATE = { name: "Northgate Bank", type: "financial_institution", mask: "6014" };

// --- Lines ------------------------------------------------------------------------------------

type Line = {
  account: AccountSnapshot;
  date: string;
  // Whole cents. Money into the Account is positive.
  amount: number;
  description: string;
  // The provider's Merchant name. Each one gets a provider Merchant ID.
  merchant?: string;
  // Plaid's detailed category code, or none.
  category?: string;
  confidence?: "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  parties?: { name: string; type: string }[];
};

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function record(id: string, line: Line): TxnRecord {
  const parties = [
    ...(line.merchant === undefined ? [] : [{ name: line.merchant, type: "merchant" }]),
    ...(line.parties ?? []),
  ];
  const confidence = line.confidence ?? "HIGH";
  return {
    id,
    accountId: line.account.id,
    amount: line.amount,
    postedDate: line.date,
    authorizedDate: null,
    pending: false,
    pendingTransactionId: null,
    description: line.description,
    merchantName: line.merchant ?? null,
    merchantId: line.merchant === undefined ? null : `lh-merchant-${slug(line.merchant)}`,
    counterparties: parties,
    category:
      line.category === undefined
        ? null
        : { name: line.category, confidence, version: "v2", mcc: null },
    raw: {
      transaction_id: id,
      account_id: line.account.id,
      // Plaid's amount is in dollars, and positive for money out.
      amount: -line.amount / 100,
      iso_currency_code: "USD",
      date: line.date,
      name: line.description,
      merchant_name: line.merchant ?? null,
      personal_finance_category:
        line.category === undefined
          ? null
          : { detailed: line.category, confidence_level: confidence, version: "v2" },
    },
  };
}

// --- The history ------------------------------------------------------------------------------

// Builds the records in a fixed order from a fixed seed, so each call returns the same history.
export function generateHistory(): GeneratedHistory {
  const random = seeded(20_211_101);
  const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
  const chance = (p: number) => random() < p;
  const pick = <T>(list: readonly T[]): T => list[between(0, list.length - 1)] as T;
  const confidence = (): NonNullable<Line["confidence"]> => {
    const roll = random();
    if (roll < 0.55) return "VERY_HIGH";
    if (roll < 0.83) return "HIGH";
    if (roll < 0.93) return "MEDIUM";
    if (roll < 0.98) return "LOW";
    return "UNKNOWN";
  };

  const lines: Line[] = [];
  const add = (line: Line) => lines.push(line);
  // Card charges by card and month (YYYY-MM), for the next month's card payment.
  const charged = new Map<string, number>();
  const charge = (line: Line) => {
    add(line);
    const key = `${line.account.id} ${line.date.slice(0, 7)}`;
    charged.set(key, (charged.get(key) ?? 0) - line.amount);
  };
  const card = () => (chance(0.55) ? MERIDIAN_CARD : HARBOR_CARD);
  const k7Seen = new Set<string>();
  const k7 = (line: Line) => {
    k7Seen.add(line.description);
    if (line.account.type === "credit") charge(line);
    else add(line);
  };

  // Daily small purchases, payment apps, and the K7 lines.
  for (let date = HISTORY_FIRST_DAY; date <= HISTORY_LAST_DAY; date = addDays(date, 1)) {
    const weekend = weekday(date) === 0 || weekday(date) === 6;
    charge({
      account: card(),
      date,
      amount: -between(325, 875),
      description: pick(["DAILY GRIND COFFEE #114", "SQ *CORNER BEAN", "TST* MORNING ROAST"]),
      merchant: pick(["Daily Grind Coffee", "Corner Bean", "Morning Roast"]),
      category: "FOOD_AND_DRINK_COFFEE",
      confidence: confidence(),
    });
    for (let meal = between(weekend ? 2 : 1, 3); meal > 0; meal -= 1) {
      const [description, merchant, category] = pick([
        ["TST* PINE STREET TAVERN", "Pine Street Tavern", "FOOD_AND_DRINK_RESTAURANT"],
        ["TAQUERIA EL SOL 0042", "Taqueria El Sol", "FOOD_AND_DRINK_RESTAURANT"],
        ["NOODLE HOUSE #12", "Noodle House", "FOOD_AND_DRINK_RESTAURANT"],
        ["BURGER BARN 2231", "Burger Barn", "FOOD_AND_DRINK_FAST_FOOD"],
        ["SUBSTATION SANDWICHES", "Substation", "FOOD_AND_DRINK_FAST_FOOD"],
      ] as const);
      charge({
        account: card(),
        date,
        amount: -between(900, 6_800),
        description,
        merchant,
        category,
        confidence: confidence(),
      });
    }
    if (chance(0.5)) {
      charge({
        account: card(),
        date,
        amount: -between(2_500, 19_000),
        description: `GREEN GROCER ${between(1001, 1009)}`,
        merchant: "Green Grocer",
        category: "FOOD_AND_DRINK_GROCERIES",
        confidence: confidence(),
      });
    }
    if (chance(0.25)) {
      charge({
        account: card(),
        date,
        amount: -between(2_800, 7_200),
        description: `QUICKFUEL #${between(4400, 4499)}`,
        merchant: "QuickFuel",
        category: "TRANSPORTATION_GAS",
        confidence: "VERY_HIGH",
      });
    }
    for (let order = chance(0.7) ? between(1, 2) : 0; order > 0; order -= 1) {
      charge({
        account: card(),
        date,
        amount: -between(899, 12_999),
        description: `SHOPMART MKTPLACE*${between(100_000, 999_999)}`,
        merchant: "ShopMart Marketplace",
        category: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES",
        confidence: chance(0.5) ? "MEDIUM" : "HIGH",
      });
    }
    // Shops, some with no provider Merchant name or category, as small banks send them.
    for (let shop = between(0, 4); shop > 0; shop -= 1) {
      const [description, merchant, category] = pick([
        ["WALGREENS #7731", "Walgreens", "MEDICAL_PHARMACIES_AND_SUPPLEMENTS"],
        ["HOMEWORKS SUPPLY #1187", "HomeWorks Supply", "HOME_IMPROVEMENT_HARDWARE"],
        ["THREADLINE CLOTHING", "Threadline", "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES"],
        ["PAWS & CLAWS PET", undefined, "GENERAL_MERCHANDISE_PET_SUPPLIES"],
        ["CORNER MART 55", undefined, undefined],
        ["CITY PARKING 0091", undefined, "TRANSPORTATION_PARKING"],
        ["RIDESHARE *TRIP", "Rideshare", "TRANSPORTATION_TAXIS_AND_RIDE_SHARES"],
        ["METRO TRANSIT FARE", "Metro Transit", "TRANSPORTATION_PUBLIC_TRANSIT"],
      ] as const);
      charge({
        account: card(),
        date,
        amount: -between(400, 9_500),
        description,
        ...(merchant === undefined ? {} : { merchant }),
        ...(category === undefined ? {} : { category, confidence: confidence() }),
      });
    }
    // The K7 store lines: store numbers, lead-ins, and digit runs.
    if (chance(0.5)) {
      const description = pick([
        "PURCHASE 1005 BLUEBIRD BOOKS",
        "BEST BUY CO",
        "XXXX4821",
        "REF#12345678",
        "(800) 555-1212",
      ]);
      k7({
        account: card(),
        date,
        amount: -between(1_200, 24_000),
        description,
        ...(description === "BEST BUY CO"
          ? { merchant: "Best Buy", category: "GENERAL_MERCHANDISE_ELECTRONICS" }
          : {}),
      });
    }
    // Payment apps, in each K7 form. None of these carries a provider Merchant name.
    for (let app = between(0, 4); app > 0; app -= 1) {
      const form = between(0, 8);
      const venmo = { name: "Venmo", type: "payment_app" };
      const zelle = { name: "Zelle", type: "payment_app" };
      const paypal = { name: "PayPal", type: "payment_app" };
      const cashApp = { name: "Cash App", type: "payment_app" };
      const out = -between(1_000, 15_000);
      if (form === 0) {
        k7({
          account: CHECKING,
          date,
          amount: out,
          description: "VENMO PAYMENT 1234567890 WEB ID",
          category: "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS",
          parties: [venmo],
        });
      } else if (form === 1) {
        k7({ account: CHECKING, date, amount: out, description: "ZELLE PAYMENT TO 5551234" });
      } else if (form === 2) {
        k7({ account: card(), date, amount: out, description: "PAYPAL *INST XFER" });
      } else if (form === 3) {
        k7({ account: CHECKING, date, amount: out, description: "CASH APP*SENT" });
      } else if (form === 4) {
        k7({
          account: CHECKING,
          date,
          amount: between(2_000, 20_000),
          description: "VENMO CASHOUT",
          category: "TRANSFER_IN_TRANSFER_IN_FROM_APPS",
          confidence: "MEDIUM",
          parties: [venmo],
        });
      } else if (form === 5) {
        k7({ account: card(), date, amount: out, description: "VENMO *MORGAN LEE" });
      } else if (form === 6) {
        k7({
          account: CHECKING,
          date,
          amount: out,
          description: "ZELLE PAYMENT TO JOHN SMITH",
          category: "TRANSFER_OUT_ACCOUNT_TRANSFER",
          confidence: "LOW",
          parties: [zelle],
        });
      } else if (form === 7) {
        k7({
          account: card(),
          date,
          amount: out,
          description: "PAYPAL *ETSY SHOP",
          category: "GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES",
          parties: [paypal],
        });
      } else {
        k7({
          account: CHECKING,
          date,
          amount: out,
          description: "CASH APP*JOHN SMITH",
          parties: [cashApp],
        });
      }
    }
    // Cash at an ATM, sometimes with a fee.
    if (chance(0.09)) {
      add({
        account: CHECKING,
        date,
        amount: -between(2, 12) * 2_000,
        description: `ATM WITHDRAWAL 00${between(4000, 4999)} MAIN ST`,
        category: "TRANSFER_OUT_WITHDRAWAL",
        confidence: "VERY_HIGH",
      });
      if (chance(0.3)) {
        add({
          account: CHECKING,
          date,
          amount: -350,
          description: "ATM FEE",
          category: "BANK_FEES_ATM_FEES",
          confidence: "VERY_HIGH",
        });
      }
    }
    // A Refund: money back from the Merchant of a purchase a few days before.
    if (chance(0.08)) {
      const amount = between(1_500, 15_000);
      const bought = addDays(date, -between(3, 12));
      const on = card();
      if (bought >= HISTORY_FIRST_DAY) {
        charge({
          account: on,
          date: bought,
          amount: -amount,
          description: "THREADLINE CLOTHING",
          merchant: "Threadline",
          category: "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES",
        });
        charge({
          account: on,
          date,
          amount,
          description: "THREADLINE CLOTHING RETURN",
          merchant: "Threadline",
          category: "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES",
          confidence: "MEDIUM",
        });
      }
    }
  }

  // Weekly Transfers from checking to savings, both connected, at the same bank.
  for (let date = "2021-11-05"; date <= HISTORY_LAST_DAY; date = addDays(date, 7)) {
    const amount = between(5, 30) * 1_000;
    add({
      account: CHECKING,
      date,
      amount: -amount,
      description: `ONLINE TRANSFER TO SAVINGS XXXXXX${SAVINGS.mask}`,
      category: "TRANSFER_OUT_ACCOUNT_TRANSFER",
      confidence: "VERY_HIGH",
      parties: [LAKESHORE],
    });
    add({
      account: SAVINGS,
      date,
      amount,
      description: `ONLINE TRANSFER FROM CHECKING XXXXXX${CHECKING.mask}`,
      category: "TRANSFER_IN_ACCOUNT_TRANSFER",
      confidence: "VERY_HIGH",
      parties: [LAKESHORE],
    });
  }

  // Payroll Income every 2 weeks, on Fridays, and a second job paid on the 15th and the last day.
  for (let date = "2021-11-05"; date <= HISTORY_LAST_DAY; date = addDays(date, 14)) {
    add({
      account: CHECKING,
      date,
      amount: 214_018 + Math.floor((Number(date.slice(0, 4)) - 2021) * 6_500),
      description: "LAKEVIEW HEALTH PAYROLL PPD ID: 4419920137",
      merchant: "Lakeview Health",
      category: "INCOME_SALARY",
      confidence: "VERY_HIGH",
    });
  }

  // Each month of the history, as YYYY-MM.
  const months: string[] = [];
  for (
    let month = HISTORY_FIRST_DAY.slice(0, 7);
    month <= HISTORY_LAST_DAY.slice(0, 7);
    month = addDays(`${month}-28`, 4).slice(0, 7)
  ) {
    months.push(month);
  }
  // A day in a month, moved to the month's last day when the month is shorter.
  const dayOf = (month: string, day: number) => {
    const last = Number(addDays(`${addDays(`${month}-28`, 4).slice(0, 7)}-01`, -1).slice(8));
    return `${month}-${String(Math.min(day, last)).padStart(2, "0")}`;
  };

  for (const [index, month] of months.entries()) {
    for (const day of [15, 31]) {
      add({
        account: CHECKING,
        date: dayOf(month, day),
        amount: 162_500,
        description: "NORTHWIND LOGISTICS DIR DEP",
        merchant: "Northwind Logistics",
        category: "INCOME_SALARY",
        confidence: "HIGH",
      });
    }
    // Rent, utilities, and other Recurring charges.
    add({
      account: CHECKING,
      date: dayOf(month, 1),
      amount: -(215_000 + Math.floor(index / 12) * 7_500),
      description: "RIVERBEND APARTMENTS RENT WEB PMT",
      merchant: "Riverbend Apartments",
      category: "RENT_AND_UTILITIES_RENT",
      confidence: "HIGH",
    });
    for (const [day, description, merchant, category, low, high] of [
      [9, "CITY UTILITIES BILLPAY", "City Utilities", "RENT_AND_UTILITIES_WATER", 6_800, 11_200],
      [
        11,
        "VOLTRA ENERGY AUTOPAY",
        "Voltra Energy",
        "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY",
        7_400,
        21_900,
      ],
      [
        12,
        "BRIGHTWAVE WIRELESS AUTOPAY",
        "Brightwave Wireless",
        "RENT_AND_UTILITIES_TELEPHONE",
        8_400,
        8_900,
      ],
      [
        14,
        "FIBERLINE INTERNET",
        "Fiberline",
        "RENT_AND_UTILITIES_INTERNET_AND_CABLE",
        6_999,
        6_999,
      ],
      [
        20,
        "SHIELD MUTUAL INSURANCE",
        "Shield Mutual",
        "GENERAL_SERVICES_INSURANCE",
        18_450,
        18_450,
      ],
    ] as const) {
      add({
        account: CHECKING,
        date: dayOf(month, day),
        amount: -between(low, high),
        description,
        merchant,
        category,
        confidence: "VERY_HIGH",
      });
    }
    for (const [day, description, merchant, category, amount, on] of [
      [
        8,
        "STREAMFLIX.COM 866-555-0142",
        "Streamflix",
        "ENTERTAINMENT_TV_AND_MOVIES",
        1_549,
        MERIDIAN_CARD,
      ],
      [
        18,
        "TUNEBOX MUSIC SUBSCRIPTION",
        "Tunebox",
        "ENTERTAINMENT_MUSIC_AND_AUDIO",
        1_199,
        MERIDIAN_CARD,
      ],
      [
        2,
        "IRONWORKS FITNESS CLUB DUES",
        "Ironworks Fitness",
        "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS",
        4_999,
        HARBOR_CARD,
      ],
      [21, "CLOUDVAULT STORAGE", "CloudVault", "GENERAL_SERVICES_STORAGE", 299, HARBOR_CARD],
    ] as const) {
      charge({
        account: on,
        date: dayOf(month, day),
        // The streaming price goes up each January.
        amount: -(
          amount + (description.startsWith("STREAMFLIX") ? Math.floor(index / 12) * 200 : 0)
        ),
        description,
        merchant,
        category,
        confidence: "VERY_HIGH",
      });
    }
    if (month.endsWith("-06")) {
      charge({
        account: HARBOR_CARD,
        date: dayOf(month, 14),
        amount: -13_900,
        description: "SHOPMART PLUS*ANNUAL MEMBERSHIP",
        merchant: "ShopMart Plus",
        category: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES",
      });
    }
    // Interest on savings, and a monthly Transfer from savings back to checking.
    add({
      account: SAVINGS,
      date: dayOf(month, 31),
      amount: between(2_100, 9_800),
      description: "DIVIDEND/INTEREST PAID",
      category: "INCOME_INTEREST_EARNED",
      confidence: "VERY_HIGH",
      parties: [LAKESHORE],
    });
    if (index % 4 === 2) {
      const amount = between(20, 80) * 1_000;
      add({
        account: SAVINGS,
        date: dayOf(month, 16),
        amount: -amount,
        description: `ONLINE TRANSFER TO CHECKING XXXXXX${CHECKING.mask}`,
        category: "TRANSFER_OUT_ACCOUNT_TRANSFER",
        confidence: "VERY_HIGH",
        parties: [LAKESHORE],
      });
      add({
        account: CHECKING,
        date: dayOf(month, 16),
        amount,
        description: `ONLINE TRANSFER FROM SAVINGS XXXXXX${SAVINGS.mask}`,
        category: "TRANSFER_IN_ACCOUNT_TRANSFER",
        confidence: "VERY_HIGH",
        parties: [LAKESHORE],
      });
    }
    // One-sided Transfers: to and from a bank with no Connection.
    add({
      account: CHECKING,
      date: dayOf(month, 3),
      amount: -50_000,
      description: `ONLINE TRANSFER TO NORTHGATE BANK XXXXXX${NORTHGATE.mask}`,
      category: "TRANSFER_OUT_ACCOUNT_TRANSFER",
      confidence: "HIGH",
      parties: [{ name: NORTHGATE.name, type: NORTHGATE.type }],
    });
    if (index % 6 === 5) {
      add({
        account: CHECKING,
        date: dayOf(month, 26),
        amount: 120_000,
        description: `ONLINE TRANSFER FROM NORTHGATE BANK XXXXXX${NORTHGATE.mask}`,
        category: "TRANSFER_IN_ACCOUNT_TRANSFER",
        confidence: "HIGH",
        parties: [{ name: NORTHGATE.name, type: NORTHGATE.type }],
      });
    }
    // The connected auto loan's payment, on both sides.
    add({
      account: CHECKING,
      date: dayOf(month, 5),
      amount: -61_250,
      description: `SUMMIT AUTO LOAN PMT ${AUTO_LOAN.mask}`,
      category: "LOAN_PAYMENTS_CAR_PAYMENT",
      confidence: "VERY_HIGH",
      parties: [SUMMIT],
    });
    add({
      account: AUTO_LOAN,
      date: dayOf(month, 6),
      amount: 61_250,
      description: "PAYMENT RECEIVED - THANK YOU",
      category: "LOAN_PAYMENTS_CAR_PAYMENT",
      confidence: "HIGH",
    });
    // Saving: a monthly Transfer to the brokerage Account, and dividends each quarter.
    add({
      account: CHECKING,
      date: dayOf(month, 7),
      amount: -50_000,
      description: "BRIGHTPATH INVESTING ACH TRANSFER",
      category: "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS",
      confidence: "VERY_HIGH",
      parties: [BRIGHTPATH],
    });
    add({
      account: BROKERAGE,
      date: dayOf(month, 8),
      amount: 50_000,
      description: "ACH DEPOSIT LAKESHORE CU",
      category: "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS",
      confidence: "HIGH",
      parties: [LAKESHORE],
    });
    if (index % 3 === 1) {
      add({
        account: BROKERAGE,
        date: dayOf(month, 28),
        amount: between(8_000, 26_000),
        description: "DIVIDEND RECEIVED",
        category: "INCOME_DIVIDENDS",
        confidence: "VERY_HIGH",
      });
    }
    // Twice a year, money from savings to the brokerage Account with nothing that ties the two
    // sides: no last 4 digits, no bank name, no Plaid category, and no earlier Transfer between
    // them. Pairing asks about each one: an Unclear pair on the Review list.
    if (index % 6 === 1) {
      const amount = 40_017 + index * 101;
      add({
        account: SAVINGS,
        date: dayOf(month, 12),
        amount: -amount,
        description: "WEB XFER OUT",
      });
      add({ account: BROKERAGE, date: dayOf(month, 13), amount, description: "INCOMING FUNDS" });
    }
    // Twice a year, two Transfers from checking to savings on the same day, for the same amount.
    // Either way of pairing them is as good, so the app guesses: a Transfer pair guess.
    if (index % 6 === 4) {
      const amount = 10_037 + index * 101;
      for (let n = 0; n < 2; n += 1) {
        add({
          account: CHECKING,
          date: dayOf(month, 23),
          amount: -amount,
          description: `ONLINE TRANSFER TO SAVINGS XXXXXX${SAVINGS.mask}`,
          category: "TRANSFER_OUT_ACCOUNT_TRANSFER",
          confidence: "VERY_HIGH",
          parties: [LAKESHORE],
        });
        add({
          account: SAVINGS,
          date: dayOf(month, 23),
          amount,
          description: `ONLINE TRANSFER FROM CHECKING XXXXXX${CHECKING.mask}`,
          category: "TRANSFER_IN_ACCOUNT_TRANSFER",
          confidence: "VERY_HIGH",
          parties: [LAKESHORE],
        });
      }
    }
  }

  // Card payments from checking, each month, for the month before's charges. Meridian lines name
  // only the bank; Harbor lines name the card's last 4 digits.
  for (const month of months.slice(1)) {
    const before = months[months.indexOf(month) - 1] as string;
    for (const [on, day, out, received, bank] of [
      [MERIDIAN_CARD, 20, "MERIDIAN CARD ONLINE PMT", "ONLINE PAYMENT RECEIVED", MERIDIAN],
      [
        HARBOR_CARD,
        22,
        `PAYMENT TO HARBOR CARD ENDING IN ${HARBOR_CARD.mask}`,
        "PAYMENT THANK YOU",
        HARBOR,
      ],
    ] as const) {
      const amount = charged.get(`${on.id} ${before}`) ?? 0;
      if (amount <= 0) continue;
      const paid = dayOf(month, day);
      add({
        account: CHECKING,
        date: paid,
        amount: -amount,
        description: out,
        category: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
        confidence: "VERY_HIGH",
        parties: [bank],
      });
      add({
        account: on,
        date: addDays(paid, 1),
        amount,
        description: received,
        category: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
        confidence: "HIGH",
      });
    }
  }

  for (const description of K7_LINES) {
    if (!k7Seen.has(description)) throw new Error(`The history has no "${description}" line.`);
  }

  // Provider IDs in a fixed order: by date, then in the order the lines were made.
  const byDate = lines
    .map((line, order) => ({ line, order }))
    .sort((a, b) => a.line.date.localeCompare(b.line.date) || a.order - b.order);
  const records = byDate.map(({ line }, n) => record(`lh-${String(n).padStart(6, "0")}`, line));

  // The provider's changes and removals, in the first sync's last page: a tip added to a meal, a
  // card payment's amount corrected, a grocery bill fixed, a duplicate coffee, a Refund, and an
  // order removed.
  const last = (test: (txn: TxnRecord) => boolean, skip = 0) =>
    records.filter(test).at(-1 - skip) as TxnRecord;
  const changed = [
    { txn: last((txn) => txn.description === "NOODLE HOUSE #12"), by: -900 },
    { txn: last((txn) => txn.description === "MERIDIAN CARD ONLINE PMT", 1), by: -1_000 },
    { txn: last((txn) => txn.description.startsWith("GREEN GROCER")), by: 250 },
    { txn: last((txn) => txn.description === "VENMO CASHOUT"), by: 500 },
  ].map(({ txn, by }) => ({ ...txn, amount: txn.amount + by }));
  const removed = [
    last((txn) => txn.category?.name === "FOOD_AND_DRINK_COFFEE", 3),
    last((txn) => txn.description === "THREADLINE CLOTHING RETURN"),
    last((txn) => txn.description.startsWith("SHOPMART MKTPLACE*"), 5),
  ].map((txn) => txn.id);

  const changedById = new Map(changed.map((txn) => [txn.id, txn]));
  const shown = records
    .filter((txn) => !removed.includes(txn.id))
    .map((txn) => changedById.get(txn.id) ?? txn);

  // One more day, for a later sync: a few lines on each bank's Accounts, one change, and one
  // removal.
  const laterLines: Line[] = [
    {
      account: MERIDIAN_CARD,
      date: LATER_DAY,
      amount: -645,
      description: "DAILY GRIND COFFEE #114",
      merchant: "Daily Grind Coffee",
      category: "FOOD_AND_DRINK_COFFEE",
    },
    {
      account: HARBOR_CARD,
      date: LATER_DAY,
      amount: -4_210,
      description: "TST* PINE STREET TAVERN",
      merchant: "Pine Street Tavern",
      category: "FOOD_AND_DRINK_RESTAURANT",
    },
    { account: CHECKING, date: LATER_DAY, amount: -2_500, description: "VENMO *MORGAN LEE" },
    {
      account: CHECKING,
      date: LATER_DAY,
      amount: -25_000,
      description: `ONLINE TRANSFER TO SAVINGS XXXXXX${SAVINGS.mask}`,
      category: "TRANSFER_OUT_ACCOUNT_TRANSFER",
      parties: [LAKESHORE],
    },
    {
      account: SAVINGS,
      date: LATER_DAY,
      amount: 25_000,
      description: `ONLINE TRANSFER FROM CHECKING XXXXXX${CHECKING.mask}`,
      category: "TRANSFER_IN_ACCOUNT_TRANSFER",
      parties: [LAKESHORE],
    },
    {
      account: BROKERAGE,
      date: LATER_DAY,
      amount: 14_200,
      description: "DIVIDEND RECEIVED",
      category: "INCOME_DIVIDENDS",
    },
  ];
  const laterRecords = laterLines.map((line, n) => record(`lh-later-${n}`, line));
  const laterChanged = last((txn) => txn.description === "TST* PINE STREET TAVERN");
  const laterRemoved = last((txn) => txn.description.startsWith("SHOPMART MKTPLACE*"), 9);

  const BANKS = [
    { bankId: "fake-lh-lakeshore", bankName: LAKESHORE.name, accounts: [CHECKING, SAVINGS] },
    { bankId: "fake-lh-meridian", bankName: MERIDIAN.name, accounts: [MERIDIAN_CARD] },
    { bankId: "fake-lh-harbor", bankName: HARBOR.name, accounts: [HARBOR_CARD] },
    { bankId: "fake-lh-summit", bankName: SUMMIT.name, accounts: [AUTO_LOAN] },
    { bankId: "fake-lh-brightpath", bankName: BRIGHTPATH.name, accounts: [BROKERAGE] },
  ];
  const banks = BANKS.map(({ bankId, bankName, accounts }) => {
    const ids = new Set(accounts.map((snapshot) => snapshot.id));
    const mine = (txn: TxnRecord) => ids.has(txn.accountId);
    const history = records.filter(mine);
    const pages: FakePage[] = [];
    // Plaid sends at most 500 records a page.
    for (let start = 0; start < history.length; start += 500) {
      pages.push({ added: history.slice(start, start + 500) });
    }
    pages.push({
      changed: changed.filter(mine),
      removed: removed.filter((id) => history.some((txn) => txn.id === id)).map((id) => ({ id })),
      historyLoaded: true,
    });
    pages[0] = { ...pages[0], accounts };
    const laterPage: FakePage = {
      added: laterRecords.filter(mine),
      changed: [laterChanged]
        .filter(mine)
        .map((txn) => ({ ...(changedById.get(txn.id) ?? txn), amount: txn.amount - 600 })),
      removed: [laterRemoved].filter(mine).map((txn) => ({ id: txn.id })),
      historyLoaded: true,
    };
    return { bankId, bankName, accounts, pages, laterPage };
  });

  return {
    banks,
    shown,
    changedIds: changed.map((txn) => txn.id),
    removedIds: removed,
  };
}
