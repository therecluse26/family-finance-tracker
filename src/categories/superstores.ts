import { merchantKey } from "../merchants/index.ts";

// The Superstores list (spec 04, Provider categories). It ships with the app, and developers
// change it between releases. These Merchants sell groceries and general goods together, so a
// purchase there cannot show which of the two it paid for.
export const SUPERSTORES = Object.freeze([
  "Walmart",
  "Target",
  "Costco",
  "Sam's Club",
  "BJ's",
  "Amazon",
  "Dollar General",
  "Dollar Tree",
  "Family Dollar",
] as const);

// Other spellings of the same stores in bank data. A name these Merchants show apart, such as
// Amazon Prime or Costco Gas, is not on the list, so that purchase keeps its own Category.
const OTHER_SPELLINGS = [
  "Wal-Mart",
  "Walmart Supercenter",
  "Walmart.com",
  "Target.com",
  "Costco Wholesale",
  "Costco Whse",
  "BJ's Wholesale Club",
  "Amazon.com",
  "Amazon Mktp",
  "Amzn Mktp",
  "Amzn Mktp US",
];

const KEYS = new Set([...SUPERSTORES, ...OTHER_SPELLINGS].map(merchantKey));

// Whether a Merchant is on the Superstores list. Its clean name compares as Merchant identity
// does: without case, spaces, or punctuation.
export function isSuperstore(merchant: { name: string } | null): boolean {
  return merchant !== null && KEYS.has(merchantKey(merchant.name));
}
