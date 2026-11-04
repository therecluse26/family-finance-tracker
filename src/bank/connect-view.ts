// Linking a new bank, as Settings → Banks sees it (spec 02, Linking a new bank and The 10 lifetime
// Items). No answer holds a token the browser did not need, an Item ID, or a provider account ID.
// This file imports only adapter.ts, which imports nothing, so the web app's type check can follow
// it.
import type { LinkedAccount, LinkResult } from "./adapter.ts";

// When N, in "at least N of 10 used", is this or more, the Member confirms a second time before
// linking a new bank.
export const CONFIRM_ITEMS_FROM = 8;

// The Connection that already covers a bank, named in a duplicate block.
export type CoveringConnection = { connectionId: string; bankName: string };

// Why the app refuses to link a bank before it spends anything.
// - "item limit": N is 10, so linking a new bank is blocked.
// - "not broken": `replaces` names no Broken Connection, so Link again cannot pass the duplicate
//   block for it.
export type LinkRefusal = { outcome: "item limit"; itemsUsed: number } | { outcome: "not broken" };

// The provider refused the call or did not answer, and nothing was saved. The message is the
// adapter's sorted error, such as "Plaid answered INVALID_ACCESS_TOKEN (INVALID_INPUT).", which
// names only the provider's error code and type, or the HTTP status.
export type ProviderFailure = { outcome: "provider error"; message: string };

export type LinkStart =
  | { outcome: "ready"; linkToken: string; itemsUsed: number }
  // N is 8 or more: the Member confirms a second time, then asks again.
  | { outcome: "confirm"; itemsUsed: number }
  | LinkRefusal
  | ProviderFailure;

export type LinkFinish =
  | { outcome: "linked"; connectionId: string; bankName: string }
  // The token was never exchanged.
  | { outcome: "duplicate"; coveredBy: CoveringConnection }
  | LinkRefusal
  | ProviderFailure;

export type LinkOptions = {
  // The Member confirmed a second time, for N of 8 or more.
  confirmed?: boolean;
  // Link again (T25): the Broken Connection the new one replaces. The duplicate block lets the new
  // one through for that Connection only.
  replaces?: string;
};

// Import Plaid Connection (spec 02): the bank and its Accounts, shown before the Member saves.
export type ImportPreview =
  | { outcome: "preview"; bankName: string; accounts: LinkedAccount[] }
  | { outcome: "duplicate"; coveredBy: CoveringConnection }
  | ProviderFailure;

export type ImportFinish =
  | { outcome: "imported"; connectionId: string; bankName: string }
  | { outcome: "duplicate"; coveredBy: CoveringConnection }
  | ProviderFailure;

// Removing a Connection (spec 02, Removing a Connection).
// - "removed": the provider ended it, or had already ended it. The credential is deleted and the
//   Accounts are Closed, with their history.
// - "provider error": the provider did not end it, so nothing changed and the Member can try again.
export type RemoveOutcome = { outcome: "removed" } | { outcome: "not found" } | ProviderFailure;

// Delete history: only for a removed Connection.
export type DeleteHistoryOutcome =
  | { outcome: "deleted"; accounts: number; transactions: number }
  | { outcome: "not found" }
  | { outcome: "not removed" };

export type ConnectionRemoving = {
  remove(connectionId: string): Promise<RemoveOutcome>;
  deleteHistory(connectionId: string): Promise<DeleteHistoryOutcome>;
};

export type BankConnecting = {
  // A link token for the browser's link screen, after the Item count's gates.
  startLink(options: LinkOptions): Promise<LinkStart>;
  // Checks for a duplicate bank, then exchanges the token, stores the credential encrypted, and
  // starts the first sync.
  finishLink(result: LinkResult, options: LinkOptions): Promise<LinkFinish>;
  // Checks a credential made outside the app with the provider, and shows its bank and Accounts.
  // Nothing is saved.
  previewImport(credential: string): Promise<ImportPreview>;
  // Checks the credential again, blocks a duplicate bank, stores the credential encrypted, and
  // syncs from an empty cursor.
  importConnection(credential: string): Promise<ImportFinish>;
};
