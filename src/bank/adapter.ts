// The bank-data adapter (spec 02, The bank-data adapter): one interface at the seam between
// Bank-data providers and the core. Each adapter turns its provider's data into these records, so
// nothing past the seam sees a provider type. The interface only reads: no method writes to a bank.
// This file imports nothing, so the web app's type check can follow it.

// Later adapters add "simplefin", "teller", and "file".
export type Provider = "plaid" | "fake";

// The only per-adapter declarations. When an adapter lacks an action, screens hide its button.
export type AdapterActions = { repairInApp: boolean; importExisting: boolean; refresh: boolean };

// A Connection as an adapter sees it.
export type BankConnection = {
  id: string;
  provider: Provider;
  bankId: string;
  bankName: string;
  // The provider credential, such as a Plaid access token, decrypted. Empty for the fake adapter.
  credential: string | null;
};

// What the browser needs to start linking a bank, such as a Plaid link token.
export type LinkSession = { linkToken: string };

// One Account the Member picked while linking, as the provider's link screen reports it.
export type LinkedAccount = {
  name: string;
  // Such as "depository" or "credit", with a subtype such as "checking".
  type: string;
  subtype: string | null;
  // The last 4 digits.
  mask: string | null;
};

// What the browser hands back when linking is done: a one-use token, such as a Plaid public token,
// and the bank and Accounts the Member picked. The core checks the bank and the Accounts for a
// duplicate bank before the adapter exchanges the token.
export type LinkResult = {
  publicToken: string;
  bankId: string;
  bankName: string;
  accounts: LinkedAccount[];
};

// A new Connection, before the app stores it.
export type NewConnection = {
  bankId: string;
  bankName: string;
  credential: string;
  accounts: AccountSnapshot[];
};

// An amount in US dollars, as whole cents.
export type Cents = number;

export type CardDetails = {
  aprs: { type: string; apr: number }[];
  statementBalance: Cents | null;
  minimumPayment: Cents | null;
  // YYYY-MM-DD.
  dueDate: string | null;
  // The day the last statement was issued, YYYY-MM-DD. Payments on or after it pay the statement
  // balance.
  statementIssueDate: string | null;
};

export type LoanDetails = {
  // A percent, such as 6.5.
  apr: number | null;
  principal: Cents | null;
  interestPaidThisYear: Cents | null;
  minimumPayment: Cents | null;
  // YYYY-MM-DD.
  dueDate: string | null;
};

// One Account, with its balances and optional card or loan details. Optional data is an empty
// field; there are no per-adapter data flags. Balances use the Transaction sign: money owed on a
// card or loan is negative, in the current balance and the statement balance. Plaid sends money
// owed as a positive number, so the Plaid adapter flips Plaid's sign for credit and loan Accounts.
export type AccountSnapshot = {
  // The provider's stable account ID.
  id: string;
  name: string;
  // Such as "depository", "credit", or "loan", with a subtype such as "checking" or "personal".
  type: string;
  subtype: string | null;
  // The last 4 digits.
  mask: string | null;
  currentBalance: Cents | null;
  availableBalance: Cents | null;
  creditLimit: Cents | null;
  card: CardDetails | null;
  loan: LoanDetails | null;
  // The provider's original data for the Account.
  raw: unknown;
};

// One Transaction. A positive amount is money into the Account; a negative amount is money out.
export type TxnRecord = {
  // The provider's stable ID.
  id: string;
  // The provider's account ID.
  accountId: string;
  amount: Cents;
  // YYYY-MM-DD.
  postedDate: string;
  authorizedDate: string | null;
  pending: boolean;
  // For a posted Transaction: the provider ID of the pending one it replaces.
  pendingTransactionId: string | null;
  // The original bank description.
  description: string;
  merchantName: string | null;
  merchantId: string | null;
  // The other parties named on it, with their types, such as "financial_institution",
  // "payment_app", or "marketplace".
  counterparties: { name: string; type: string }[];
  // Optional category data from the provider.
  category: {
    name: string;
    confidence: string | null;
    version: string | null;
    mcc: string | null;
  } | null;
  // The provider's original data, so a later version can reprocess history.
  raw: unknown;
};

// Why a Transaction is hidden. These are the only reasons.
export type RemovalReason = "posted" | "removed by provider" | "replaced by re-link";

// One page of a sync. A sync asks for pages, each from the cursor the last one returned, until a
// page returns the cursor it was asked with: then there is nothing more.
export type SyncResult = {
  // Balances and optional card or loan details.
  accounts: AccountSnapshot[];
  added: TxnRecord[];
  changed: TxnRecord[];
  removed: { id: string; reason: RemovalReason }[];
  nextCursor: string;
  // True once the provider has sent all the history it will send.
  historyLoaded: boolean;
};

export interface BankDataAdapter {
  readonly provider: Provider;
  // The shortest time between two syncs of one Connection. Plaid 0; SimpleFIN would set about 1.
  readonly minSyncGapHours: number;
  readonly actions: AdapterActions;

  startLink(): Promise<LinkSession>;
  // Exchanges the token for the provider credential. The core checks for a duplicate bank before
  // it calls this, so a blocked bank never reaches the exchange.
  finishLink(result: LinkResult): Promise<NewConnection>;
  importExisting?(credential: string): Promise<NewConnection>;
  // Plaid's update mode.
  startRepair?(connection: BankConnection): Promise<LinkSession>;
  sync(connection: BankConnection, cursor: string | null): Promise<SyncResult>;
  // Asks the provider whether the Connection still has an error, such as Plaid's /item/get. It
  // throws a BankDataError when it has one. The app runs it once a day while the Connection needs
  // a Member (spec 02, Back-off).
  check(connection: BankConnection): Promise<void>;
  refresh?(connection: BankConnection): Promise<void>;
  remove(connection: BankConnection): Promise<void>;
}

// Each adapter sorts every provider error into one of three kinds. The core acts only on the kind.
export type BankErrorKind = "temporary" | "needs a member" | "gone";

export class BankDataError extends Error {
  override name = "BankDataError";
  readonly kind: BankErrorKind;

  constructor(kind: BankErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}
