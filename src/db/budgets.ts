import { and, desc, eq, inArray, isNull, like, lte, min, or, sql } from "drizzle-orm";
import type { Database, Queries } from "./client.ts";
import {
  budgetDraftAcceptance,
  budgetInputs,
  budgetMonthStarts,
  budgets,
  transactionParts,
  transactions,
} from "./schema.ts";

// Budgets in app.db (spec 05, Drafting Budgets, Stored Budgets), and where history starts. The
// budgets module decides; these functions store and read. A draft reads Spending through
// listPostedParts and tracked loan payments through the loan reads.

export type StoredBudget = typeof budgets.$inferSelect;
export type NewBudget = Omit<StoredBudget, "id">;
export type BudgetInputs = Omit<typeof budgetInputs.$inferSelect, "id">;
export type DraftAcceptance = Omit<typeof budgetDraftAcceptance.$inferSelect, "id">;
export type MonthStart = Omit<typeof budgetMonthStarts.$inferSelect, "month">;

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
  const { id: _, ...inputs } = row;
  return inputs;
}

// Stores the first draft: its inputs and its Budgets, in one write. Its month's Month start work is
// then done. False, with nothing written, when a first draft is already stored.
export async function storeFirstDraft(
  database: Database,
  draft: { inputs: BudgetInputs; budgets: readonly NewBudget[] },
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const claimed = await tx
      .insert(budgetInputs)
      .values({ id: BUDGET_INPUTS_ROW, ...draft.inputs })
      .onConflictDoNothing()
      .returning({ id: budgetInputs.id });
    if (claimed.length === 0) return false;
    if (draft.budgets.length > 0) await tx.insert(budgets).values([...draft.budgets]);
    const done = { doneAt: draft.inputs.recordedAt, failedTries: 0 };
    await tx
      .insert(budgetMonthStarts)
      .values({ month: draft.inputs.firstDraftMonth, ...done })
      .onConflictDoUpdate({ target: budgetMonthStarts.month, set: done });
    return true;
  });
}

// Each Category's Budget in effect in `month` (YYYY-MM): the newest monthly Budget that takes
// effect in it or before, and the newest yearly Budget that takes effect in its year or before.
export async function listBudgetsInEffect(
  database: Queries,
  month: string,
): Promise<StoredBudget[]> {
  const rows = await database
    .select()
    .from(budgets)
    .where(
      or(
        and(eq(budgets.period, "monthly"), lte(budgets.takesEffect, month)),
        and(eq(budgets.period, "yearly"), lte(budgets.takesEffect, month.slice(0, 4))),
      ),
    )
    .orderBy(desc(budgets.takesEffect), desc(budgets.id));
  const newest = new Map<string, StoredBudget>();
  for (const row of rows) if (!newest.has(row.category)) newest.set(row.category, row);
  return [...newest.values()];
}

// A Budget the formula sets for a month (spec 05, When the app drafts; Changing Budgets).
// - `follows`: a Bills Budget, which follows the formula each month. It replaces the Budget in
//   effect unless that one is pinned, or a Member set this month's by hand.
// - `first`: it becomes the Category's first Budget when the Category has none in effect.
// An entry that is neither changes nothing.
export type MonthBudget = NewBudget & { follows: boolean; first: boolean };

// Stores the formula's Budgets for `month` (YYYY-MM) in one write, each by its rule above. A month's
// formula Budget that is already stored is updated in place, so running twice stores nothing new.
// Returns how many Budgets it wrote.
export async function storeMonthBudgets(
  database: Database,
  month: string,
  entries: readonly MonthBudget[],
): Promise<number> {
  return database.transaction(async (tx) => {
    const inEffect = new Map(
      (await listBudgetsInEffect(tx, month)).map((row) => [row.category, row]),
    );
    let written = 0;
    for (const { follows, first, ...entry } of entries) {
      const current = inEffect.get(entry.category);
      if (current === undefined) {
        if (!first) continue;
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
    return written;
  });
}

// A Member's edit of the Budget in effect in `month` (spec 05, Changing Budgets): it takes effect in
// that month, or for a yearly Budget in that whole year. An edited Bills Budget is pinned. Returns
// the new Budget, or undefined when the Category has no Budget in effect.
export async function storeBudgetEdit(
  database: Database,
  month: string,
  edit: { category: string; amount: number; setBy: string; setAt: Date },
): Promise<StoredBudget | undefined> {
  return database.transaction(async (tx) => {
    const current = (await listBudgetsInEffect(tx, month)).find(
      (row) => row.category === edit.category,
    );
    if (current === undefined) return undefined;
    const [stored] = await tx
      .insert(budgets)
      .values({
        ...edit,
        period: current.period,
        takesEffect: current.period === "yearly" ? month.slice(0, 4) : month,
        source: "Member edit",
        // Only a Bills Budget has a pinned flag.
        pinned: current.pinned === null ? null : true,
      })
      .returning();
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
      .returning();
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
