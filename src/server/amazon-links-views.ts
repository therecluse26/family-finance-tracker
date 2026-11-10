// What the Amazon link routes send the browser (spec 14, Hand links). Types only, so the web code
// can import them.

// An unlinked shipment a Member may link to a Transaction by hand: one order's Line items with one
// ship time. Totals are whole cents.
export type AmazonShipmentView = {
  orderId: string;
  shipTime: string;
  orderDate: string;
  shipDate: string;
  total: number;
  items: number;
  // Its Line items' names, in the order they came.
  names: string[];
  giftCard: boolean;
};

// Why a hand link was refused, or that it was made.
export type AmazonHandLinkOutcome =
  | "linked"
  | "no Transaction"
  | "pending"
  | "not Spending"
  | "no shipment"
  | "already linked"
  | "another order";

export type AmazonLinkRoutes = {
  // Undefined when no Transaction that shows has the ID.
  shipmentsToLink(transactionId: string): Promise<AmazonShipmentView[] | undefined>;
  link(
    transactionId: string,
    shipment: { orderId: string; shipTime: string },
  ): Promise<AmazonHandLinkOutcome>;
  // False when the Transaction holds no Line item.
  undo(transactionId: string, memberId: string): Promise<boolean>;
};
