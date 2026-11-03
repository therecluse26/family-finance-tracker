import { type Category, isSuperstore } from "../categories/index.ts";

// Plaid's v2 categories mapped onto the fixed Category list (spec 04, Provider categories). The
// map is Appendix A of the Transaction categorization research, with the spec's changes: the
// research's "Shopping" is General goods, its "Other" is Miscellaneous, superstores are
// Superstores, sporting goods are Hobbies, and online marketplaces are clean General goods.
// Income, Transfer, and loan codes map to no Category: Money movement decides.

// What one Plaid detailed code maps to. A lossy code always goes on down the cascade, even at
// VERY_HIGH confidence.
export type PlaidCategoryMatch =
  | { kind: "category"; category: Category; lossy: boolean }
  | { kind: "money movement" };

const MONEY_MOVEMENT: PlaidCategoryMatch = Object.freeze({ kind: "money movement" });
const clean = (category: Category): PlaidCategoryMatch =>
  Object.freeze({ kind: "category", category, lossy: false });
const lossy = (category: Category): PlaidCategoryMatch =>
  Object.freeze({ kind: "category", category, lossy: true });

// Each detailed code, by its primary code. Money movement decides every code of these primaries.
const MONEY_MOVEMENT_CODES: Record<string, readonly string[]> = {
  INCOME: [
    "CHILD_SUPPORT",
    "CONTRACTOR",
    "DIVIDENDS",
    "GIG_ECONOMY",
    "INTEREST_EARNED",
    "LONG_TERM_DISABILITY",
    "MILITARY",
    "RENTAL",
    "RETIREMENT_PENSION",
    "SALARY",
    "TAX_REFUND",
    "UNEMPLOYMENT",
    "OTHER",
  ],
  LOAN_DISBURSEMENTS: [
    "AUTO",
    "CASH_ADVANCES",
    "EWA",
    "MORTGAGE",
    "PERSONAL",
    "STUDENT",
    "OTHER_DISBURSEMENT",
  ],
  LOAN_PAYMENTS: [
    "BNPL",
    "CAR_PAYMENT",
    "CASH_ADVANCES",
    "CREDIT_CARD_PAYMENT",
    "EWA",
    "MORTGAGE_PAYMENT",
    "PERSONAL_LOAN_PAYMENT",
    "STUDENT_LOAN_PAYMENT",
    "OTHER_PAYMENT",
  ],
  TRANSFER_IN: [
    "ACCOUNT_TRANSFER",
    "DEPOSIT",
    "INVESTMENT_AND_RETIREMENT_FUNDS",
    "SAVINGS",
    "TRANSFER_IN_FROM_APPS",
    "WIRE",
    "OTHER_TRANSFER_IN",
  ],
  TRANSFER_OUT: [
    "ACCOUNT_TRANSFER",
    "CRYPTO",
    "INVESTMENT_AND_RETIREMENT_FUNDS",
    "SAVINGS",
    "TRANSFER_OUT_FROM_APPS",
    "WIRE",
    "WITHDRAWAL",
    "OTHER_TRANSFER_OUT",
  ],
};

// Each Spending code and its Category.
const SPENDING_CODES: Record<string, PlaidCategoryMatch> = {
  BANK_FEES_ATM_FEES: clean("Interest and fees"),
  BANK_FEES_INSUFFICIENT_FUNDS: clean("Interest and fees"),
  BANK_FEES_INTEREST_CHARGE: clean("Interest and fees"),
  BANK_FEES_FOREIGN_TRANSACTION_FEES: clean("Interest and fees"),
  BANK_FEES_OVERDRAFT_FEES: clean("Interest and fees"),
  BANK_FEES_LATE_FEES: clean("Interest and fees"),
  BANK_FEES_CASH_ADVANCE: clean("Interest and fees"),
  BANK_FEES_OTHER_BANK_FEES: clean("Interest and fees"),

  ENTERTAINMENT_CASINOS_AND_GAMBLING: lossy("Entertainment"),
  ENTERTAINMENT_MUSIC_AND_AUDIO: clean("Entertainment"),
  ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS: clean("Entertainment"),
  ENTERTAINMENT_TV_AND_MOVIES: clean("Entertainment"),
  ENTERTAINMENT_VIDEO_GAMES: clean("Entertainment"),
  ENTERTAINMENT_OTHER_ENTERTAINMENT: clean("Entertainment"),

  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: clean("Alcohol and tobacco"),
  FOOD_AND_DRINK_COFFEE: clean("Restaurants"),
  FOOD_AND_DRINK_FAST_FOOD: clean("Restaurants"),
  FOOD_AND_DRINK_GROCERIES: clean("Groceries"),
  FOOD_AND_DRINK_RESTAURANT: clean("Restaurants"),
  FOOD_AND_DRINK_VENDING_MACHINES: clean("Restaurants"),
  FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK: clean("Restaurants"),

  GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS: clean("Books and education"),
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: clean("Clothing"),
  GENERAL_MERCHANDISE_CONVENIENCE_STORES: lossy("Groceries"),
  GENERAL_MERCHANDISE_DEPARTMENT_STORES: lossy("General goods"),
  GENERAL_MERCHANDISE_DISCOUNT_STORES: lossy("General goods"),
  GENERAL_MERCHANDISE_ELECTRONICS: clean("General goods"),
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: clean("General goods"),
  GENERAL_MERCHANDISE_OFFICE_SUPPLIES: clean("General goods"),
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES: clean("General goods"),
  GENERAL_MERCHANDISE_PET_SUPPLIES: clean("Pets"),
  GENERAL_MERCHANDISE_SPORTING_GOODS: clean("Hobbies"),
  GENERAL_MERCHANDISE_SUPERSTORES: clean("Superstores"),
  GENERAL_MERCHANDISE_TOBACCO_AND_VAPE: clean("Alcohol and tobacco"),
  GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE: lossy("General goods"),

  HOME_IMPROVEMENT_FURNITURE: clean("Home and garden"),
  HOME_IMPROVEMENT_HARDWARE: clean("Home and garden"),
  HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE: clean("Home and garden"),
  HOME_IMPROVEMENT_SECURITY: clean("Home and garden"),
  HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT: clean("Home and garden"),

  MEDICAL_DENTAL_CARE: clean("Health"),
  MEDICAL_EYE_CARE: clean("Health"),
  MEDICAL_NURSING_CARE: clean("Health"),
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS: lossy("Health"),
  MEDICAL_PRIMARY_CARE: clean("Health"),
  MEDICAL_VETERINARY_SERVICES: clean("Pets"),
  MEDICAL_OTHER_MEDICAL: clean("Health"),

  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: clean("Fitness"),
  PERSONAL_CARE_HAIR_AND_BEAUTY: clean("Personal care"),
  PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING: clean("Clothing"),
  PERSONAL_CARE_OTHER_PERSONAL_CARE: clean("Personal care"),

  GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING: clean("Services"),
  GENERAL_SERVICES_AUTOMOTIVE: clean("Car"),
  GENERAL_SERVICES_CHILDCARE: clean("Childcare"),
  GENERAL_SERVICES_CONSULTING_AND_LEGAL: clean("Services"),
  GENERAL_SERVICES_EDUCATION: clean("Books and education"),
  GENERAL_SERVICES_INSURANCE: lossy("Insurance"),
  GENERAL_SERVICES_POSTAGE_AND_SHIPPING: clean("Services"),
  GENERAL_SERVICES_STORAGE: clean("Home and garden"),
  GENERAL_SERVICES_OTHER_GENERAL_SERVICES: lossy("Services"),

  GOVERNMENT_AND_NON_PROFIT_DONATIONS: clean("Gifts and donations"),
  GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES: lossy("Taxes and government"),
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: lossy("Taxes and government"),
  GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT: lossy("Taxes and government"),

  TRANSPORTATION_BIKES_AND_SCOOTERS: clean("Transit and rideshare"),
  TRANSPORTATION_GAS: clean("Gas"),
  TRANSPORTATION_PARKING: clean("Car"),
  TRANSPORTATION_PUBLIC_TRANSIT: clean("Transit and rideshare"),
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: clean("Transit and rideshare"),
  TRANSPORTATION_TOLLS: clean("Car"),
  TRANSPORTATION_OTHER_TRANSPORTATION: clean("Car"),

  TRAVEL_FLIGHTS: clean("Travel"),
  TRAVEL_LODGING: clean("Travel"),
  TRAVEL_RENTAL_CARS: clean("Travel"),
  TRAVEL_OTHER_TRAVEL: clean("Travel"),

  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: clean("Utilities"),
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: clean("Phone and internet"),
  RENT_AND_UTILITIES_RENT: clean("Housing"),
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT: clean("Utilities"),
  RENT_AND_UTILITIES_TELEPHONE: clean("Phone and internet"),
  RENT_AND_UTILITIES_WATER: clean("Utilities"),
  RENT_AND_UTILITIES_OTHER_UTILITIES: clean("Utilities"),

  OTHER_OTHER: lossy("Miscellaneous"),
};

const PLAID_V2: ReadonlyMap<string, PlaidCategoryMatch> = new Map([
  ...Object.entries(MONEY_MOVEMENT_CODES).flatMap(([primary, details]) =>
    details.map((detail) => [`${primary}_${detail}`, MONEY_MOVEMENT] as const),
  ),
  ...Object.entries(SPENDING_CODES),
]);

// Every Plaid v2 detailed code the map knows.
export const PLAID_V2_CODES: readonly string[] = Object.freeze([...PLAID_V2.keys()]);

const SUPERSTORES_MATCH = clean("Superstores");

// What a Plaid v2 detailed code maps to, at the Transaction's Merchant. Any GENERAL_MERCHANDISE_*
// code, or FOOD_AND_DRINK_GROCERIES, at a Merchant on the Superstores list is Superstores, clean.
// A code the map does not know maps to nothing.
export function mapPlaidCategory(
  code: string,
  merchant: { name: string } | null,
): PlaidCategoryMatch | undefined {
  const match = PLAID_V2.get(code);
  if (match === undefined) return undefined;
  const superstoreCode =
    code.startsWith("GENERAL_MERCHANDISE_") || code === "FOOD_AND_DRINK_GROCERIES";
  return superstoreCode && isSuperstore(merchant) ? SUPERSTORES_MATCH : match;
}

// Plaid's confidence levels. UNKNOWN counts as LOW, and so does any level Plaid has not named.
export type PlaidConfidence = "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW";

export function plaidConfidence(level: string | null): PlaidConfidence | null {
  if (level === null) return null;
  return level === "VERY_HIGH" || level === "HIGH" || level === "MEDIUM" ? level : "LOW";
}
