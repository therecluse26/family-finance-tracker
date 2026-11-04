// The kinds of Unconnected account (spec 02, Unconnected accounts). A loan is never one; it is a
// Manual loan. Neither is a payment app, such as Venmo or PayPal. This file imports nothing, so
// the web app can use it.
export const UNCONNECTED_KINDS = ["savings", "HSA", "investment or retirement", "other"] as const;

export type UnconnectedKind = (typeof UNCONNECTED_KINDS)[number];

// An Unconnected account's kind in household_accounts. Its subtype is the UnconnectedKind.
export const UNCONNECTED = "unconnected";
