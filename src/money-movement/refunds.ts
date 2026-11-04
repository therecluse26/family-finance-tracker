import { mapPlaidCategory } from "../bank/plaid-categories.ts";
import {
  type Database,
  type DecisionRecord,
  listRefundPurchases,
  listRefusedOtherLinks,
  listSpendingLinksOf,
  type ReducingLink,
  type RefundPurchase,
  readSpendingToReduce,
  type SpendingLinkKind,
  storeAppRefundLinks,
} from "../db/index.ts";
import { log } from "../log.ts";
import { type Merchant, merchantKey, sameMerchant } from "../merchants/index.ts";
import { addDays, daysBetween } from "./business-days.ts";
import type { Decision, DecisionInput, DecisionRule, Part } from "./order.ts";
import { purchaseDate } from "./totals.ts";

// Refunds and Reimbursements (spec 03, Refunds, Reimbursements, Link shapes). The app links a
// Refund at once, with no AI, to the latest earlier purchase on the same Account from the same
// Merchant. A link reduces its Spending only down to $0, in the Spending's month and Category.
// The rest of a Refund follows the unlinked Refund rule, and the rest of a Reimbursement is Income.

// A Refund links to a purchase at most this many days before it.
export const REFUND_WINDOW_DAYS = 120;

const merchantOf = (txn: {
  merchantId: string | null;
  merchantCleanName: string | null;
}): Merchant | null =>
  txn.merchantCleanName === null ? null : { id: txn.merchantId, name: txn.merchantCleanName };

// An unlinked Refund has a Merchant, and its provider category maps to a Spending Category.
function isUnlinkedRefund(txn: DecisionInput): boolean {
  const merchant = merchantOf(txn);
  if (merchant === null || txn.providerCategory === null) return false;
  return mapPlaidCategory(txn.providerCategory, merchant)?.kind === "category";
}

// Step 6.8. An unlinked Refund reduces Spending in its Merchant's Category, in the month it
// arrives. The categorization cascade picks that Category, as it does for Spending.
export const unlinkedRefund: DecisionRule = (txn) =>
  isUnlinkedRefund(txn)
    ? { parts: [{ type: "Refund", amount: txn.amount, category: null }] }
    : undefined;

// Money in linked to Spending: the part its link reduces, then the rest. The linked part has no
// Category of its own; it counts with its Spending's Category and month. The rest of a Refund
// follows the unlinked Refund rule, else it is Income; the rest of a Reimbursement is Income.
export function linkedTreatment(txn: DecisionInput, kind: SpendingLinkKind): Decision {
  const reduced = Math.min(txn.amount, txn.spendingAllocations.get(txn.id) ?? 0);
  const rest = txn.amount - reduced;
  const parts: Part[] = [];
  if (reduced > 0) parts.push({ type: kind, amount: reduced, category: null, linked: true });
  if (rest > 0) {
    const type = kind === "Refund" && isUnlinkedRefund(txn) ? "Refund" : "Income";
    parts.push({ type, amount: rest, category: null });
  }
  return { parts };
}

// Step 6.4. A Refund link the app made, to a purchase that is still Spending. When a Member makes
// the purchase another type, such as Saving, the money goes on down the order; the link stays, and
// counts again once the purchase is Spending again. A Member's link is step 2's.
export const refundLink: DecisionRule = (txn) =>
  txn.spendingLink?.kind === "Refund" &&
  txn.spendingLink.madeBy !== "Member" &&
  txn.spendingAllocations.has(txn.id)
    ? linkedTreatment(txn, "Refund")
    : undefined;

// How much of each linked Refund and Reimbursement reduces its Spending, by the money in's ID.
// Several may reduce one Spending: they take it in the order they arrived, each down to $0. A link
// whose Spending has no Spending part has no allocation.
export function allocate(
  spending: ReadonlyMap<string, number>,
  links: readonly ReducingLink[],
): Map<string, number> {
  const allocations = new Map<string, number>();
  const left = new Map(spending);
  const ordered = [...links].sort(
    (a, b) =>
      a.postedDate.localeCompare(b.postedDate) || a.transactionId.localeCompare(b.transactionId),
  );
  for (const link of ordered) {
    if (!spending.has(link.spendingTransactionId)) continue;
    const available = left.get(link.spendingTransactionId) ?? 0;
    const reduced = Math.max(0, Math.min(link.amount, available));
    left.set(link.spendingTransactionId, available - reduced);
    allocations.set(link.transactionId, reduced);
  }
  return allocations;
}

// The allocations of the linked money among these records, read once a run: two statements for
// each 500 Spending Transactions.
export async function readSpendingAllocations(
  database: Database,
  records: readonly DecisionRecord[],
): Promise<Map<string, number>> {
  const spendingIds = records.flatMap((record) =>
    record.spendingLink === null ? [] : [record.spendingLink.spendingTransactionId],
  );
  if (spendingIds.length === 0) return new Map();
  const { spending, links } = await readSpendingToReduce(database, spendingIds);
  return allocate(spending, links);
}

// The purchases on each Account, by Merchant ID and by clean name, so a Refund finds its own
// Merchant's without reading every purchase.
class PurchaseIndex {
  private readonly byKey = new Map<string, RefundPurchase[]>();

  constructor(purchases: readonly RefundPurchase[]) {
    for (const purchase of purchases) {
      if (purchase.merchantId !== null)
        this.add(`id ${purchase.accountId} ${purchase.merchantId}`, purchase);
      this.add(`name ${purchase.accountId} ${merchantKey(purchase.merchantCleanName)}`, purchase);
    }
  }

  private add(key: string, purchase: RefundPurchase): void {
    const list = this.byKey.get(key);
    if (list === undefined) this.byKey.set(key, [purchase]);
    else list.push(purchase);
  }

  // The purchases on the Account from the same Merchant, latest first.
  find(accountId: string, merchant: Merchant): RefundPurchase[] {
    const found = new Map<string, RefundPurchase>();
    const keys = [`name ${accountId} ${merchantKey(merchant.name)}`];
    if (merchant.id !== null) keys.push(`id ${accountId} ${merchant.id}`);
    for (const key of keys) {
      for (const purchase of this.byKey.get(key) ?? []) {
        const other = { id: purchase.merchantId, name: purchase.merchantCleanName };
        if (sameMerchant(merchant, other)) found.set(purchase.id, purchase);
      }
    }
    return [...found.values()].sort(
      (a, b) => purchaseDate(b).localeCompare(purchaseDate(a)) || b.id.localeCompare(a.id),
    );
  }
}

// The hard filters of a Refund link the app makes (spec 03, Refunds): the purchase is on the same
// Account, from the same Merchant, and bought on or before the day the Refund posted, at most 120
// days before it. A purchase that posts after the Refund still passes when it was bought before.
// "Some amount left to reduce" is a filter only when the link is made.
export function passesRefundFilters(
  money: {
    accountId: string;
    postedDate: string;
    merchantId: string | null;
    merchantCleanName: string | null;
  },
  purchase: {
    accountId: string;
    postedDate: string;
    authorizedDate: string | null;
    merchantId: string | null;
    merchantCleanName: string | null;
  },
): boolean {
  const days = daysBetween(purchaseDate(purchase), money.postedDate);
  return (
    money.accountId === purchase.accountId &&
    sameMerchant(merchantOf(money), merchantOf(purchase)) &&
    days >= 0 &&
    days <= REFUND_WINDOW_DAYS
  );
}

// Money in that a Refund link could take: an unlinked Refund or Income, steps 6.8 and 6.9, with a
// Merchant and no link. A Refund link comes before steps 6.5 to 6.7 in the order (spec 03, Order
// of decisions), but what they claim is no purchase given back: money from a person, a payment on
// a card, or money with transfer wording or a Plaid transfer category.
const AFTER_REFUND_LINK = new Set(["6.8", "6.9"]);

// Links each Refund among these results to the latest earlier purchase that passes the hard
// filters, has some amount left to reduce, and that no one refused. Refunds take amounts in the
// order they arrived. Reads the purchases on the Refunds' Accounts once, and their Spending once.
// Returns the money in that it linked, and the other sides of each link that ended.
export async function linkRefunds(
  database: Database,
  results: readonly { record: DecisionRecord; step: string }[],
  now: Date,
): Promise<string[]> {
  const refunds = results
    .filter(
      ({ record, step }) =>
        record.amount > 0 &&
        AFTER_REFUND_LINK.has(step) &&
        record.spendingLink === null &&
        merchantOf(record) !== null,
    )
    .map(({ record }) => record)
    .sort((a, b) => a.postedDate.localeCompare(b.postedDate) || a.id.localeCompare(b.id));
  if (refunds.length === 0) return [];
  const dates = refunds.map((refund) => refund.postedDate).sort();
  const index = new PurchaseIndex(
    await listRefundPurchases(
      database,
      refunds.map((refund) => refund.accountId),
      addDays(dates[0] ?? "", -REFUND_WINDOW_DAYS),
      dates.at(-1) ?? "",
    ),
  );
  const options = new Map<string, RefundPurchase[]>();
  for (const refund of refunds) {
    const merchant = merchantOf(refund);
    if (merchant === null) continue;
    const found = index
      .find(refund.accountId, merchant)
      .filter((purchase) => passesRefundFilters(refund, purchase));
    if (found.length > 0) options.set(refund.id, found);
  }
  if (options.size === 0) return [];
  const purchaseIds = [...options.values()].flat().map((purchase) => purchase.id);
  const { spending, links } = await readSpendingToReduce(database, purchaseIds);
  // What each purchase has left to reduce, after the links it has.
  const left = new Map(spending);
  for (const link of links) {
    left.set(
      link.spendingTransactionId,
      Math.max(0, (left.get(link.spendingTransactionId) ?? 0) - link.amount),
    );
  }
  const refused = await listRefusedOtherLinks(database, "Refund", [...options.keys()]);
  const made: { transactionId: string; spendingTransactionId: string }[] = [];
  for (const refund of refunds) {
    const purchase = options
      .get(refund.id)
      ?.find((each) => (left.get(each.id) ?? 0) > 0 && !refused.has(`${refund.id} ${each.id}`));
    if (purchase === undefined) continue;
    left.set(purchase.id, Math.max(0, (left.get(purchase.id) ?? 0) - refund.amount));
    made.push({ transactionId: refund.id, spendingTransactionId: purchase.id });
  }
  if (made.length === 0) return [];
  await database.transaction((tx) =>
    storeAppRefundLinks(tx, made, {
      tier: "Strong",
      signals: ["same Account", "same Merchant"],
      aiAnswer: null,
      aiConfidence: null,
      madeBy: "app",
      memberId: null,
      createdAt: now,
    }),
  );
  log.info("Linked Refunds to their purchases", { linked: made.length });
  return made.map((link) => link.transactionId);
}

// Every Refund and Reimbursement linked to Spending that one of these Transactions is, or reduces.
// A change to a Spending or to one of its links changes how much each of its links reduces.
export async function reducingIds(
  database: Database,
  transactionIds: readonly string[],
): Promise<string[]> {
  if (transactionIds.length === 0) return [];
  const touching = await listSpendingLinksOf(database, transactionIds);
  if (touching.length === 0) return [];
  const spendingIds = new Set(touching.map((link) => link.spendingTransactionId));
  const all = await listSpendingLinksOf(database, [...spendingIds]);
  return [
    ...new Set(
      all
        .filter((link) => spendingIds.has(link.spendingTransactionId))
        .map((link) => link.transactionId),
    ),
  ];
}
