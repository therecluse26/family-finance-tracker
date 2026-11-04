import { isCategory } from "../categories/index.ts";
import {
  type Database,
  type DraftAcceptance,
  readBudgetInputs,
  storeBudgetEdit,
  storeDraftAcceptance,
  storeFollowTheBill,
} from "../db/index.ts";
import { log } from "../log.ts";
import { householdMonth } from "./first-draft.ts";
import { type Budget, budgetOf } from "./stored.ts";

// A Member's changes to Budgets (spec 05, Changing Budgets; When the app drafts): an edit of any
// Budget, "Follow the bill" on a pinned Bills Budget, and "Accept all" on the draft. Each takes
// effect in the Household's current month.

// Edits the Budget in effect this month: from this month, or for a yearly Budget the whole current
// year. An edited Bills Budget is pinned. Undefined when the Category has no Budget.
export async function editBudget(
  database: Database,
  edit: { category: string; amount: number; memberId: string },
  now = new Date(),
): Promise<Budget | undefined> {
  const { category } = edit;
  if (!isCategory(category)) return undefined;
  const stored = await storeBudgetEdit(database, await householdMonth(database, now), {
    category,
    amount: edit.amount,
    setBy: edit.memberId,
    setAt: now,
  });
  if (stored === undefined) return undefined;
  log.info("A Member edited a Budget", { period: stored.period, pinned: stored.pinned });
  return budgetOf({ ...stored, category });
}

// Puts a pinned Bills Budget back on the formula from the next month. It keeps the typed amount
// this month.
export async function followTheBill(
  database: Database,
  follow: { category: string; memberId: string },
  now = new Date(),
): Promise<Budget | "no Budget" | "not pinned"> {
  const { category } = follow;
  if (!isCategory(category)) return "no Budget";
  const stored = await storeFollowTheBill(database, await householdMonth(database, now), {
    category,
    setBy: follow.memberId,
    setAt: now,
  });
  if (typeof stored === "string") return stored;
  log.info("A Member set a Bills Budget to follow the bill");
  return budgetOf({ ...stored, category });
}

// Accepts the whole draft with one click. The draft is active either way; the first acceptance
// stands. Undefined before the first draft.
export async function acceptDraft(
  database: Database,
  memberId: string,
  now = new Date(),
): Promise<DraftAcceptance | undefined> {
  if ((await readBudgetInputs(database)) === undefined) return undefined;
  const accepted = await storeDraftAcceptance(database, { acceptedAt: now, acceptedBy: memberId });
  log.info("A Member accepted the Budget draft");
  return accepted;
}
