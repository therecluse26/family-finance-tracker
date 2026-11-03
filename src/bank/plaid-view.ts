// The Plaid keys and the count of Plaid Items, as Settings → Banks sees them (spec 02, Plaid keys
// and The 10 lifetime Items). The secret is never in them: only whether it is set. This file
// imports nothing, so the web app's type check can follow it.

// Plaid's free Trial plan allows 10 Production Items for the life of the Plaid team.
export const PLAID_ITEM_LIMIT = 10;

export type PlaidKeys = { clientId: string; secret: string };

export type PlaidView = {
  clientId: string | null;
  secretSet: boolean;
  // N, in "at least N of 10 used": appItems plus the Items spent outside the app.
  itemsUsed: number;
  // Every Plaid Connection the app created or imported, removed ones included. N never falls
  // below it.
  appItems: number;
  itemLimit: number;
};

// What saving the keys did: Plaid accepted them and the app saved them, Plaid refused them, or
// Plaid did not answer. Only keys that work are saved.
export type PlaidKeysCheck = "saved" | "refused" | "no answer";

export type PlaidSettings = {
  view(): Promise<PlaidView>;
  // Tests the keys with /institutions/get, which spends no Item, and saves them if they work.
  saveKeys(keys: PlaidKeys): Promise<PlaidKeysCheck>;
  // Sets N to a whole number from 0 to 10. Undefined, and nothing changes, when it is below the
  // app's own count.
  setItemsUsed(itemsUsed: number): Promise<PlaidView | undefined>;
};
