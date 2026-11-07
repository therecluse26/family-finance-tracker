import type { Category } from "../categories/index.ts";
import { type Database, type LoanPayouts, listLoanLinksOf, listLoanPayouts } from "../db/index.ts";
import { log } from "../log.ts";
import {
  everAskedAbout,
  openReviewItemBatch,
  openReviewItems,
  type ReviewKind,
  settleReviewItems,
} from "../review/index.ts";
import type { Decision, DecisionInput } from "./order.ts";

// Untracked loans (spec 03, Untracked loans): a loan payment that pairs with no Account and links
// to no Manual loan. The app cannot split its interest from its principal, so the whole payment
// counts one way.

// The Category of each Plaid loan payment code. Any other LOAN_PAYMENTS_* code is Miscellaneous.
const CATEGORIES: Record<string, Category> = {
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: "Housing",
  LOAN_PAYMENTS_CAR_PAYMENT: "Car",
  LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT: "Books and education",
  LOAN_PAYMENTS_BNPL: "General goods",
};

const sameMerchant = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();

// Step 5.2: outgoing money under a LOAN_PAYMENTS_* code other than a card payment. Steps 2 to 4
// took every payment with a pair or a Manual loan link. When a payout from the same Merchant
// landed in a connected Account, the loan is a Cash loan and the payment is a Transfer, and the
// Review list offers to add the loan as a Manual loan. Otherwise the whole payment is Spending in
// the code's Category, which a hand-set Category or a Category rule still replaces.
export async function untrackedLoanPayment(txn: DecisionInput): Promise<Decision | undefined> {
  const code = txn.providerCategory;
  if (txn.amount >= 0 || code === null || !code.startsWith("LOAN_PAYMENTS_")) return undefined;
  if (code === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") return undefined;
  const merchant = txn.merchantCleanName ?? txn.merchantName;
  const { disbursements } = await txn.loanPayouts();
  const payout = disbursements.findLast((line) => sameMerchant(line.merchant, merchant));
  if (payout !== undefined && merchant !== null) {
    return {
      parts: [{ type: "Transfer", amount: txn.amount, category: null }],
      offersManualLoan: { lender: (payout.merchant ?? merchant).trim(), payoutId: payout.id },
    };
  }
  const category = CATEGORIES[code] ?? "Miscellaneous";
  return { parts: [{ type: "Spending", amount: txn.amount, category }] };
}

// The Household's loan payouts, read once a run when a rule first needs them.
export function loanPayoutsReader(database: Database): () => Promise<LoanPayouts> {
  let payouts: Promise<LoanPayouts> | undefined;
  return () => {
    payouts ??= listLoanPayouts(database);
    return payouts;
  };
}

// The Review list item: an untracked loan whose payout the app saw (spec 03, Review list items).
// Its interest cannot show, so the item opens the Manual loan form with the lender filled in. Its
// subject is the payout, so the app asks once for each loan.
export const UNTRACKED_LOAN_KIND = "untracked loan";

// The Manual loan form in Settings, Banks, with the lender filled in.
export function manualLoanFormPath(lender: string): string {
  return `/settings/banks?lender=${encodeURIComponent(lender)}#manual-loans`;
}

const LEAVE = { value: "leave", label: "Leave it untracked" };

export const untrackedLoanKind: ReviewKind = {
  async otherChoices() {
    return [LEAVE];
  },
  // The Manual loan form adds the loan. The answer itself changes nothing.
  async answer() {},
};

export type ManualLoanOffer = { lender: string; payoutId: string };

// Opens an item for each payout that a payment's result offers, unless one was ever opened about
// it, and settles an open item once its payout links to a Manual loan or no longer shows.
export async function updateUntrackedLoanItems(
  database: Database,
  offers: readonly ManualLoanOffer[],
  decided: readonly string[],
  gone: readonly string[],
): Promise<void> {
  if (offers.length === 0 && decided.length === 0 && gone.length === 0) return;
  const touched = new Set([...decided, ...gone]);
  const open = (await openReviewItems(database)).flatMap((item) =>
    item.kind === UNTRACKED_LOAN_KIND && item.subject.type === "transactions"
      ? item.subject.transactionIds.filter((id) => touched.has(id))
      : [],
  );
  if (open.length > 0) {
    const linked = new Set(
      (await listLoanLinksOf(database, open)).map((link) => link.transactionId),
    );
    await settleReviewItems(
      database,
      {
        kind: UNTRACKED_LOAN_KIND,
        subjectIds: open.filter((id) => linked.has(id) || gone.includes(id)),
      },
      "the loan is tracked",
    );
  }
  if (offers.length === 0) return;
  const asked = await everAskedAbout(database, UNTRACKED_LOAN_KIND);
  const items = [];
  for (const { lender, payoutId } of offers) {
    if (asked.has(payoutId)) continue;
    asked.add(payoutId);
    items.push({
      kind: UNTRACKED_LOAN_KIND,
      subject: { type: "transactions" as const, transactionIds: [payoutId] },
      decided: `Payments to ${lender} count as Transfers, so their interest cannot show.`,
      bestAnswer: { value: manualLoanFormPath(lender), label: "Add it as a Manual loan" },
    });
  }
  // One moment for the run's items, so the Review list runs them by their payouts' date (spec 07,
  // Review list page).
  const opened = (await openReviewItemBatch(database, items)).length;
  if (opened > 0) log.info("Untracked loans went on the Review list", { opened });
}
