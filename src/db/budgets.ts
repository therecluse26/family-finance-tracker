import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  like,
  lte,
  min,
  or,
  sql,
} from "drizzle-orm";
import type { Database, Queries } from "./client.ts";
import {
  budgetDraftAcceptance,
  budgetInputs,
  budgetMonthStarts,
  budgets,
  budgetTailoringRuns,
  transactionParts,
  transactions,
} from "./schema.ts";

// Budgets in app.db (spec 05, Drafting Budgets, Stored Budgets), and where history starts. The
// budgets module decides; these functions store and read. A draft reads Spending through
// listPostedParts and tracked loan payments through the loan reads.

// A Budget as the app reads it. A row that ends a Category's Budget (`noBudget`) is never one: it
// only hides the Budget before it.
export type StoredBudget = Omit<typeof budgets.$inferSelect, "noBudget">;
// Only an "AI draft" Budget has a reason.
export type NewBudget = Omit<StoredBudget, "id" | "reason"> & { reason?: string | null };
// The redraft marks are read through src/db/budget-tailoring.ts.
export type BudgetInputs = Omit<
  typeof budgetInputs.$inferSelect,
  "id" | "redraftedAt" | "benchmarkRedraftAt"
>;
export type DraftAcceptance = Omit<typeof budgetDraftAcceptance.$inferSelect, "id">;
export type MonthStart = Omit<typeof budgetMonthStarts.$inferSelect, "month">;

const { noBudget: _noBudget, ...BUDGET_COLUMNS } = getTableColumns(budgets);

const BUDGET_INPUTS_ROW = 1;
const ACCEPTANCE_ROW = 1;

// The earliest posted date of a shown Transaction on any Account, where history starts, or
// undefined with none.
export async function readHistoryStart(database: Database): Promise<string | undefined> {
  const [row] = await database
    .select({ first: min(transactions.postedDate) })
    .from(transactions)
    .where(and(isNull(transactions.hiddenReason), eq(transactions.pending, false)));
  return row?.first ?? undefined;
}

// The Merchant and the provider's category of each shown, posted Transaction with a Spending,
// Refund or Reimbursement part, for the projection and the Large purchase population (spec 06, The
// projection; Large purchase). With `loanPaymentsOnly`, only those under a LOAN_PAYMENTS_* code.
export async function listSpendingTransactions(
  database: Database,
  options: { loanPaymentsOnly?: boolean } = {},
): Promise<
  {
    id: string;
    merchantId: string | null;
    merchantCleanName: string | null;
    providerCategory: string | null;
  }[]
> {
  return database
    .selectDistinct({
      id: transactions.id,
      merchantId: transactions.merchantId,
      merchantCleanName: transactions.merchantCleanName,
      providerCategory: transactions.providerCategory,
    })
    .from(transactions)
    .innerJoin(transactionParts, eq(transactionParts.transactionId, transactions.id))
    .where(
      and(
        inArray(transactionParts.type, ["Spending", "Refund", "Reimbursement"]),
        eq(transactions.pending, false),
        isNull(transactions.hiddenReason),
        options.loanPaymentsOnly === true
          ? // "_" matches any one character here; the budgets module checks the code itself.
            like(transactions.providerCategory, "LOAN_PAYMENTS_%")
          : undefined,
      ),
    );
}

export async function readBudgetInputs(database: Database): Promise<BudgetInputs | undefined> {
  const [row] = await database
    .select()
    .from(budgetInputs)
    .where(eq(budgetInputs.id, BUDGET_INPUTS_ROW));
  if (row === undefined) return undefined;
  const { id: _, redraftedAt: _redrafted, benchmarkRedraftAt: _benchmark, ...inputs } = row;
  return inputs;
}

// Stores the first draft: its inputs and its Budgets, in one write. Its month's Month start work is
// then done. False, with nothing written, when a first draft is already stored. With `tailored`,
// the draft took the AI's figures, so the Tailoring run is stored as ended in the same write and
// never runs. A Tailoring run already waiting ends with it.
export async function storeFirstDraft(
  database: Database,
  draft: { inputs: BudgetInputs; budgets: readonly NewBudget[]; tailored?: boolean },
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const claimed = await tx
      .insert(budgetInputs)
      .values({ id: BUDGET_INPUTS_ROW, ...draft.inputs })
      .onConflictDoNothing()
      .returning({ id: budgetInputs.id });
    if (claimed.length === 0) return false;
    if (draft.budgets.length > 0) await tx.insert(budgets).values([...draft.budgets]);
    if (draft.tailored === true) {
      // A Tailoring run an earlier try of this step asked for ends here, and none is added.
      const at = draft.inputs.recordedAt;
      await tx
        .update(budgetTailoringRuns)
        .set({ endedAt: at })
        .where(and(eq(budgetTailoringRuns.kind, "Tailoring"), isNull(budgetTailoringRuns.endedAt)));
      await tx
        .insert(budgetTailoringRuns)
        .values({ kind: "Tailoring", requestedAt: at, endedAt: at })
        .onConflictDoNothing();
    }
    const done = { doneAt: draft.inputs.recordedAt, failedTries: 0 };
    await tx
      .insert(budgetMonthStarts)
      .values({ month: draft.inputs.firstDraftMonth, ...done })
      .onConflictDoUpdate({ target: budgetMonthStarts.month, set: done });
    return true;
  });
}

// Each Category's newest row in `month` (YYYY-MM): the newest monthly row that takes effect in it
// or before, and the newest yearly row that takes effect in its year or before. It is the Budget in
// effect, or a row that ends the Category's Budget.
async function newestRows(
  database: Queries,
  month: string,
): Promise<Map<string, StoredBudget & { noBudget: boolean }>> {
  const rows = await database
    .select({ ...BUDGET_COLUMNS, noBudget: budgets.noBudget })
    .from(budgets)
    .where(
      or(
        and(eq(budgets.period, "monthly"), lte(budgets.takesEffect, month)),
        and(eq(budgets.period, "yearly"), lte(budgets.takesEffect, month.slice(0, 4))),
      ),
    )
    .orderBy(desc(budgets.takesEffect), desc(budgets.id));
  return newestIn(rows, month);
}

// A Budget row, or a row that ends a Category's Budget, as listBudgetVersions gives it.
export type BudgetVersion = StoredBudget & { noBudget: boolean };

// Each Category's newest row in `month` among `rows`, which run newest first: by the month or year
// they take effect, then by ID.
function newestIn(rows: readonly BudgetVersion[], month: string): Map<string, BudgetVersion> {
  const newest = new Map<string, BudgetVersion>();
  for (const row of rows) {
    const from = row.period === "monthly" ? month : month.slice(0, 4);
    if (row.takesEffect <= from && !newest.has(row.category)) newest.set(row.category, row);
  }
  return newest;
}

// Every Budget row, and every row that ends a Budget, newest first, so a report reads them once
// for all its months and picks each month's with budgetsInEffectAmong.
export async function listBudgetVersions(database: Queries): Promise<BudgetVersion[]> {
  return database
    .select({ ...BUDGET_COLUMNS, noBudget: budgets.noBudget })
    .from(budgets)
    .orderBy(desc(budgets.takesEffect), desc(budgets.id));
}

// Each Category's Budget in effect in `month` (YYYY-MM) among `versions`, from
// listBudgetVersions. A Category whose newest row ends its Budget has none.
export function budgetsInEffectAmong(
  versions: readonly BudgetVersion[],
  month: string,
): StoredBudget[] {
  return [...newestIn(versions, month).values()].flatMap(({ noBudget, ...row }) =>
    noBudget ? [] : [row],
  );
}

// Each Category's Budget in effect in `month` (YYYY-MM). A Category whose newest row ends its
// Budget has none.
export async function listBudgetsInEffect(
  database: Queries,
  month: string,
): Promise<StoredBudget[]> {
  return budgetsInEffectAmong([...(await newestRows(database, month)).values()], month);
}

// A Budget the formula sets for a month (spec 05, When the app drafts; Changing Budgets).
// - `follows`: a Bills Budget, which follows the formula each month. It replaces the Budget in
//   effect unless that one is pinned, or a Member set this month's by hand.
// - `first`: it becomes the Category's first Budget when the Category has none in effect. A
//   Category whose first Budget a Member undid gets none this way: it stays without a Budget until
//   a Member sets one (spec 05, When the app drafts: an undone first Budget).
// - `sharesTWith`: the Category this one shares T with, Groceries or Superstores (spec 05, Shopping:
//   Groceries and Superstores). When that one gets its first Budget in this write while the formula
//   set this one's Budget in effect, this entry replaces it, so their total stays T. A Budget a
//   Member set, or an AI draft, never changes this way, and neither does any Budget for $0.
// An entry that is none of these changes nothing.
export type MonthBudget = NewBudget & { follows: boolean; first: boolean; sharesTWith?: string };

// Stores the formula's Budgets for `month` (YYYY-MM) in one write, each by its rule above. A month's
// formula Budget that is already stored is updated in place, so running twice stores nothing new.
// Returns how many Budgets it wrote.
export async function storeMonthBudgets(
  database: Database,
  month: string,
  entries: readonly MonthBudget[],
): Promise<number> {
  return database.transaction(async (tx) => {
    const newest = await newestRows(tx, month);
    let written = 0;
    // The Categories that get their first Budget in this write, and the entries that wait on them.
    const firsts = new Set<string>();
    const shares: { sharesTWith: string; current: StoredBudget; entry: NewBudget }[] = [];
    for (const { follows, first, sharesTWith, ...entry } of entries) {
      const row = newest.get(entry.category);
      const current = row?.noBudget === true ? undefined : row;
      if (current === undefined) {
        // Only the Undo of a first Budget leaves a row that ends the Budget.
        if (!first || row?.noBudget === true) continue;
        firsts.add(entry.category);
      } else if (sharesTWith !== undefined) {
        shares.push({ sharesTWith, current, entry });
        continue;
      } else {
        if (!follows || current.pinned === true) continue;
        if (current.takesEffect === entry.takesEffect) {
          // A Member's edit, or "Follow the bill", this month: the formula takes over next month.
          if (current.source !== "formula" || current.amount === entry.amount) continue;
          await tx
            .update(budgets)
            .set({ amount: entry.amount, setAt: entry.setAt })
            .where(eq(budgets.id, current.id));
          written += 1;
          continue;
        }
      }
      await tx.insert(budgets).values(entry);
      written += 1;
    }
    for (const { sharesTWith, current, entry } of shares) {
      if (!firsts.has(sharesTWith) || current.source !== "formula") continue;
      // A share that rounds to $0 leaves the Budget as it is: never a $0 Budget this way.
      if (entry.amount <= 0 || current.amount === entry.amount) continue;
      if (current.takesEffect === entry.takesEffect) {
        await tx
          .update(budgets)
          .set({ amount: entry.amount, setAt: entry.setAt })
          .where(eq(budgets.id, current.id));
      } else {
        await tx.insert(budgets).values(entry);
      }
      written += 1;
    }
    return written;
  });
}

// A Member's edit of the Budget in effect in `month` (spec 05, Changing Budgets): it takes effect in
// that month, or for a yearly Budget in that whole year. An edited Bills Budget is pinned. A
// Category whose first Budget a Member undid gets its Budget again this way, in the period it had
// (spec 05, When the app drafts: an undone first Budget). A Category that never had a Budget gets
// its first one this way, in `period`, the Category's own (spec 05, Changing Budgets: a Member may
// edit any Budget). `bills` says whether it is a Bills Category. Returns the new Budget, or
// undefined before the first draft's month, when no month has a Budget.
export async function storeBudgetEdit(
  database: Database,
  month: string,
  edit: {
    category: string;
    amount: number;
    setBy: string;
    setAt: Date;
    bills: boolean;
    period: StoredBudget["period"];
  },
): Promise<StoredBudget | undefined> {
  const { bills, period: ownPeriod, ...fields } = edit;
  return database.transaction(async (tx) => {
    const [inputs] = await tx
      .select({ firstDraftMonth: budgetInputs.firstDraftMonth })
      .from(budgetInputs)
      .where(eq(budgetInputs.id, BUDGET_INPUTS_ROW));
    if (inputs === undefined || month < inputs.firstDraftMonth) return undefined;
    const current = (await newestRows(tx, month)).get(edit.category);
    // Only a Bills Budget has a pinned flag. A row that ends a Budget has none of its own.
    const pinned = current === undefined || current.noBudget ? bills : current.pinned !== null;
    const period = current?.period ?? ownPeriod;
    const [stored] = await tx
      .insert(budgets)
      .values({
        ...fields,
        period,
        takesEffect: period === "yearly" ? month.slice(0, 4) : month,
        source: "Member edit",
        pinned: pinned ? true : null,
      })
      .returning(BUDGET_COLUMNS);
    return stored;
  });
}

// "Follow the bill" on a pinned Bills Budget (spec 05, Bills group): it stays at the typed amount
// this month, unpinned, so the formula sets it again from the next month. Returns the new Budget,
// "no Budget" when the Category has none in effect, or "not pinned".
export async function storeFollowTheBill(
  database: Database,
  month: string,
  follow: { category: string; setBy: string; setAt: Date },
): Promise<StoredBudget | "no Budget" | "not pinned"> {
  return database.transaction(async (tx) => {
    const current = (await listBudgetsInEffect(tx, month)).find(
      (row) => row.category === follow.category,
    );
    if (current === undefined) return "no Budget";
    if (current.pinned !== true) return "not pinned";
    const [stored] = await tx
      .insert(budgets)
      .values({
        ...follow,
        amount: current.amount,
        period: current.period,
        takesEffect: month,
        source: "Member edit",
        pinned: false,
      })
      .returning(BUDGET_COLUMNS);
    return stored ?? "no Budget";
  });
}

export async function readDraftAcceptance(
  database: Database,
): Promise<DraftAcceptance | undefined> {
  const [row] = await database
    .select()
    .from(budgetDraftAcceptance)
    .where(eq(budgetDraftAcceptance.id, ACCEPTANCE_ROW));
  if (row === undefined) return undefined;
  const { id: _, ...acceptance } = row;
  return acceptance;
}

// Records a Member's "Accept all" of the draft. The first one stands; a later one changes nothing.
export async function storeDraftAcceptance(
  database: Database,
  acceptance: DraftAcceptance,
): Promise<DraftAcceptance> {
  await database
    .insert(budgetDraftAcceptance)
    .values({ id: ACCEPTANCE_ROW, ...acceptance })
    .onConflictDoNothing();
  return (await readDraftAcceptance(database)) ?? acceptance;
}

export async function readMonthStart(
  database: Database,
  month: string,
): Promise<MonthStart | undefined> {
  const [row] = await database
    .select()
    .from(budgetMonthStarts)
    .where(eq(budgetMonthStarts.month, month));
  if (row === undefined) return undefined;
  const { month: _, ...state } = row;
  return state;
}

export async function markMonthStartDone(
  database: Database,
  month: string,
  at: Date,
): Promise<void> {
  const done = { doneAt: at, failedTries: 0 };
  await database
    .insert(budgetMonthStarts)
    .values({ month, ...done })
    .onConflictDoUpdate({ target: budgetMonthStarts.month, set: done });
}

// Counts one failed Month start run for `month`. Returns its tries so far.
export async function countMonthStartFailure(database: Database, month: string): Promise<number> {
  const [row] = await database
    .insert(budgetMonthStarts)
    .values({ month, failedTries: 1 })
    .onConflictDoUpdate({
      target: budgetMonthStarts.month,
      set: { failedTries: sql`${budgetMonthStarts.failedTries} + 1` },
    })
    .returning({ failedTries: budgetMonthStarts.failedTries });
  return row?.failedTries ?? 1;
}
