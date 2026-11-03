import type { Merchant } from "./names.ts";

// Merchant identity (spec 04, Identity). Every "same Merchant" in the app uses sameMerchant:
// Category rules, Merchant history, Refund links, Recurring charges, Anomalies, and Top Merchants.
// v1 has no Merchant merge and no Merchant rename.

// A clean name as identity compares it: no case, no spaces, no punctuation. "Trader Joe's" and
// "TRADER JOES" are both "traderjoes".
export function merchantKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// Whether two Transactions' Merchants are the same Merchant. When both have the provider's
// Merchant ID, the IDs decide. Otherwise their clean names decide. A Transaction with no Merchant,
// such as a paper check, is never the same Merchant as another.
export function sameMerchant(a: Merchant | null, b: Merchant | null): boolean {
  if (a === null || b === null) return false;
  if (a.id !== null && b.id !== null) return a.id === b.id;
  const key = merchantKey(a.name);
  return key !== "" && key === merchantKey(b.name);
}
