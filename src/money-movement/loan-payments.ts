import {
  closeManualLoan,
  type Database,
  type DecisionRecord,
  type LinkEvidence,
  listLoanLinkedTransactions,
  listLoanPaymentCandidates,
  listManualLoans,
  listRefusedOtherLinks,
  listSpendingLinksOf,
  type Queries,
  refuseOtherLink,
  type StoredManualLoan,
  storeOtherLink,
} from "../db/index.ts";
import { followUpAgain } from "../follow-up/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { log } from "../log.ts";
import { type Merchant, sameMerchant } from "../merchants/index.ts";
import {
  everAskedAbout,
  lastAskedAbout,
  openReviewItem,
  openReviewItemsOfKind,
  type ReviewChoice,
  type ReviewItem,
  type ReviewKind,
  settleReviewItems,
} from "../review/index.ts";
import { type AiRun, newAiRun } from "./ai-run.ts";
import { addDays, addMonths, daysBetween } from "./business-days.ts";
import { closePaidOffLoans, namesLender } from "./manual-loans.ts";
import { loanLinkedIds } from "./other-links.ts";

// Finding a Manual loan's payments (spec 02, Finding payments; spec 03, Tiers). Matching looks at
// each payment it decided by the normal rules that names a Manual loan's lender:
// - The first payment links at once when the amount or a monthly rhythm agrees. Any other first
//   match goes on the Review list.
// - A later payment is Strong when it has the same Merchant or the same paying Account as a linked
//   one, and links at once. Otherwise it is Unclear: the AI decides (T81), and without AI it goes
//   on the Review list.
// - A Closed loan links nothing more: its payments go on the Review list.
// A payment the app does not link counts by the normal rules. A loan with no linked payment for 2
// months after the last one goes on the Review list too.

// The steps that decide a payment by the normal rules when it has no link: an untracked loan
// payment, a one-sided Transfer, or Spending.
const PAYMENT_STEPS = new Set(["5.2", "5.6", "5.7"]);

// A roughly monthly rhythm: two payments to the lender from one Account this many days apart.
const RHYTHM_DAYS = { from: 25, to: 35 };

// The amount agrees when it is within 1% of the regular payment.
const AMOUNT_TOLERANCE = 0.01;

// The AI's judgment of Unclear payments to Manual loans (spec 03, Tiers): one answer for each
// candidate, in order, or undefined for one no AI answered. src/money-movement/ai-links.ts
// registers it, and keeps its answers so the app never asks about the same candidate twice. It
// asks in batches, and records in the run a use that stops or a retry that waits.
export type UnclearLoanPaymentAnswer = {
  answer: "yes" | "no";
  confidence: "high" | "medium" | "low";
};
// It gets the clean Merchant name and no description. The lender is what a Member typed when
// adding the Manual loan, so it may name a person; both go through the privacy filter, which
// removes each Member's name.
export type UnclearLoanPaymentCandidate = {
  payment: {
    id: string;
    accountId: string;
    postedDate: string;
    amount: number;
    merchantCleanName: string | null;
  };
  loan: { id: string; lender: string; regularPayment: number | null };
  // The loan's linked payments, oldest first.
  linked: {
    accountId: string;
    postedDate: string;
    amount: number;
    merchantCleanName: string | null;
  }[];
};
export type UnclearLoanPaymentJudge = (
  candidates: readonly UnclearLoanPaymentCandidate[],
  run: AiRun,
) => Promise<readonly (UnclearLoanPaymentAnswer | undefined)[]>;

let judge: UnclearLoanPaymentJudge | undefined;

// Registers the AI's judgment of Unclear Manual loan payments. Returns a function that removes it
// again.
export function registerUnclearLoanPaymentJudge(registered: UnclearLoanPaymentJudge): () => void {
  if (judge !== undefined) {
    throw new Error("A judge of Unclear Manual loan payments is already registered.");
  }
  judge = registered;
  return () => {
    if (judge === registered) judge = undefined;
  };
}

type Payment = {
  id: string;
  accountId: string;
  amount: number;
  postedDate: string;
  merchantId: string | null;
  merchantCleanName: string | null;
};

const merchantOf = (txn: Payment): Merchant | null =>
  txn.merchantCleanName === null ? null : { id: txn.merchantId, name: txn.merchantCleanName };

const amountAgrees = (loan: StoredManualLoan, payment: Payment) =>
  loan.regularPayment !== null &&
  Math.abs(-payment.amount - loan.regularPayment) <= loan.regularPayment * AMOUNT_TOLERANCE;

function rhythmAgrees(payment: Payment, others: readonly Payment[]): boolean {
  return others.some((other) => {
    if (other.id === payment.id || other.accountId !== payment.accountId) return false;
    const days = Math.abs(daysBetween(other.postedDate, payment.postedDate));
    return days >= RHYTHM_DAYS.from && days <= RHYTHM_DAYS.to;
  });
}

// The other payments to each lender on the first payments' Accounts, a rhythm's span around them,
// read once a run.
async function rhythmPeers(
  database: Database,
  firsts: readonly { loan: StoredManualLoan; payments: readonly Payment[] }[],
): Promise<Map<string, Payment[]>> {
  const peers = new Map<string, Payment[]>();
  const all = firsts.flatMap((first) => first.payments);
  if (all.length === 0) return peers;
  const dates = all.map((payment) => payment.postedDate).sort();
  const found = await listLoanPaymentCandidates(database, {
    accountIds: all.map((payment) => payment.accountId),
    from: addDays(dates[0] ?? "", -RHYTHM_DAYS.to),
    to: addDays(dates.at(-1) ?? "", RHYTHM_DAYS.to),
  });
  for (const { loan } of firsts) {
    peers.set(
      loan.id,
      found.filter((payment) => namesLender(payment, loan.lender)),
    );
  }
  return peers;
}

type Made = { transactionId: string; loanAccountId: string; evidence: LinkEvidence };
type Ask = { payment: DecisionRecord; loan: StoredManualLoan };

const evidenceOf = (now: Date, signals: string[], ai?: UnclearLoanPaymentAnswer): LinkEvidence => ({
  tier: ai === undefined ? "Strong" : "Unclear",
  signals,
  aiAnswer: ai?.answer ?? null,
  aiConfidence: ai?.confidence ?? null,
  madeBy: ai === undefined ? "app" : "AI",
  memberId: null,
  createdAt: now,
});

// Links the payments among these results to the Manual loan whose lender they name, and asks
// about the rest on the Review list. Reads the loans, their links, and the refusals once a run, and
// writes the links in one transaction. Returns the Transactions to decide again: each payment it
// linked, each Transaction whose other links ended, and every other payment on a loan whose links
// changed, as each payment's interest counts from the balance the ones before it left. A loan
// whose balance reaches $0 closes.
export async function findManualLoanPayments(
  database: Database,
  results: readonly { record: DecisionRecord; step: string }[],
  now: Date,
  run: AiRun = newAiRun(),
): Promise<string[]> {
  const payments = results
    .filter(
      ({ record, step }) =>
        record.amount < 0 &&
        PAYMENT_STEPS.has(step) &&
        record.loanLink === null &&
        record.transferLink === null &&
        record.spendingLink === null,
    )
    .map(({ record }) => record);
  if (payments.length === 0) return [];
  const loans = await listManualLoans(database);
  if (loans.length === 0) return [];
  // A payment that names two lenders goes to the first by lender.
  const byLoan = new Map<string, { loan: StoredManualLoan; payments: DecisionRecord[] }>();
  for (const payment of payments) {
    const loan = loans.find((each) => namesLender(payment, each.lender));
    if (loan === undefined) continue;
    const found = byLoan.get(loan.id) ?? { loan, payments: [] };
    found.payments.push(payment);
    byLoan.set(loan.id, found);
  }
  if (byLoan.size === 0) return [];
  const named = [...byLoan.values()].flatMap((each) => each.payments.map((payment) => payment.id));
  // A purchase that a Refund or Reimbursement reduces keeps that link.
  const reduced = new Set(
    (await listSpendingLinksOf(database, named)).map((link) => link.spendingTransactionId),
  );
  const refused = await listRefusedOtherLinks(database, "loan", named);
  const linked = await listLoanLinkedTransactions(database, [...byLoan.keys()]);
  const paidTo = (loanId: string): Payment[] =>
    linked
      .filter((each) => each.loanAccountId === loanId && each.amount < 0)
      .map((each) => ({ ...each, id: each.transactionId }));
  const candidates = [...byLoan.values()].map(({ loan, payments: own }) => ({
    loan,
    payments: own.filter(
      (payment) => !reduced.has(payment.id) && !refused.has(`${payment.id} ${loan.id}`),
    ),
  }));
  const firsts = candidates.filter(({ loan }) => !loan.closed && paidTo(loan.id).length === 0);
  const peers = await rhythmPeers(database, firsts);
  const made: Made[] = [];
  const asks: Ask[] = [];
  const refusing: { transactionId: string; loanAccountId: string }[] = [];
  const unclear: Ask[] = [];
  for (const { loan, payments: own } of candidates) {
    if (loan.closed) {
      asks.push(...own.map((payment) => ({ payment, loan })));
      continue;
    }
    let paid = paidTo(loan.id);
    let rest = own;
    if (paid.length === 0) {
      // The first payment: the lender, and the amount or a monthly rhythm.
      const confident = own.flatMap((payment) => {
        const signals = ["lender"];
        if (amountAgrees(loan, payment)) signals.push("amount");
        if (rhythmAgrees(payment, peers.get(loan.id) ?? [])) signals.push("monthly rhythm");
        return signals.length > 1 ? [{ payment, signals }] : [];
      });
      if (confident.length === 0) {
        asks.push(...own.map((payment) => ({ payment, loan })));
        continue;
      }
      for (const { payment, signals } of confident) {
        made.push({
          transactionId: payment.id,
          loanAccountId: loan.id,
          evidence: evidenceOf(now, signals),
        });
      }
      paid = confident.map(({ payment }) => payment);
      rest = own.filter((payment) => !confident.some((each) => each.payment === payment));
    }
    // Later payments use the link tiers. The amount may change.
    for (const payment of rest) {
      const signals: string[] = [];
      if (paid.some((each) => sameMerchant(merchantOf(each), merchantOf(payment)))) {
        signals.push("same Merchant");
      }
      if (paid.some((each) => each.accountId === payment.accountId)) signals.push("same Account");
      if (signals.length > 0) {
        made.push({
          transactionId: payment.id,
          loanAccountId: loan.id,
          evidence: evidenceOf(now, signals),
        });
        continue;
      }
      unclear.push({ payment, loan });
    }
  }
  // The AI judges every Unclear payment of the run in one go.
  const answers =
    judge === undefined || unclear.length === 0
      ? []
      : await judge(
          unclear.map(({ payment, loan }) => ({
            payment: {
              id: payment.id,
              accountId: payment.accountId,
              postedDate: payment.postedDate,
              amount: payment.amount,
              merchantCleanName: payment.merchantCleanName,
            },
            loan: { id: loan.id, lender: loan.lender, regularPayment: loan.regularPayment },
            linked: paidTo(loan.id).map(({ accountId, postedDate, amount, merchantCleanName }) => ({
              accountId,
              postedDate,
              amount,
              merchantCleanName,
            })),
          })),
          run,
        );
  unclear.forEach(({ payment, loan }, index) => {
    const answer = answers[index];
    if (answer?.confidence === "high" && answer.answer === "yes") {
      made.push({
        transactionId: payment.id,
        loanAccountId: loan.id,
        evidence: evidenceOf(now, [], answer),
      });
    } else if (answer?.confidence === "high") {
      refusing.push({ transactionId: payment.id, loanAccountId: loan.id });
    } else {
      asks.push({ payment, loan });
    }
  });
  const again: string[] = [];
  if (made.length > 0 || refusing.length > 0) {
    await database.transaction(async (tx) => {
      for (const { evidence, ...link } of made) {
        const stored = await storeOtherLink(tx, { kind: "loan", ...link }, evidence);
        again.push(link.transactionId, ...stored.ended);
      }
      for (const link of refusing) {
        await refuseOtherLink(tx, { kind: "loan", ...link }, { refusedBy: "AI", at: now });
      }
    });
  }
  await askAboutPayments(database, asks);
  if (made.length === 0) return again;
  log.info("Linked payments to Manual loans", { linked: made.length });
  const changed = [...new Set(made.map((link) => link.loanAccountId))];
  await settleReviewItems(
    database,
    { kind: POSSIBLE_PAYMENT_KIND, subjectIds: made.map((link) => link.transactionId) },
    "linked",
  );
  await closePaidOffLoans(database, changed, now);
  return [...new Set([...again, ...(await loanLinkedIds(database, changed))])];
}

// The Review list item: a payment that may be on a Manual loan (spec 02, Finding payments). Its
// subject is the payment, so the app asks once for each one. Its best answer names the loan.
export const POSSIBLE_PAYMENT_KIND = "possible Manual loan payment";

const NOT_THIS: ReviewChoice = { value: "not this", label: "No, it is not a payment on this loan" };
const linkChoice = (loanId: string): ReviewChoice => ({
  value: `link ${loanId}`,
  label: "Link to this loan",
});

async function askAboutPayments(database: Database, asks: readonly Ask[]): Promise<void> {
  if (asks.length === 0) return;
  const asked = await everAskedAbout(database, POSSIBLE_PAYMENT_KIND);
  let opened = 0;
  for (const { payment, loan } of asks) {
    if (asked.has(payment.id)) continue;
    asked.add(payment.id);
    await openReviewItem(database, {
      kind: POSSIBLE_PAYMENT_KIND,
      subject: { type: "transactions", transactionIds: [payment.id] },
      decided: loan.closed
        ? `This may be a payment to ${loan.lender}, whose loan is Closed. It counts by the normal rules.`
        : `This may be a payment on the ${loan.lender} loan. It counts by the normal rules.`,
      bestAnswer: linkChoice(loan.id),
    });
    opened += 1;
  }
  if (opened > 0) log.info("Possible Manual loan payments went on the Review list", { opened });
}

const paymentOf = (item: ReviewItem): string => {
  const [paymentId] = item.subject.type === "transactions" ? item.subject.transactionIds : [];
  if (paymentId === undefined) throw new Error("A Manual loan payment item is about a payment.");
  return paymentId;
};

const loanOf = (item: ReviewItem): string => item.bestAnswer.value.replace(/^link /, "");

// Accepting makes a hand-made link. "Not this" acts as an undo: the app never makes that link.
// The follow-up job then decides the payment, and the loan's other payments, again.
export const possiblePaymentKind: ReviewKind = {
  async otherChoices() {
    return [NOT_THIS];
  },
  async answer(item, choice, answering: { memberId: string; database: Queries }) {
    const link = {
      kind: "loan" as const,
      transactionId: paymentOf(item),
      loanAccountId: loanOf(item),
    };
    const at = new Date();
    const touched = [link.transactionId];
    if (choice.value === NOT_THIS.value) {
      await refuseOtherLink(answering.database, link, {
        refusedBy: "Member",
        memberId: answering.memberId,
        at,
      });
    } else {
      const made = await storeOtherLink(answering.database, link, {
        tier: "Unclear",
        signals: [],
        aiAnswer: null,
        aiConfidence: null,
        madeBy: "Member",
        memberId: answering.memberId,
        createdAt: at,
      });
      touched.push(...made.ended);
    }
    await followUpAgain(answering.database, touched);
  },
};

// The Review list item: a Manual loan with no linked payment for 2 months after its last one
// (spec 02, Finding payments). Its subject is the loan. It asks once for each gap: again only when
// a later payment links and then stops.
export const MISSED_PAYMENT_KIND = "missed Manual loan payment";

const KEEP: ReviewChoice = { value: "keep", label: "Keep the loan open" };
const CLOSE: ReviewChoice = { value: "close", label: "Close the loan" };

export const missedPaymentKind: ReviewKind = {
  async otherChoices() {
    return [CLOSE];
  },
  async answer(item, choice, answering: { memberId: string; database: Queries }) {
    if (choice.value !== CLOSE.value || item.subject.type !== "loan") return;
    await closeManualLoan(answering.database, item.subject.accountId, {
      reason: "closed by a member",
      at: new Date(),
    });
  },
};

// Settles each open missed-payment item whose loan has a newer payment or is Closed, then, unless
// only settling, opens one for each open Manual loan whose last linked payment is more than 2
// months before the Household's today, unless one opened since then. The daily task opens and
// settles; Matching only settles, once a payment links. Reads the loans, their links, and the
// kind's items once.
export async function updateMissedLoanPayments(
  database: Database,
  now: Date,
  only: "settle" | "settle and open" = "settle and open",
): Promise<void> {
  const loans = await listManualLoans(database);
  if (loans.length === 0) return;
  const zone = (await householdTimeZone(database)) ?? "UTC";
  const today = calendarDateIn(now, zone);
  const linked = await listLoanLinkedTransactions(
    database,
    loans.map((loan) => loan.id),
  );
  // Each loan whose payment is missed: its last payment's date, and the day 2 months after it.
  const missed = new Map<string, { last: string; due: string }>();
  for (const loan of loans) {
    if (loan.closed) continue;
    const last = linked
      .filter((each) => each.loanAccountId === loan.id && each.amount < 0)
      .at(-1)?.postedDate;
    if (last === undefined) continue;
    const due = addMonths(last, 2);
    if (today > due) missed.set(loan.id, { last, due });
  }
  const open = await openReviewItemsOfKind(database, MISSED_PAYMENT_KIND);
  const settled = open
    .map((item) => (item.subject.type === "loan" ? item.subject.accountId : ""))
    .filter((loanId) => !missed.has(loanId));
  if (settled.length > 0) {
    await settleReviewItems(
      database,
      { kind: MISSED_PAYMENT_KIND, subjectIds: settled },
      "a payment linked, or the loan closed",
    );
  }
  if (missed.size === 0 || only === "settle") return;
  const asked = await lastAskedAbout(database, MISSED_PAYMENT_KIND);
  let opened = 0;
  for (const loan of loans) {
    const gap = missed.get(loan.id);
    if (gap === undefined) continue;
    const at = asked.get(loan.id);
    if (at !== undefined && calendarDateIn(at, zone) > gap.due) continue;
    await openReviewItem(
      database,
      {
        kind: MISSED_PAYMENT_KIND,
        subject: { type: "loan", accountId: loan.id },
        decided: `No payment to ${loan.lender} has linked since ${gap.last}.`,
        bestAnswer: KEEP,
      },
      now,
    );
    opened += 1;
  }
  if (opened > 0) log.info("Missed Manual loan payments went on the Review list", { opened });
}
