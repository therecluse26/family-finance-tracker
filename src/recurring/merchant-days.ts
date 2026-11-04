import type { Database } from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { type Merchant, merchantKey } from "../merchants/index.ts";

// What both kinds of series need: the Household's date, and which Merchant a Transaction belongs
// to.

// The Household's date. Until the wizard's step 4 sets the Household time zone, it is the date in
// UTC.
export async function householdToday(database: Database, now: Date): Promise<string> {
  return calendarDateIn(now, (await householdTimeZone(database)) ?? "UTC");
}

// The Transactions of one Merchant, as identity knows it: by the provider's Merchant ID when the
// Transaction has one, else by clean name.
export const groupOf = (merchant: Merchant) =>
  merchant.id === null ? `name ${merchantKey(merchant.name)}` : `id ${merchant.id}`;
