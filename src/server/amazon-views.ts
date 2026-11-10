// The Amazon card on the Store orders page in Settings and the Line items on a Transaction (spec
// 14), as the routes answer them. Types only, so the web app reads them too.

// What an upload's Content-Type says it holds: Amazon's ZIP file, or the order file inside it.
export const AMAZON_UPLOAD_TYPES = { "application/zip": "zip", "text/csv": "csv" } as const;

export type AmazonUploadKind = (typeof AMAZON_UPLOAD_TYPES)[keyof typeof AMAZON_UPLOAD_TYPES];

// The largest upload POST /api/amazon/import takes. Every other route keeps the app's limit.
export const MAX_AMAZON_UPLOAD_BYTES = 50 * 1024 * 1024;

// Rows skipped for one reason, and the row number of the first.
export type AmazonSkipView = { reason: string; rows: number; firstRow: number };

export type AmazonImportView = {
  // In UTC.
  importedAt: string;
  // Null once the Member who uploaded it was removed.
  memberName: string | null;
  rowsRead: number;
  added: number;
  updated: number;
  // Stored already, with the same values.
  unchanged: number;
  skipped: AmazonSkipView[];
};

// Shipments by where their linking stands. A shipment is one order's Line items with one ship
// time.
export type AmazonShipmentCounts = {
  linked: number;
  // Unlinked, shipped less than 60 days ago.
  waiting: number;
  onReviewList: number;
  // Unlinked, shipped 60 or more days ago.
  notMatched: number;
  // Unlinked, and its link window ends before the first posted Transaction, so no charge the
  // banks sent can link to it. Counted only here.
  beforeBankHistory: number;
  // Unlinked, paid in part by gift card, so the app does not try it.
  giftCard: number;
};

export type AmazonStatusView = {
  lastImport: AmazonImportView | null;
  lineItems: number;
  shipments: AmazonShipmentCounts;
};

export type AmazonImportResult =
  | { outcome: "imported"; import: AmazonImportView; status: AmazonStatusView }
  // The file was refused, with why. It names a row number or a column only.
  | { outcome: "refused"; reason: string }
  | { outcome: "too large" }
  // An import or a delete is running.
  | { outcome: "busy" };

export type AmazonDeleteResult =
  | { outcome: "deleted"; status: AmazonStatusView }
  | { outcome: "busy" };

// One Line item on a Transaction's detail view.
export type LineItemView = {
  id: string;
  name: string;
  quantity: number;
  // Whole cents, owed for the Line item, tax included.
  total: number;
  // Null until a step chooses one.
  category: string | null;
  // The AI chose it below high confidence: the item shows an "AI unsure" tag (spec 14, Step 3).
  aiUnsure: boolean;
  orderId: string;
  // A day in the Household time zone.
  orderDate: string;
  linkKind: "app" | "hand" | null;
};

export type AmazonRoutes = {
  status(): Promise<AmazonStatusView>;
  // Takes the one import or delete place before it reads the body, so a second at the same time
  // answers "busy". `body` reads at most MAX_AMAZON_UPLOAD_BYTES, else undefined.
  importFile(
    kind: AmazonUploadKind,
    body: () => Promise<Uint8Array | undefined>,
    memberId: string,
  ): Promise<AmazonImportResult>;
  deleteAll(): Promise<AmazonDeleteResult>;
  lineItemsOf(transactionId: string): Promise<LineItemView[]>;
};
