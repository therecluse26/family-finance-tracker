import { listUnconnectedAccounts, UNCONNECTED, type UnconnectedAccount } from "../bank/index.ts";
import {
  budgetsForMonth,
  type CategoryProjection,
  projectCategories,
  projectMerchant,
  readProjectionFacts,
} from "../budgets/index.ts";
import { type Category, isCategory } from "../categories/index.ts";
import {
  type Database,
  dropHouseholdSummary,
  endGoals,
  type GoalStatus,
  listAccounts,
  listGoals,
  listSpendingPartsSince,
  readGoal,
  type StoredGoal,
  storeGoalStart,
  sumSavingSince,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { type Merchant, sameMerchant } from "../merchants/index.ts";
import { listManualLoanViews, type ManualLoan } from "../money-movement/index.ts";
import {
  type GoalChange,
  type GoalKind,
  type GoalProgress,
  goalAmountFrom,
  loanProgress,
  NO_GOAL_AMOUNT,
  saveProgress,
  spendLessProgress,
} from "./progress.ts";

// Goals and their progress (spec 05, Goals). A Goal's reading comes from the AI; the Goal amount
// and every number of its progress come from the app alone. The app sets an active Goal to done
// when it meets its "Done when" rule. A done Goal shows "Done" for one month, then moves to the
// done list. A passed deadline does not end a Goal.

// What the reading's target names: a Category or a Merchant, Saving or one or more Accounts, or
// one tracked loan, which is a connected loan or a Manual loan.
export type GoalTarget =
  | { kind: "Category"; category: Category }
  | { kind: "Merchant"; merchant: Merchant }
  | { kind: "Saving" }
  | { kind: "Accounts"; accountIds: string[] }
  | { kind: "loan"; accountId: string };

// The AI's reading. Each field is null when the words do not say.
export type GoalReading = {
  target: GoalTarget | null;
  change: GoalChange | null;
  deadline: string | null;
};

// Where a Goal shows: with the active Goals, which hold a done Goal for its first month, or in the
// done or dropped list.
export type GoalList = "active" | "done" | "dropped";

export type Goal = {
  id: string;
  words: string;
  // The Member who wrote it, or null once that Member is gone.
  authorId: string | null;
  date: string;
  status: GoalStatus;
  endedOn: string | null;
  endedBy: string | null;
  reading: GoalReading;
  goalAmount: number | null;
  startsOn: string | null;
  list: GoalList;
  // Null for a reading with no target, for a Goal in the done or dropped list, and when the loan or
  // its balance is not known.
  progress: Omit<GoalProgress, "met"> | null;
};

const kindOf = (target: GoalTarget): GoalKind => {
  switch (target.kind) {
    case "Category":
    case "Merchant":
      return "spend less";
    case "Saving":
    case "Accounts":
      return "save toward an amount";
    case "loan":
      return "pay down a loan";
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

// The stored target, or null when it is empty or not one the app knows.
function targetOf(stored: unknown): GoalTarget | null {
  if (!isRecord(stored)) return null;
  switch (stored.kind) {
    case "Category":
      return isText(stored.category) && isCategory(stored.category)
        ? { kind: "Category", category: stored.category }
        : null;
    case "Merchant": {
      const { merchant } = stored;
      if (!isRecord(merchant) || !isText(merchant.name)) return null;
      const id = isText(merchant.id) ? merchant.id : null;
      return { kind: "Merchant", merchant: { id, name: merchant.name } };
    }
    case "Saving":
      return { kind: "Saving" };
    case "Accounts": {
      const { accountIds } = stored;
      if (!Array.isArray(accountIds) || accountIds.length === 0 || !accountIds.every(isText))
        return null;
      return { kind: "Accounts", accountIds };
    }
    case "loan":
      return isText(stored.accountId) ? { kind: "loan", accountId: stored.accountId } : null;
    default:
      return null;
  }
}

const isWholeCents = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function changeOf(stored: unknown): GoalChange | null {
  if (!isRecord(stored)) return null;
  if (isWholeCents(stored.amount)) return { amount: stored.amount };
  const { percent } = stored;
  if (typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100) {
    return { percent };
  }
  return null;
}

// A stored Goal's reading, as the goals module reads it.
export const readingOf = (goal: StoredGoal): GoalReading => ({
  target: targetOf(goal.target),
  change: changeOf(goal.change),
  deadline: goal.deadline,
});

export async function householdDay(database: Database, now: Date): Promise<string> {
  return calendarDateIn(now, (await householdTimeZone(database)) ?? "UTC");
}

const monthPlus = (month: string, count: number) => {
  const [year = 0, number = 1] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, number - 1 + count, 1));
  return date.toISOString().slice(0, 7);
};

// The same day one month later, or that month's last day when it is shorter.
function oneMonthAfter(day: string): string {
  const month = monthPlus(day.slice(0, 7), 1);
  const [year = 0, number = 1] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return `${month}-${String(Math.min(Number(day.slice(8, 10)), last)).padStart(2, "0")}`;
}

// A done Goal shows "Done" from the day it became done until the same day a month later.
function listOf(goal: Pick<StoredGoal, "status" | "endedOn">, today: string): GoalList {
  if (goal.status !== "done") return goal.status;
  return goal.endedOn !== null && today < oneMonthAfter(goal.endedOn) ? "active" : "done";
}

// Everything progress reads, each read at most once per call, and only when a Goal needs it.
class Facts {
  readonly #database: Database;
  readonly #now: Date;
  readonly today: string;
  readonly #cache = new Map<string, Promise<unknown>>();

  constructor(database: Database, now: Date, today: string) {
    this.#database = database;
    this.#now = now;
    this.today = today;
  }

  #once<T>(key: string, read: () => Promise<T>): Promise<T> {
    let found = this.#cache.get(key) as Promise<T> | undefined;
    if (found === undefined) {
      found = read();
      this.#cache.set(key, found);
    }
    return found;
  }

  // This month's Spending and P for each Category, as the Budgets show them (spec 06, The
  // projection), and each month's totals.
  categories() {
    return this.#once("categories", async () => {
      const month = this.today.slice(0, 7);
      const { budgets } = await budgetsForMonth(this.#database, month);
      const monthly = new Map(
        budgets
          .filter((each) => each.period === "monthly")
          .map((each) => [each.category, each.amount]),
      );
      return projectCategories(this.#database, month, monthly, this.#now, await this.projection());
    });
  }

  // What the projection reads: once for every Category and Merchant.
  projection() {
    return this.#once("projection", () => readProjectionFacts(this.#database, this.#now));
  }

  merchantProjection(merchant: Merchant): Promise<CategoryProjection> {
    return this.#once(`merchant ${merchant.id ?? ""} ${merchant.name}`, async () =>
      projectMerchant(
        this.#database,
        merchant,
        this.today.slice(0, 7),
        this.#now,
        await this.projection(),
      ),
    );
  }

  // The Spending parts from the first of `month` on, each with its Merchant.
  spendingSince(month: string) {
    return this.#once(`spending ${month}`, () =>
      listSpendingPartsSince(this.#database, `${month}-01`),
    );
  }

  savingSince(day: string) {
    return this.#once(`saving ${day}`, () => sumSavingSince(this.#database, day));
  }

  accounts() {
    return this.#once("accounts", async () => {
      const rows = await listAccounts(this.#database);
      return new Map(rows.map((row) => [row.id, row]));
    });
  }

  unconnected() {
    return this.#once("unconnected", async () => {
      const found = await listUnconnectedAccounts(this.#database);
      return new Map<string, UnconnectedAccount>(found.map((account) => [account.id, account]));
    });
  }

  manualLoans() {
    return this.#once("manual loans", async () => {
      const found = await listManualLoanViews(this.#database);
      return new Map<string, ManualLoan>(found.map((loan) => [loan.id, loan]));
    });
  }
}

// Spending in a Category or at a Merchant in each month from `from` on, net of Refunds and
// Reimbursements and never below $0: as the Totals count it. A Refund or Reimbursement linked to
// Spending counts at that Spending's Merchant, in that Spending's month.
async function spendingByMonth(
  facts: Facts,
  target: GoalTarget,
  from: string,
): Promise<Map<string, number>> {
  if (target.kind === "Category") {
    const { totals } = await facts.categories();
    return new Map(totals.map((each) => [each.month, each.byCategory[target.category] ?? 0]));
  }
  if (target.kind !== "Merchant") return new Map();
  const net = new Map<string, number>();
  for (const part of await facts.spendingSince(from)) {
    const merchant =
      part.merchantName === null ? null : { id: part.merchantId, name: part.merchantName };
    if (!sameMerchant(merchant, target.merchant)) continue;
    const month = part.date.slice(0, 7);
    net.set(month, (net.get(month) ?? 0) - part.amount);
  }
  return new Map([...net].map(([month, cents]) => [month, Math.max(0, cents)]));
}

// The baseline: Spending on the Category or Merchant in the 3 complete calendar months before the
// Goal's date, ÷ 3.
async function baselineOf(facts: Facts, target: GoalTarget, date: string): Promise<number> {
  const month = date.slice(0, 7);
  const byMonth = await spendingByMonth(facts, target, monthPlus(month, -3));
  const sum = [-3, -2, -1].reduce(
    (total, back) => total + (byMonth.get(monthPlus(month, back)) ?? 0),
    0,
  );
  return Math.round(sum / 3);
}

// The balance of a save Goal now, and whether an Unconnected account's estimate is in it. With
// Saving as the target, it is the Saving since `startsOn`, from $0. With Accounts, it is the sum of
// their balances: an Unconnected account uses its balance estimate. An Account the app no longer
// has, or one with no balance yet, adds nothing.
async function balanceOf(
  facts: Facts,
  target: GoalTarget,
  startsOn: string,
): Promise<{ balance: number; estimated: boolean }> {
  if (target.kind === "Saving") {
    // Saving is money out of the Account, so its sum is negative. It counts from its purchase
    // date, as the month totals do.
    return { balance: -(await facts.savingSince(startsOn)), estimated: false };
  }
  if (target.kind !== "Accounts") return { balance: 0, estimated: false };
  const accounts = await facts.accounts();
  let balance = 0;
  let estimated = false;
  for (const id of new Set(target.accountIds)) {
    const account = accounts.get(id);
    if (account === undefined || account.kind === "loan") continue;
    if (account.connectionId === null && account.kind === UNCONNECTED) {
      const found = (await facts.unconnected()).get(id);
      if (found === undefined) continue;
      balance += found.estimate.balance;
      estimated = true;
    } else if (account.connectionId !== null) {
      balance += account.currentBalance ?? 0;
    }
  }
  return { balance, estimated };
}

// What a tracked loan owes now, in whole cents, or undefined when the app has no such loan or no
// balance for it. A connected loan's balance has the Transaction sign: money owed is negative.
async function owedOn(facts: Facts, accountId: string): Promise<number | undefined> {
  const account = (await facts.accounts()).get(accountId);
  if (account === undefined || account.kind !== "loan") return undefined;
  if (account.connectionId === null)
    return (await facts.manualLoans()).get(accountId)?.currentBalance;
  return account.currentBalance === null ? undefined : Math.max(0, -account.currentBalance);
}

// The start of a Goal on `today`, the day its Goal amount takes effect: the baseline of a spend
// less Goal, the balance of a save Goal, or what the loan owes. Undefined when the loan or its
// balance is not known.
async function startOf(
  facts: Facts,
  goal: StoredGoal,
  target: GoalTarget,
): Promise<{ startBalance: number | null; baseline: number | null } | undefined> {
  switch (kindOf(target)) {
    case "spend less":
      return { startBalance: null, baseline: await baselineOf(facts, target, goal.date) };
    case "save toward an amount":
      return {
        // With Saving as the target, the balance counts from $0 (spec 05, Progress).
        startBalance:
          target.kind === "Saving" ? 0 : (await balanceOf(facts, target, facts.today)).balance,
        baseline: null,
      };
    case "pay down a loan": {
      if (target.kind !== "loan") return undefined;
      const owed = await owedOn(facts, target.accountId);
      return owed === undefined ? undefined : { startBalance: owed, baseline: null };
    }
  }
}

export type GoalStartResult =
  | { goalAmount: number; startsOn: string }
  | "no active Goal"
  | "no target"
  | "no Goal amount"
  | "no loan balance";

// The Goal amount takes effect today, Household time, and progress starts (spec 05, Progress): the
// Goal's date when the Goal is added, or the day a Member accepts the Goal amount Proposal. With no
// `goalAmount`, it is the amount the reading's change gives. A spend less Goal's amount always
// comes from a Proposal, so it needs `goalAmount`.
export async function startGoal(
  database: Database,
  id: string,
  options: { goalAmount?: number; now?: Date } = {},
): Promise<GoalStartResult> {
  const now = options.now ?? new Date();
  const goal = await readGoal(database, id);
  if (goal === undefined) return "no active Goal";
  const { target, change } = readingOf(goal);
  if (target === null) return "no target";
  const facts = new Facts(database, now, await householdDay(database, now));
  const start = await startOf(facts, goal, target);
  if (start === undefined) return "no loan balance";
  const kind = kindOf(target);
  const goalAmount =
    options.goalAmount ??
    (kind === "spend less" ? null : goalAmountFrom(kind, change, start.startBalance ?? 0));
  if (goalAmount === null) return "no Goal amount";
  const stored = await storeGoalStart(database, id, {
    goalAmount,
    startsOn: facts.today,
    ...start,
  });
  return stored ? { goalAmount, startsOn: facts.today } : "no active Goal";
}

// What a Goal amount Proposal for an active Goal reads (spec 05, Progress): the Goal's kind, the
// reading's change, and its start if its Goal amount took effect today: the baseline of a spend
// less Goal, the balance of a save Goal, or what the loan owes. Undefined for a Goal that is not
// active or has no target, and when the loan or its balance is not known.
export async function goalStartToday(
  database: Database,
  id: string,
  now = new Date(),
): Promise<
  | {
      kind: GoalKind;
      change: GoalChange | null;
      startBalance: number | null;
      baseline: number | null;
    }
  | undefined
> {
  const goal = await readGoal(database, id);
  if (goal === undefined || goal.status !== "active") return undefined;
  const { target, change } = readingOf(goal);
  if (target === null) return undefined;
  const facts = new Facts(database, now, await householdDay(database, now));
  const start = await startOf(facts, goal, target);
  return start === undefined ? undefined : { kind: kindOf(target), change, ...start };
}

// True when a complete calendar month the Goal was active for the whole of ended at or under the
// Goal amount. A Goal that starts after the 1st first counts the next month, so Spending from
// before the Goal never marks it done.
async function endedAMonthUnder(
  facts: Facts,
  target: GoalTarget,
  startsOn: string,
  goalAmount: number,
): Promise<boolean> {
  const first = startsOn.endsWith("-01")
    ? startsOn.slice(0, 7)
    : monthPlus(startsOn.slice(0, 7), 1);
  const thisMonth = facts.today.slice(0, 7);
  if (first >= thisMonth) return false;
  const byMonth = await spendingByMonth(facts, target, first);
  for (let month = first; month < thisMonth; month = monthPlus(month, 1)) {
    if ((byMonth.get(month) ?? 0) <= goalAmount) return true;
  }
  return false;
}

// A Goal's progress on `facts.today`, or null when the loan or its balance is not known.
async function progressOf(
  facts: Facts,
  goal: StoredGoal,
  target: GoalTarget,
): Promise<GoalProgress | null> {
  const kind = kindOf(target);
  const { goalAmount, startsOn, deadline } = goal;
  if (kind === "pay down a loan" && target.kind === "loan") {
    const owed = await owedOn(facts, target.accountId);
    if (owed === undefined) return null;
    if (goalAmount === null || startsOn === null || goal.startBalance === null) {
      return { ...unset(kind), estimated: false };
    }
    const paid = goal.startBalance - owed;
    return {
      ...loanProgress({ goalAmount, paid, owed, startsOn, deadline, today: facts.today }),
      estimated: false,
    };
  }
  if (kind === "save toward an amount") {
    const { balance, estimated } = await balanceOf(facts, target, startsOn ?? facts.today);
    if (goalAmount === null || startsOn === null || goal.startBalance === null) {
      return { ...unset(kind), estimated };
    }
    const start = goal.startBalance;
    const shown = saveProgress({
      start,
      goalAmount,
      balance,
      startsOn,
      deadline,
      today: facts.today,
    });
    return { ...shown, estimated };
  }
  if (goalAmount === null || startsOn === null || goal.baseline === null) {
    return { ...unset(kind), estimated: false };
  }
  const found =
    target.kind === "Category"
      ? (await facts.categories()).categories.get(target.category)
      : target.kind === "Merchant"
        ? await facts.merchantProjection(target.merchant)
        : undefined;
  // Interest and fees has no projection: its Spending stands for P.
  const projected = found?.projected ?? found?.spending ?? 0;
  return {
    ...spendLessProgress({ baseline: goal.baseline, goalAmount, projected }),
    estimated: false,
    met: await endedAMonthUnder(facts, target, startsOn, goalAmount),
  };
}

const unset = (kind: GoalKind): Omit<GoalProgress, "estimated"> => ({
  kind,
  percentage: null,
  state: null,
  detail: NO_GOAL_AMOUNT,
  met: false,
});

// Every Goal with its progress on `now`'s day, Household time: the active Goals first, then the
// done list, then the dropped list, each oldest first. An active Goal that meets its "Done when"
// rule is set to done today, in one write.
export function listGoalsWithProgress(database: Database, now = new Date()): Promise<Goal[]> {
  return goalsWithProgress(database, now, true);
}

// The Goals as listGoalsWithProgress gives them, for a read that writes nothing, such as Chat's
// lookup: an active Goal that meets its "Done when" rule shows done today, and stays active in
// app.db until the Goals page or the next read that saves sets it.
export function readGoalsWithProgress(database: Database, now = new Date()): Promise<Goal[]> {
  return goalsWithProgress(database, now, false);
}

async function goalsWithProgress(database: Database, now: Date, save: boolean): Promise<Goal[]> {
  const facts = new Facts(database, now, await householdDay(database, now));
  const stored = await listGoals(database);
  const goals: Goal[] = [];
  const met: string[] = [];
  for (const goal of stored) {
    const reading = readingOf(goal);
    const list = listOf(goal, facts.today);
    let progress: GoalProgress | null = null;
    if (list === "active" && reading.target !== null) {
      progress = await progressOf(facts, goal, reading.target);
      if (progress?.met === true && goal.status === "active") met.push(goal.id);
    }
    goals.push({
      id: goal.id,
      words: goal.words,
      authorId: goal.authorId,
      date: goal.date,
      status: goal.status,
      endedOn: goal.endedOn,
      endedBy: goal.endedBy,
      reading,
      goalAmount: goal.goalAmount,
      startsOn: goal.startsOn,
      list,
      progress: progress === null ? null : withoutMet(progress),
    });
  }
  const done = new Set(
    save
      ? await endGoals(database, met, { status: "done", endedOn: facts.today, endedBy: null })
      : met,
  );
  // A done Goal leaves the AI's context at once: the next Writer use builds the summary again.
  if (save && done.size > 0) await dropHouseholdSummary(database);
  for (const goal of goals) {
    if (!done.has(goal.id)) continue;
    goal.status = "done";
    goal.endedOn = facts.today;
  }
  for (const goal of goals) {
    if (goal.status === "done" && goal.list === "active" && goal.progress !== null) {
      goal.progress = { ...goal.progress, state: "Done", percentage: 100 };
    }
  }
  const order: GoalList[] = ["active", "done", "dropped"];
  return goals.sort((a, b) => order.indexOf(a.list) - order.indexOf(b.list));
}

const withoutMet = ({ met: _, ...progress }: GoalProgress): Omit<GoalProgress, "met"> => progress;

// A Member marks an active Goal done or dropped, today, Household time. Undefined when no Goal has
// the ID; "not active" when it is done or dropped already, which changes nothing.
export async function markGoal(
  database: Database,
  id: string,
  status: Exclude<GoalStatus, "active">,
  memberId: string,
  now = new Date(),
): Promise<"marked" | "not active" | undefined> {
  const goal = await readGoal(database, id);
  if (goal === undefined) return undefined;
  const today = await householdDay(database, now);
  const ended = await endGoals(database, [id], { status, endedOn: today, endedBy: memberId });
  if (ended.length !== 1) return "not active";
  // A done or dropped Goal leaves the AI's context at once (spec 05, Rules).
  await dropHouseholdSummary(database);
  return "marked";
}
