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
// - "other bank": Link again linked another bank than the Broken Connection's, so it replaces
//   nothing. The token was never exchanged.
export type LinkRefusal =
  | { outcome: "item limit"; itemsUsed: number }
  | { outcome: "not broken" }
  | { outcome: "other bank" };

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
  // Link again, but the provider named another bank than the Broken Connection's after the
  // exchange. The Item is spent, so the bank is added as a new Connection, and the Broken one is
  // left as it was.
  | { outcome: "added other bank"; connectionId: string; bankName: string }
  // The provider did not confirm the bank after the exchange, so nothing is decided on the
  // browser's word: the bank is added as a new Connection, and replaces nothing.
  // `replacedNothing` is true for Link again.
  | {
      outcome: "added unconfirmed";
      connectionId: string;
      bankName: string;
      replacedNothing: boolean;
    }
  // The token was never exchanged.
  | { outcome: "duplicate"; coveredBy: CoveringConnection }
  // The provider named, after the exchange, a bank that another Connection covers. The Item is
  // spent and counts in N. The new Connection was removed, unless the provider did not end it;
  // then it stays held, never syncs, and waits for the Member to Remove it.
  | {
      outcome: "duplicate after link";
      coveredBy: CoveringConnection;
      connectionId: string;
      removed: boolean;
    }
  | LinkRefusal
  | ProviderFailure;

export type LinkOptions = {
  // The Member confirmed a second time, for N of 8 or more.
  confirmed?: boolean;
  // Link again (spec 02, Repair): the Broken Connection the new one replaces. The duplicate block
  // lets the new one through for that Connection only. Once the token is exchanged, the Broken
  // Connection is removed, its Accounts are Closed, and the new Connection's first sync carries them
  // over.
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

// Repair and Add accounts (spec 02, Repair and New accounts at a bank) open the provider's link
// screen in update mode, for the same Connection and credential, so they spend no Item.
// - "ready": a link token in update mode, for the browser's link screen only.
// - "link again": the Connection is Broken. Its credential no longer works, so update mode cannot
//   fix it, and the Member uses Link again instead.
// - "not needed": Repair is only for a Connection that needs a Member.
// - "no repair": the Connection's adapter has no update mode.
// - "held": the Connection is held, as a duplicate of another bank's Connection, and never syncs.
//   The Member removes it.
export type UpdateModeStart =
  | { outcome: "ready"; linkToken: string }
  | { outcome: "not found" }
  | { outcome: "held" }
  | { outcome: "link again" }
  | { outcome: "not needed" }
  | { outcome: "no repair" }
  | ProviderFailure;

// The link screen in update mode finished: the Connection's sync job starts at once, or, when a
// sync started too recently, as soon as the gap has passed ("sync soon").
export type UpdateModeFinish =
  | { outcome: "syncing" }
  | { outcome: "sync soon" }
  | { outcome: "not found" }
  | { outcome: "held" }
  | { outcome: "link again" };

export type ConnectionRepairing = {
  // Repair for a Connection that needs a Member.
  startRepair(connectionId: string): Promise<UpdateModeStart>;
  // Add accounts at the Connection's bank.
  startAddAccounts(connectionId: string): Promise<UpdateModeStart>;
  // After Repair or Add accounts, the sync that makes the Connection Healthy and brings any new
  // Accounts.
  finishUpdate(connectionId: string, now?: Date): Promise<UpdateModeFinish>;
};

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
