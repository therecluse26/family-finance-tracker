import { describe, expect, it } from "vitest";
import { isCategory } from "../categories/index.ts";
import { mapPlaidCategory, PLAID_V2_CODES, plaidConfidence } from "./index.ts";

// Plaid v2 categories mapped onto the fixed Category list (spec 04, Provider categories). The
// category data here is made up; no test reaches Plaid.

// Every detailed code in Appendix A of the Transaction categorization research, which lists
// Plaid's pfc-taxonomy-all.csv: 127 codes under 18 primary codes.
const PLAID_V2_DETAILED = `
  INCOME_CHILD_SUPPORT
  INCOME_CONTRACTOR
  INCOME_DIVIDENDS
  INCOME_GIG_ECONOMY
  INCOME_INTEREST_EARNED
  INCOME_LONG_TERM_DISABILITY
  INCOME_MILITARY
  INCOME_RENTAL
  INCOME_RETIREMENT_PENSION
  INCOME_SALARY
  INCOME_TAX_REFUND
  INCOME_UNEMPLOYMENT
  INCOME_OTHER
  LOAN_DISBURSEMENTS_AUTO
  LOAN_DISBURSEMENTS_CASH_ADVANCES
  LOAN_DISBURSEMENTS_EWA
  LOAN_DISBURSEMENTS_MORTGAGE
  LOAN_DISBURSEMENTS_PERSONAL
  LOAN_DISBURSEMENTS_STUDENT
  LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT
  LOAN_PAYMENTS_BNPL
  LOAN_PAYMENTS_CAR_PAYMENT
  LOAN_PAYMENTS_CASH_ADVANCES
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT
  LOAN_PAYMENTS_EWA
  LOAN_PAYMENTS_MORTGAGE_PAYMENT
  LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT
  LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT
  LOAN_PAYMENTS_OTHER_PAYMENT
  TRANSFER_IN_ACCOUNT_TRANSFER
  TRANSFER_IN_DEPOSIT
  TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS
  TRANSFER_IN_SAVINGS
  TRANSFER_IN_TRANSFER_IN_FROM_APPS
  TRANSFER_IN_WIRE
  TRANSFER_IN_OTHER_TRANSFER_IN
  TRANSFER_OUT_ACCOUNT_TRANSFER
  TRANSFER_OUT_CRYPTO
  TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS
  TRANSFER_OUT_SAVINGS
  TRANSFER_OUT_TRANSFER_OUT_FROM_APPS
  TRANSFER_OUT_WIRE
  TRANSFER_OUT_WITHDRAWAL
  TRANSFER_OUT_OTHER_TRANSFER_OUT
  BANK_FEES_ATM_FEES
  BANK_FEES_INSUFFICIENT_FUNDS
  BANK_FEES_INTEREST_CHARGE
  BANK_FEES_FOREIGN_TRANSACTION_FEES
  BANK_FEES_OVERDRAFT_FEES
  BANK_FEES_LATE_FEES
  BANK_FEES_CASH_ADVANCE
  BANK_FEES_OTHER_BANK_FEES
  ENTERTAINMENT_CASINOS_AND_GAMBLING
  ENTERTAINMENT_MUSIC_AND_AUDIO
  ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS
  ENTERTAINMENT_TV_AND_MOVIES
  ENTERTAINMENT_VIDEO_GAMES
  ENTERTAINMENT_OTHER_ENTERTAINMENT
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR
  FOOD_AND_DRINK_COFFEE
  FOOD_AND_DRINK_FAST_FOOD
  FOOD_AND_DRINK_GROCERIES
  FOOD_AND_DRINK_RESTAURANT
  FOOD_AND_DRINK_VENDING_MACHINES
  FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK
  GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES
  GENERAL_MERCHANDISE_CONVENIENCE_STORES
  GENERAL_MERCHANDISE_DEPARTMENT_STORES
  GENERAL_MERCHANDISE_DISCOUNT_STORES
  GENERAL_MERCHANDISE_ELECTRONICS
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES
  GENERAL_MERCHANDISE_OFFICE_SUPPLIES
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES
  GENERAL_MERCHANDISE_PET_SUPPLIES
  GENERAL_MERCHANDISE_SPORTING_GOODS
  GENERAL_MERCHANDISE_SUPERSTORES
  GENERAL_MERCHANDISE_TOBACCO_AND_VAPE
  GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE
  HOME_IMPROVEMENT_FURNITURE
  HOME_IMPROVEMENT_HARDWARE
  HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE
  HOME_IMPROVEMENT_SECURITY
  HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT
  MEDICAL_DENTAL_CARE
  MEDICAL_EYE_CARE
  MEDICAL_NURSING_CARE
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS
  MEDICAL_PRIMARY_CARE
  MEDICAL_VETERINARY_SERVICES
  MEDICAL_OTHER_MEDICAL
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS
  PERSONAL_CARE_HAIR_AND_BEAUTY
  PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING
  PERSONAL_CARE_OTHER_PERSONAL_CARE
  GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING
  GENERAL_SERVICES_AUTOMOTIVE
  GENERAL_SERVICES_CHILDCARE
  GENERAL_SERVICES_CONSULTING_AND_LEGAL
  GENERAL_SERVICES_EDUCATION
  GENERAL_SERVICES_INSURANCE
  GENERAL_SERVICES_POSTAGE_AND_SHIPPING
  GENERAL_SERVICES_STORAGE
  GENERAL_SERVICES_OTHER_GENERAL_SERVICES
  GOVERNMENT_AND_NON_PROFIT_DONATIONS
  GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT
  GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT
  TRANSPORTATION_BIKES_AND_SCOOTERS
  TRANSPORTATION_GAS
  TRANSPORTATION_PARKING
  TRANSPORTATION_PUBLIC_TRANSIT
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES
  TRANSPORTATION_TOLLS
  TRANSPORTATION_OTHER_TRANSPORTATION
  TRAVEL_FLIGHTS
  TRAVEL_LODGING
  TRAVEL_RENTAL_CARS
  TRAVEL_OTHER_TRAVEL
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY
  RENT_AND_UTILITIES_INTERNET_AND_CABLE
  RENT_AND_UTILITIES_RENT
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT
  RENT_AND_UTILITIES_TELEPHONE
  RENT_AND_UTILITIES_WATER
  RENT_AND_UTILITIES_OTHER_UTILITIES
  OTHER_OTHER
`
  .trim()
  .split(/\s+/);

const at = (name: string) => ({ name });

describe("the Plaid v2 category map", () => {
  it("has an entry for every Plaid v2 detailed code, and no other", () => {
    expect(PLAID_V2_DETAILED).toHaveLength(127);
    expect([...PLAID_V2_CODES].sort()).toEqual([...PLAID_V2_DETAILED].sort());
    for (const code of PLAID_V2_DETAILED) {
      const match = mapPlaidCategory(code, null);
      expect(match, code).toBeDefined();
      if (match?.kind === "category") expect(isCategory(match.category), code).toBe(true);
    }
  });

  it("maps a code Plaid has not named to nothing", () => {
    expect(mapPlaidCategory("FOOD_AND_DRINK_SPACE_FOOD", null)).toBeUndefined();
    expect(mapPlaidCategory("", null)).toBeUndefined();
  });

  it.each([
    // The research's "Shopping" is General goods.
    ["GENERAL_MERCHANDISE_ELECTRONICS", "General goods", false],
    ["GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES", "General goods", false],
    ["GENERAL_MERCHANDISE_OFFICE_SUPPLIES", "General goods", false],
    ["GENERAL_MERCHANDISE_DEPARTMENT_STORES", "General goods", true],
    ["GENERAL_MERCHANDISE_DISCOUNT_STORES", "General goods", true],
    ["GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE", "General goods", true],
    // The research's "Other" is Miscellaneous, and still lossy.
    ["OTHER_OTHER", "Miscellaneous", true],
    ["GENERAL_MERCHANDISE_SUPERSTORES", "Superstores", false],
    ["GENERAL_MERCHANDISE_SPORTING_GOODS", "Hobbies", false],
    ["GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", "General goods", false],
  ])("applies the spec's change: %s is %s, lossy %s", (code, category, lossy) => {
    expect(mapPlaidCategory(code, null)).toEqual({ kind: "category", category, lossy });
  });

  it("leaves Income, Transfer, and loan codes to Money movement", () => {
    const moneyMovement = PLAID_V2_DETAILED.filter((code) =>
      /^(?:INCOME|TRANSFER_IN|TRANSFER_OUT|LOAN_DISBURSEMENTS|LOAN_PAYMENTS)_/.test(code),
    );
    expect(moneyMovement).toHaveLength(44);
    for (const code of moneyMovement) {
      expect(mapPlaidCategory(code, null), code).toEqual({ kind: "money movement" });
      // A Merchant on the Superstores list changes nothing here.
      expect(mapPlaidCategory(code, at("Walmart")), code).toEqual({ kind: "money movement" });
    }
    // The research's own treatment of these codes does not apply.
    expect(mapPlaidCategory("TRANSFER_OUT_WITHDRAWAL", null)).toEqual({ kind: "money movement" });
    expect(mapPlaidCategory("LOAN_PAYMENTS_BNPL", null)).toEqual({ kind: "money movement" });
  });

  it("flags exactly the lossy codes", () => {
    const lossy = PLAID_V2_DETAILED.filter((code) => {
      const match = mapPlaidCategory(code, null);
      return match?.kind === "category" && match.lossy;
    });
    expect(lossy.sort()).toEqual(
      [
        "ENTERTAINMENT_CASINOS_AND_GAMBLING",
        "GENERAL_MERCHANDISE_CONVENIENCE_STORES",
        "GENERAL_MERCHANDISE_DEPARTMENT_STORES",
        "GENERAL_MERCHANDISE_DISCOUNT_STORES",
        "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE",
        "GENERAL_SERVICES_INSURANCE",
        "GENERAL_SERVICES_OTHER_GENERAL_SERVICES",
        "GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES",
        "GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT",
        "GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT",
        "MEDICAL_PHARMACIES_AND_SUPPLEMENTS",
        "OTHER_OTHER",
      ].sort(),
    );
  });

  it.each([
    ["FOOD_AND_DRINK_COFFEE", "Restaurants"],
    ["FOOD_AND_DRINK_GROCERIES", "Groceries"],
    ["MEDICAL_VETERINARY_SERVICES", "Pets"],
    ["PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING", "Clothing"],
    ["GENERAL_SERVICES_STORAGE", "Home and garden"],
    ["GOVERNMENT_AND_NON_PROFIT_DONATIONS", "Gifts and donations"],
    ["RENT_AND_UTILITIES_RENT", "Housing"],
    ["TRANSPORTATION_TOLLS", "Car"],
  ])("maps %s to %s, clean, as the research does", (code, category) => {
    expect(mapPlaidCategory(code, null)).toEqual({ kind: "category", category, lossy: false });
  });
});

describe("the Superstores list rule", () => {
  const merchandise = PLAID_V2_DETAILED.filter((code) => code.startsWith("GENERAL_MERCHANDISE_"));

  it("makes any GENERAL_MERCHANDISE_* code at a listed Merchant Superstores, clean", () => {
    expect(merchandise).toHaveLength(14);
    for (const name of ["Walmart", "Target", "Costco", "Sam's Club", "BJ's", "Amazon"]) {
      for (const code of merchandise) {
        expect(mapPlaidCategory(code, at(name)), `${code} at ${name}`).toEqual({
          kind: "category",
          category: "Superstores",
          lossy: false,
        });
      }
    }
  });

  it("makes FOOD_AND_DRINK_GROCERIES at a listed Merchant Superstores, clean", () => {
    for (const name of ["Costco", "Dollar General", "Dollar Tree", "Family Dollar"]) {
      expect(mapPlaidCategory("FOOD_AND_DRINK_GROCERIES", at(name))).toEqual({
        kind: "category",
        category: "Superstores",
        lossy: false,
      });
    }
  });

  it("matches the list without case, spaces, or punctuation, and by other spellings", () => {
    for (const name of [
      "WALMART",
      "Sams Club",
      "bjs",
      "Wal-Mart",
      "Costco Whse",
      "Amazon.com",
      "Walmart.com",
      "Target.com",
    ]) {
      expect(mapPlaidCategory("GENERAL_MERCHANDISE_DISCOUNT_STORES", at(name)), name).toEqual({
        kind: "category",
        category: "Superstores",
        lossy: false,
      });
    }
  });

  it("keeps a purchase the Merchant shows apart, and other Merchants, in its own Category", () => {
    // Costco gas.
    expect(mapPlaidCategory("TRANSPORTATION_GAS", at("Costco"))).toEqual({
      kind: "category",
      category: "Gas",
      lossy: false,
    });
    // An Amazon Prime membership, and Whole Foods.
    expect(mapPlaidCategory("GENERAL_MERCHANDISE_ONLINE_MARKETPLACES", at("Amazon Prime"))).toEqual(
      { kind: "category", category: "General goods", lossy: false },
    );
    expect(mapPlaidCategory("FOOD_AND_DRINK_GROCERIES", at("Whole Foods Market"))).toEqual({
      kind: "category",
      category: "Groceries",
      lossy: false,
    });
    // A grocery store that is not on the list, and a Transaction with no Merchant.
    expect(mapPlaidCategory("GENERAL_MERCHANDISE_CONVENIENCE_STORES", at("Corner Mart"))).toEqual({
      kind: "category",
      category: "Groceries",
      lossy: true,
    });
    expect(mapPlaidCategory("GENERAL_MERCHANDISE_SUPERSTORES", null)).toEqual({
      kind: "category",
      category: "Superstores",
      lossy: false,
    });
  });
});

describe("Plaid confidence", () => {
  it("counts UNKNOWN, and any level Plaid has not named, as LOW", () => {
    expect(plaidConfidence("UNKNOWN")).toBe("LOW");
    expect(plaidConfidence("SOMEWHAT_SURE")).toBe("LOW");
    expect(plaidConfidence("LOW")).toBe("LOW");
  });

  it("keeps the levels Plaid names, and no level at all", () => {
    expect(plaidConfidence("VERY_HIGH")).toBe("VERY_HIGH");
    expect(plaidConfidence("HIGH")).toBe("HIGH");
    expect(plaidConfidence("MEDIUM")).toBe("MEDIUM");
    expect(plaidConfidence(null)).toBeNull();
  });
});
