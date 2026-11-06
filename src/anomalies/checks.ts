import {
  type Budget,
  type BudgetSpending,
  budgetSpending,
  budgetsForMonth,
  findLargePurchases,
} from "../budgets/index.ts";
import { isCategory } from "../categories/index.ts";
import {
  type AlertKind,
  clearAnomalyCheckFailures,
  countAnomalyCheckFailure,
  type Database,
  listAlertKindsOf,
  listDecisionAccounts,
  listPostedSpending,
  listPressedAlertFacts,
  listPressedAlertTransactions,
  type NewAlert,
  restartAnomalyCheckCount,
  storeAlerts,
} from "../db/index.ts";
import { registerFollowUpStep } from "../follow-up/index.ts";
import { log } from "../log.ts";
import { merchantKey } from "../merchants/index.ts";
import { endCondition, raiseNotice } from "../notify/index.ts";
import {
  addDays,
  daysBetween,
  earlierOnSchedule,
  householdToday,
  merchantGroupOf,
  nextExpected,
  recurringCharges,
  withinChargeBand,
} from "../recurring/index.ts";
import { priceIncreases, risesOver } from "./price-increase.ts";
import { type AlertFacts, alertText, type BudgetFact, type MerchantFact } from "./templates.ts";

// The Anomaly checks (spec 06, When checks run; Anomalies). They run in the follow-up job's checks
// step, after Matching, Categorization, and the Recurring charge checks, on posted Spending only.
// Each check looks only at the Transactions the step has not handled, and a Transaction fires
// each Anomaly at most once, even when the provider changes it later. An Anomaly from a
// Transaction that arrived in a history load is stored as "found in history": it is never sent and
// never counts against the cap. Every other Alert waits for the Alerts step.

// A failed run counts a try. The run that reaches this cap gives up on its Transactions, so the
// follow-up job goes on, and raises one System notice.
export const ANOMALY_CHECKS_CAP = 3;

// The System notice condition while Anomaly checks have given up on some Transactions. The next
// run that succeeds ends it.
export const ANOMALY_CHECKS_STOPPED = "anomaly checks stopped";

// Frequent purchases (spec 06, Rules behind the table): 3 or more other Transactions at the
// Merchant in the 60 days before the earlier one.
const FREQUENT_COUNT = 3;
const FREQUENT_DAYS = 60;

// A Duplicate charge's purchase dates are at most this many days apart.
const DUPLICATE_DAYS = 2;

// More days than a monthly interval and its margin with the business-day shift reach, 41: the
// earlier Transactions a New Recurring charge looks at. earlierOnSchedule keeps those on a
// schedule.
const SCHEDULE_DAYS = 42;

// One posted Spending Transaction, as the checks read it. The amount is the whole cents spent.
type Spent = {
  id: string;
  postedDate: string;
  // The purchase date when there is one, else the posted date.
  purchaseDate: string;
  accountId: string;
  merchant: MerchantFact | null;
  // The Merchant's group, as identity knows it, or null with no Merchant.
  group: string | null;
  amount: number;
  category: string | null;
  historyLoad: boolean;
};

// The first index in `list`, sorted by `dateOf`, whose date is on or after `date`.
function firstOnOrAfter<T>(list: readonly T[], dateOf: (item: T) => string, date: string): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const item = list[middle];
    if (item !== undefined && dateOf(item) < date) low = middle + 1;
    else high = middle;
  }
  return low;
}

// The items whose date is from `from` up to `to`, both included.
function between<T>(list: readonly T[], dateOf: (item: T) => string, from: string, to: string) {
  return list.slice(
    firstOnOrAfter(list, dateOf, from),
    firstOnOrAfter(list, dateOf, addDays(to, 1)),
  );
}

// Adds an item to the list under `key`.
function addTo<T>(lists: Map<string, T[]>, key: string, item: T): void {
  const list = lists.get(key);
  if (list === undefined) lists.set(key, [item]);
  else list.push(item);
}

const byPurchaseDate = (txn: Spent) => txn.purchaseDate;
const byPostedDate = (txn: Spent) => txn.postedDate;

// What the checks read once per run.
type Facts = {
  today: string;
  spent: Map<string, Spent>;
  // Each Merchant's Transactions by posted date.
  byMerchant: Map<string, Spent[]>;
  // Each Merchant's Transactions at one amount, by purchase date.
  byAmount: Map<string, Spent[]>;
  accountNames: Map<string, string>;
  // Each Transaction of a Recurring charge, ended ones too.
  inCharges: Set<string>;
  // The base price of each Transaction that is a Price increase, and its Recurring charge's ID.
  increases: Map<string, { base: number; recurringCharge: string }>;
  // The Merchants and amounts a Member marked known.
  known: { group: string; amount: number }[];
  // The Transactions of each Duplicate charge a Member marked "Not a problem".
  cleared: Set<string>;
  // The Price increases a Member marked "Not a problem", by Recurring charge ID: the base price
  // and the accepted new price.
  accepted: Map<string, { base: number; amount: number }[]>;
};

const amountKey = (group: string, amount: number) => `${group} ${amount}`;

async function readFacts(database: Database, now: Date): Promise<Facts> {
  const facts: Facts = {
    today: await householdToday(database, now),
    spent: new Map(),
    byMerchant: new Map(),
    byAmount: new Map(),
    accountNames: new Map(),
    inCharges: new Set(),
    increases: new Map(),
    known: [],
    cleared: await listPressedAlertTransactions(database, "Duplicate charge"),
    accepted: new Map(),
  };
  // Oldest first, by posted date.
  for (const row of await listPostedSpending(database)) {
    if (row.spending >= 0) continue;
    const named = row.merchantCleanName === null ? null : row.merchantCleanName;
    const merchant = named === null ? null : { id: row.merchantId, name: named };
    const group =
      merchant === null || (merchant.id === null && merchantKey(merchant.name) === "")
        ? null
        : merchantGroupOf(merchant);
    const txn: Spent = {
      id: row.id,
      postedDate: row.postedDate,
      purchaseDate: row.authorizedDate ?? row.postedDate,
      accountId: row.accountId,
      merchant,
      group,
      amount: -row.spending,
      category: row.category,
      historyLoad: row.historyLoad,
    };
    facts.spent.set(txn.id, txn);
    if (group === null) continue;
    addTo(facts.byMerchant, group, txn);
    addTo(facts.byAmount, amountKey(group, txn.amount), txn);
  }
  for (const list of facts.byAmount.values()) {
    list.sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate) || a.id.localeCompare(b.id));
  }
  for (const charge of await recurringCharges(database, now)) {
    for (const entry of charge.priceHistory) facts.inCharges.add(entry.transactionId);
    for (const increase of priceIncreases(charge)) {
      facts.increases.set(increase.transactionId, {
        base: increase.base,
        recurringCharge: charge.id,
      });
    }
  }
  for (const account of await listDecisionAccounts(database)) {
    facts.accountNames.set(account.id, account.name);
  }
  for (const known of await listPressedAlertFacts(database, "New Recurring charge")) {
    const { merchant, amount } = known as { merchant?: MerchantFact; amount?: number };
    if (merchant === undefined || typeof amount !== "number") continue;
    facts.known.push({ group: merchantGroupOf(merchant), amount });
  }
  for (const pressed of await listPressedAlertFacts(database, "Price increase")) {
    const { recurringCharge, base, amount } = pressed as {
      recurringCharge?: string;
      base?: number;
      amount?: number;
    };
    if (
      typeof recurringCharge !== "string" ||
      typeof base !== "number" ||
      typeof amount !== "number"
    ) {
      continue;
    }
    addTo(facts.accepted, recurringCharge, { base, amount });
  }
  return facts;
}

// Whether 3 or more Transactions in `list` that `counts` keeps are dated in the 60 days before
// `date`.
function frequentBefore(
  list: readonly Spent[],
  dateOf: (txn: Spent) => string,
  date: string,
  counts: (txn: Spent) => boolean = () => true,
): boolean {
  const within = between(list, dateOf, addDays(date, -FREQUENT_DAYS), addDays(date, -1));
  return within.filter(counts).length >= FREQUENT_COUNT;
}

const isEarlier = (a: Spent, b: Spent, dateOf: (txn: Spent) => string) =>
  dateOf(a) < dateOf(b) || (dateOf(a) === dateOf(b) && a.id < b.id);

// A Duplicate charge: another posted Spending Transaction on the same Account, at the same
// Merchant, for the same amount to the cent, with a purchase date 0 to 2 days away. The nearest
// one pairs with it. Never for a frequent purchase: 3 or more other Transactions at that Merchant
// at that amount in the 60 days before the earlier one. Never for a Transaction of a Duplicate
// charge a Member marked "Not a problem": it is cleared. The pair, earlier first.
function duplicateOf(txn: Spent, facts: Facts): [Spent, Spent] | undefined {
  if (txn.group === null) return undefined;
  const sameAmount = facts.byAmount.get(amountKey(txn.group, txn.amount)) ?? [];
  const near = between(
    sameAmount,
    byPurchaseDate,
    addDays(txn.purchaseDate, -DUPLICATE_DAYS),
    addDays(txn.purchaseDate, DUPLICATE_DAYS),
  ).filter(
    (other) =>
      other.id !== txn.id && other.accountId === txn.accountId && !facts.cleared.has(other.id),
  );
  const gap = (other: Spent) => Math.abs(daysBetween(txn.purchaseDate, other.purchaseDate));
  const partner = near.sort(
    (a, b) => gap(a) - gap(b) || (isEarlier(a, b, byPurchaseDate) ? -1 : 1),
  )[0];
  if (partner === undefined) return undefined;
  const pair: [Spent, Spent] = isEarlier(partner, txn, byPurchaseDate)
    ? [partner, txn]
    : [txn, partner];
  if (frequentBefore(sameAmount, byPurchaseDate, pair[0].purchaseDate)) return undefined;
  return pair;
}

// The price a Price increase is measured from: its base price, or a higher new price a Member
// accepted with "Not a problem" in the same Recurring charge, so the same rise does not come back.
// An accepted price counts only while the base price is within 7.5% of the pressed Alert's base
// price or new price: after the price drops further, a new rise fires again. A Recurring charge
// keeps its ID while it keeps one of its Transactions, so the accepted price stays when the bank
// removes the raised charge and posts it again. A Member's other Recurring charges, at that
// Merchant or another, keep their own base prices.
function priceFrom(increase: { base: number; recurringCharge: string }, facts: Facts): number {
  let from = increase.base;
  for (const accepted of facts.accepted.get(increase.recurringCharge) ?? []) {
    const near = [accepted.base, accepted.amount].some((price) =>
      withinChargeBand([price, increase.base]),
    );
    if (near) from = Math.max(from, accepted.amount);
  }
  return from;
}

// A New Recurring charge: the Transaction and exactly one earlier Transaction from its Merchant
// make a weekly, 2-week, or monthly schedule, within 7.5% of each other. Never for one that
// continues or revives a Recurring charge, a Merchant and amount marked known, or a frequent
// purchase: 3 or more other Transactions at that Merchant, at any amount, in the 60 days before the
// earlier one, outside its Recurring charges.
function newChargeOf(txn: Spent, facts: Facts): { earlier: Spent; nextDate: string } | undefined {
  if (txn.group === null || facts.inCharges.has(txn.id)) return undefined;
  const { group } = txn;
  if (
    facts.known.some(
      (known) => known.group === group && withinChargeBand([known.amount, txn.amount]),
    )
  ) {
    return undefined;
  }
  const merchantTxns = facts.byMerchant.get(group) ?? [];
  const before = between(
    merchantTxns,
    byPostedDate,
    addDays(txn.postedDate, -SCHEDULE_DAYS),
    txn.postedDate,
  )
    .filter((other) => other.id !== txn.id && !facts.inCharges.has(other.id))
    .map((other) => ({ ...other, date: other.postedDate }));
  const fits = earlierOnSchedule({ ...txn, date: txn.postedDate }, before);
  const [only] = fits;
  if (only === undefined || fits.length !== 1) return undefined;
  const earlier = facts.spent.get(only.txn.id);
  if (earlier === undefined) return undefined;
  // A Recurring charge's Transactions are not visits, as when finding a series (spec 06).
  const visit = (other: Spent) => !facts.inCharges.has(other.id);
  if (frequentBefore(merchantTxns, byPostedDate, earlier.postedDate, visit)) return undefined;
  return { earlier, nextDate: nextExpected(only.schedule, txn.postedDate) };
}

// The Budget line of a Large purchase: its Category's Spending and Budget in the purchase's month,
// or for a yearly Budget in its year so far. Null when the Category has no Budget.
async function budgetFactOf(
  database: Database,
  category: string | null,
  month: string,
  now: Date,
  months: Map<string, { budgets: Budget[]; spending: Map<string, BudgetSpending> | undefined }>,
): Promise<BudgetFact | null> {
  if (category === null || !isCategory(category)) return null;
  let found = months.get(month);
  if (found === undefined) {
    found = { budgets: (await budgetsForMonth(database, month)).budgets, spending: undefined };
    months.set(month, found);
  }
  const budget = found.budgets.find((each) => each.category === category);
  if (budget === undefined) return null;
  found.spending ??= (await budgetSpending(database, month, found.budgets, now)).budgets;
  return {
    category,
    spent: found.spending.get(category)?.spending ?? 0,
    budget: budget.amount,
    period: budget.period,
    span: budget.period === "yearly" ? month.slice(0, 4) : month,
  };
}

// Checks the Transactions the step has not handled, and stores an Alert for each Anomaly they
// fire. Returns how many it stored.
export async function checkAnomalies(
  database: Database,
  unhandled: readonly string[],
  now = new Date(),
): Promise<number> {
  const facts = await readFacts(database, now);
  const checked = unhandled.flatMap((id) => {
    const txn = facts.spent.get(id);
    return txn === undefined ? [] : [txn];
  });
  if (checked.length === 0) return 0;
  const fired = await listAlertKindsOf(
    database,
    checked.map((txn) => txn.id),
  );
  const hasFired = (txn: Spent, kind: AlertKind) => fired.get(txn.id)?.has(kind) ?? false;
  const markFired = (txn: Spent, kind: AlertKind) => {
    const kinds = fired.get(txn.id) ?? new Set<AlertKind>();
    kinds.add(kind);
    fired.set(txn.id, kinds);
  };

  const found: NewAlert[] = [];
  const add = (txn: Spent, about: readonly Spent[], alertFacts: AlertFacts) => {
    for (const each of about) markFired(each, alertFacts.kind);
    found.push({
      id: crypto.randomUUID(),
      kind: alertFacts.kind,
      createdAt: now,
      facts: alertFacts,
      text: alertText(alertFacts, facts.today),
      category: null,
      state: txn.historyLoad ? "found in history" : null,
      transactionIds: about.map((each) => each.id),
    });
  };

  for (const txn of checked) {
    const { merchant } = txn;
    if (merchant === null) continue;
    if (!hasFired(txn, "Duplicate charge")) {
      const pair = duplicateOf(txn, facts);
      if (pair !== undefined) {
        add(txn, pair, {
          kind: "Duplicate charge",
          merchant,
          account: facts.accountNames.get(txn.accountId) ?? "",
          amount: txn.amount,
          dates: [pair[0].purchaseDate, pair[1].purchaseDate],
        });
      }
    }
    const increase = facts.increases.get(txn.id);
    if (increase !== undefined && !hasFired(txn, "Price increase")) {
      const from = priceFrom(increase, facts);
      if (risesOver(from, txn.amount)) {
        add(txn, [txn], {
          kind: "Price increase",
          merchant,
          base: from,
          amount: txn.amount,
          date: txn.postedDate,
          recurringCharge: increase.recurringCharge,
        });
      }
    }
    if (!hasFired(txn, "New Recurring charge")) {
      const charge = newChargeOf(txn, facts);
      if (charge !== undefined) {
        add(txn, [charge.earlier, txn], {
          kind: "New Recurring charge",
          merchant,
          amount: txn.amount,
          dates: [charge.earlier.postedDate, txn.postedDate],
          nextDate: charge.nextDate,
        });
      }
    }
  }

  const unfired = new Set(
    checked.filter((txn) => !hasFired(txn, "Large purchase")).map((txn) => txn.id),
  );
  const months = new Map<
    string,
    { budgets: Budget[]; spending: Map<string, BudgetSpending> | undefined }
  >();
  for (const purchase of await findLargePurchases(database, unfired, now)) {
    const txn = facts.spent.get(purchase.transactionId);
    if (txn?.merchant == null) continue;
    add(txn, [txn], {
      kind: "Large purchase",
      merchant: txn.merchant,
      amount: purchase.amount,
      date: purchase.date,
      budget: await budgetFactOf(
        database,
        purchase.category,
        purchase.date.slice(0, 7),
        now,
        months,
      ),
    });
  }

  await storeAlerts(database, found);
  if (found.length > 0) {
    log.info("Found Anomalies", {
      alerts: found.length,
      foundInHistory: found.filter((alert) => alert.state === "found in history").length,
    });
  }
  return found.length;
}

// Registers the Anomaly checks step, after the Recurring charge checks. A run that fails counts a
// try and throws, so the follow-up job runs again. The run that reaches the cap raises one System
// notice and gives up on its Transactions: they fire no Anomaly, and the job goes on. The next run
// that succeeds ends the notice. The start calls it before jobs run.
export function startAnomalyChecks(options: { database: Database; now?: () => Date }): {
  stop(): void;
} {
  const { database, now = () => new Date() } = options;
  const stop = registerFollowUpStep("anomaly checks", async (unhandled) => {
    try {
      await checkAnomalies(database, unhandled, now());
    } catch (error) {
      const tries = await countAnomalyCheckFailure(database);
      // Only the error's name: a failed query's message holds its values, such as a Merchant.
      log.error("The Anomaly checks failed", {
        tries,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      if (tries < ANOMALY_CHECKS_CAP) throw new Error("The Anomaly checks failed.");
      await restartAnomalyCheckCount(database);
      await raiseNotice({
        kind: "condition",
        condition: ANOMALY_CHECKS_STOPPED,
        text: "The app could not check some new Transactions for Anomalies, so they send no Alert. It checks new Transactions again after each sync.",
      });
      return undefined;
    }
    if (await clearAnomalyCheckFailures(database)) await endCondition(ANOMALY_CHECKS_STOPPED);
    return undefined;
  });
  return { stop };
}
