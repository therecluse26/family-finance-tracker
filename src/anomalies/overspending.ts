import { type Budget, budgetSpending, budgetsForMonth } from "../budgets/index.ts";
import {
  type CategoryPart,
  clearOverspendingCheckFailures,
  countOverspendingCheckFailure,
  type Database,
  listAlertKindsOf,
  listCategoryAlerts,
  listDecisionAccounts,
  listSpendingPartsIn,
  type NewAlert,
  readBudgetInputs,
  restartOverspendingCheckCount,
  storeAlerts,
} from "../db/index.ts";
import { registerFollowUpStep } from "../follow-up/index.ts";
import { log } from "../log.ts";
import { monthOf } from "../money-movement/index.ts";
import { endCondition, raiseNotice } from "../notify/index.ts";
import { householdToday, recurringCharges } from "../recurring/index.ts";
import { priceIncreases } from "./price-increase.ts";
import { type AlertFacts, alertText, type BudgetFact, type MerchantFact } from "./templates.ts";

// The Overspending checks (spec 06, Overspending; Overspending Alerts). They run in the follow-up
// job's own step, after the Bills Budgets step, so they read this month's Bills Budgets as they
// stand. They start after the first Budget draft. Every Alert waits for the Alerts step.
// - Over Budget: a Category's Spending passes its Budget, once per Category per month, or per
//   year for a yearly Budget.
// - On pace: from the 8th, P is 20% or more over the Budget and the Category is not Over Budget,
//   once per Category per month. Never for a yearly Budget.
// - Card interest or fee: each Interest and fees Transaction that is not loan interest.
// They look only at the current month, or the current year for a yearly Budget: a late post that
// pushes a past month over sends nothing. Interest and fees sends no Over Budget or On pace Alert,
// and a Bills Category sends neither when Price increases explain the overage.

// A failed run counts a try. The run that reaches this cap gives up on its Transactions, so the
// follow-up job goes on, and raises one System notice.
export const OVERSPENDING_CHECKS_CAP = 3;

// The System notice condition while the Overspending checks have given up on some Transactions.
// The next run that succeeds ends it.
export const OVERSPENDING_CHECKS_STOPPED = "overspending checks stopped";

// On pace waits until this day of the month.
const ON_PACE_FROM_DAY = 8;

// On pace fires when P is at least this share over the Budget: 1 ÷ 5 = 20%.
const ON_PACE_OVER_DIVISOR = 5;

// Whether P, in whole cents, is 20% or more over a Budget above $0.
const onPace = (projected: number, budget: number) =>
  budget > 0 && (projected - budget) * ON_PACE_OVER_DIVISOR >= budget;

const INTEREST_AND_FEES = "Interest and fees";

// Plaid's code for interest charged. On a credit card, the Alert says "Card interest".
const INTEREST_CHARGE = "BANK_FEES_INTEREST_CHARGE";

// An untracked loan payment (spec 03, Untracked loans): any LOAN_PAYMENTS_* code but a card
// payment.
const isLoanPaymentCode = (code: string | null) =>
  code?.startsWith("LOAN_PAYMENTS_") === true && code !== "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";

const merchantOf = (part: CategoryPart): MerchantFact | null =>
  part.merchantCleanName === null ? null : { id: part.merchantId, name: part.merchantCleanName };

// One Transaction's Spending in one Category: the sum of its parts there, in whole cents spent.
// Its date is the purchase date when there is one, else the posted date, as its month's is.
type InCategory = { part: CategoryPart; date: string; spent: number };

function byTransaction(parts: readonly CategoryPart[]): InCategory[] {
  const found = new Map<string, InCategory>();
  for (const part of parts) {
    const each = found.get(part.transactionId);
    if (each === undefined) {
      const date = part.authorizedDate ?? part.postedDate;
      found.set(part.transactionId, { part, date, spent: -part.amount });
    } else each.spent -= part.amount;
  }
  return [...found.values()];
}

const isLater = (a: InCategory, b: InCategory) =>
  a.date > b.date ||
  (a.date === b.date &&
    (a.part.postedDate > b.part.postedDate ||
      (a.part.postedDate === b.part.postedDate && a.part.transactionId > b.part.transactionId)));

// Card interest or fee Alerts for the Transactions the step has not handled: each posted Spending
// in Interest and fees this month that is not loan interest. Loan interest is a part of a tracked
// loan payment, an untracked loan payment, or a Transaction on a loan Account.
async function cardInterestAndFees(
  database: Database,
  unhandled: readonly string[],
  month: string,
): Promise<{ txn: InCategory; cardInterest: boolean; account: string }[]> {
  const parts = await listSpendingPartsIn(database, INTEREST_AND_FEES, {
    transactionIds: unhandled,
  });
  const fees = byTransaction(
    parts.filter((part) => !part.keepsCategory && !isLoanPaymentCode(part.providerCategory)),
    // A $0 line, such as a card statement's $0.00 interest, charges nothing.
  ).filter((txn) => txn.spent > 0 && monthOf(txn.part) === month);
  if (fees.length === 0) return [];
  const fired = await listAlertKindsOf(
    database,
    fees.map((txn) => txn.part.transactionId),
  );
  const accounts = new Map(
    (await listDecisionAccounts(database)).map((account) => [account.id, account]),
  );
  return fees.flatMap((txn) => {
    if (fired.get(txn.part.transactionId)?.has("Card interest or fee")) return [];
    const account = accounts.get(txn.part.accountId);
    if (account === undefined || account.kind === "loan") return [];
    const cardInterest = account.kind === "credit" && txn.part.providerCategory === INTEREST_CHARGE;
    return [{ txn, cardInterest, account: account.name }];
  });
}

// Checks the current month's Budgets and the Transactions the step has not handled, and stores an
// Alert for each Overspending they fire. Returns how many it stored.
export async function checkOverspending(
  database: Database,
  unhandled: readonly string[],
  now = new Date(),
): Promise<number> {
  if ((await readBudgetInputs(database)) === undefined) return 0;
  const today = await householdToday(database, now);
  const month = today.slice(0, 7);
  const year = today.slice(0, 4);
  const found: NewAlert[] = [];
  const add = (alertFacts: AlertFacts, category: string | null, about: readonly string[]) => {
    found.push({
      id: crypto.randomUUID(),
      kind: alertFacts.kind,
      createdAt: now,
      facts: alertFacts,
      text: alertText(alertFacts, today),
      category,
      state: null,
      transactionIds: about,
    });
  };

  for (const { txn, cardInterest, account } of await cardInterestAndFees(
    database,
    unhandled,
    month,
  )) {
    add(
      {
        kind: "Card interest or fee",
        cardInterest,
        merchant: merchantOf(txn.part),
        account,
        amount: txn.spent,
        date: txn.date,
      },
      null,
      [txn.part.transactionId],
    );
  }

  const { budgets } = await budgetsForMonth(database, month);
  const watched = budgets.filter((budget) => budget.category !== INTEREST_AND_FEES);
  if (watched.length > 0) await checkBudgets(database, watched, { today, month, year, now }, add);

  await storeAlerts(database, found);
  if (found.length > 0) log.info("Found Overspending", { alerts: found.length });
  return found.length;
}

async function checkBudgets(
  database: Database,
  budgets: readonly Budget[],
  when: { today: string; month: string; year: string; now: Date },
  add: (facts: AlertFacts, category: string | null, about: readonly string[]) => void,
): Promise<void> {
  const { today, month, year, now } = when;
  const day = Number(today.slice(8, 10));
  const spending = (await budgetSpending(database, month, budgets, now)).budgets;
  const fired = new Set(
    (await listCategoryAlerts(database, ["Over Budget", "On pace"])).map(
      ({ kind, category, facts }) =>
        `${kind} ${category} ${(facts as { budget?: BudgetFact }).budget?.span}`,
    ),
  );
  const hasFired = (kind: AlertFacts["kind"], fact: BudgetFact) =>
    fired.has(`${kind} ${fact.category} ${fact.span}`);

  // Each Category's Spending in the Budget's month or year, by Transaction, read once.
  const spentIn = new Map<string, InCategory[]>();
  const spendingOf = async (fact: BudgetFact) => {
    let found = spentIn.get(fact.category);
    if (found === undefined) {
      const since = fact.period === "yearly" ? `${year}-01-01` : `${month}-01`;
      found = byTransaction(await listSpendingPartsIn(database, fact.category, { since })).filter(
        (txn) => txn.date.startsWith(fact.span) && txn.spent > 0,
      );
      spentIn.set(fact.category, found);
    }
    return found;
  };
  // Each Price increase's rise over its base price, by Transaction, read once.
  let rises: Map<string, number> | undefined;
  // Spec 06, Bills price rise: the sum of each increased Transaction's rise over its base price in
  // the Category this month. Price increases explain an Alert when the same Alert would not fire
  // without that rise.
  const riseIn = async (fact: BudgetFact) => {
    if (rises === undefined) {
      rises = new Map();
      for (const charge of await recurringCharges(database, now)) {
        for (const increase of priceIncreases(charge)) {
          rises.set(increase.transactionId, increase.amount - increase.base);
        }
      }
    }
    let rise = 0;
    for (const txn of await spendingOf(fact)) {
      const each = rises.get(txn.part.transactionId);
      if (each !== undefined) rise += Math.min(each, txn.spent);
    }
    return rise;
  };

  for (const budget of budgets) {
    const status = spending.get(budget.category);
    if (status === undefined) continue;
    const fact: BudgetFact = {
      category: budget.category,
      spent: status.spending,
      budget: budget.amount,
      period: budget.period,
      span: budget.period === "yearly" ? year : month,
    };
    const bills = budget.categoryGroup === "Bills";
    if (status.status === "Over Budget") {
      if (hasFired("Over Budget", fact)) continue;
      // Spending less the rise is within the Budget: only the Price increase Alert goes out.
      if (bills && fact.spent - (await riseIn(fact)) <= fact.budget) continue;
      const latest = (await spendingOf(fact)).reduce<InCategory | undefined>(
        (last, txn) => (last === undefined || isLater(txn, last) ? txn : last),
        undefined,
      );
      if (latest === undefined) continue;
      add(
        {
          kind: "Over Budget",
          budget: fact,
          latest: { merchant: merchantOf(latest.part), amount: latest.spent, date: latest.date },
        },
        budget.category,
        [latest.part.transactionId],
      );
      continue;
    }
    // A yearly Budget has no P, so it is never On pace.
    const projected = status.projected;
    if (day < ON_PACE_FROM_DAY || projected === null || !onPace(projected, budget.amount)) {
      continue;
    }
    if (hasFired("On pace", fact)) continue;
    // P less the rise is under the On pace bar: only the Price increase Alert goes out.
    if (bills && !onPace(projected - (await riseIn(fact)), budget.amount)) continue;
    add({ kind: "On pace", budget: fact, projected }, budget.category, []);
  }
}

// Registers the Overspending checks step, after the Bills Budgets step. A run that fails counts a
// try and throws, so the follow-up job runs again. The run that reaches the cap raises one System
// notice and gives up on its Transactions: they fire no Card interest or fee Alert, and the job
// goes on. The next run that succeeds ends the notice. The start calls it before jobs run.
export function startOverspendingChecks(options: { database: Database; now?: () => Date }): {
  stop(): void;
} {
  const { database, now = () => new Date() } = options;
  const stop = registerFollowUpStep("overspending checks", async (unhandled) => {
    try {
      await checkOverspending(database, unhandled, now());
    } catch (error) {
      const tries = await countOverspendingCheckFailure(database);
      // Only the error's name: a failed query's message holds its values, such as a Merchant.
      log.error("The Overspending checks failed", {
        tries,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      if (tries < OVERSPENDING_CHECKS_CAP) throw new Error("The Overspending checks failed.");
      await restartOverspendingCheckCount(database);
      await raiseNotice({
        kind: "condition",
        condition: OVERSPENDING_CHECKS_STOPPED,
        text: "The app could not check some new Transactions for Overspending, so they send no Alert. It checks again after each sync.",
      });
      return undefined;
    }
    if (await clearOverspendingCheckFailures(database)) {
      await endCondition(OVERSPENDING_CHECKS_STOPPED);
    }
    return undefined;
  });
  return { stop };
}
