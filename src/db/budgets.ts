import { and, desc, eq, isNull, lte, min, or } from "drizzle-orm";
import type { Database } from "./client.ts";
import { budgetInputs, budgets, transactions } from "./schema.ts";

// Budgets in app.db (spec 05, Drafting Budgets, Stored Budgets), and where history starts. The
// budgets module decides; these functions store and read. A draft reads Spending through
// listPostedParts and tracked loan payments through the loan reads.

export type StoredBudget = typeof budgets.$inferSelect;
export type NewBudget = Omit<StoredBudget, "id">;
export type BudgetInputs = Omit<typeof budgetInputs.$inferSelect, "id">;

const BUDGET_INPUTS_ROW = 1;

// The earliest posted date of a shown Transaction on any Account, where history starts, or
// undefined with none.
export async function readHistoryStart(database: Database): Promise<string | undefined> {
  const [row] = await database
    .select({ first: min(transactions.postedDate) })
    .from(transactions)
    .where(and(isNull(transactions.hiddenReason), eq(transactions.pending, false)));
  return row?.first ?? undefined;
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

// Stores the first draft: its inputs and its Budgets, in one write. False, with nothing written,
// when a first draft is already stored.
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
    return true;
  });
}

// Each Category's Budget in effect in `month` (YYYY-MM): the newest monthly Budget that takes
// effect in it or before, and the newest yearly Budget that takes effect in its year or before.
export async function listBudgetsInEffect(
  database: Database,
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
