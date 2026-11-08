import { CATEGORIES, type Category, isCategory } from "../categories/index.ts";
import {
  type Database,
  listCategoryRules,
  listMerchantCandidates,
  listRulesNamed,
  type MerchantLookup,
  type Queries,
  readCategoryRecords,
  readCategoryRule,
  removeCategoryRule,
  type StoredCategoryRule,
  setHandSetFields,
  storeCategoryRule,
} from "../db/index.ts";
import { askForFollowUp, followUpAgain } from "../follow-up/index.ts";
import { log } from "../log.ts";
import {
  isMaskedMerchant,
  isPaymentApp,
  type Merchant,
  merchantKey,
  sameMerchant,
} from "../merchants/index.ts";
import { merchantOf } from "./cascade.ts";
import { categoryChoiceValue, readCategoryChoice } from "./category-choice.ts";
import { updateCategoryCards } from "./review-cards.ts";

// Category rules (spec 04, Category rules, Re-runs). A Member's correction makes a rule for the
// Transaction's Merchant, and the changed Transaction itself counts as hand-set. The rule covers
// the Merchant's past and future Transactions, except those a Member set by hand: it answers at
// step 2 of the cascade, and sets only the Category, never the type. Each Merchant has at most one
// rule, and a newer correction replaces the older rule. Making, changing, or deleting a rule marks
// the Merchant's Transactions for the follow-up job, which decides them again and runs the cascade
// again, so Categorization never runs beside a sync.

export type CategoryRule = {
  id: string;
  merchant: Merchant;
  category: Category;
  madeAt: Date;
};

const merchantOfRule = (rule: StoredCategoryRule): Merchant => ({
  id: rule.merchantId,
  name: rule.merchantName,
});

const lookupOf = (merchant: Merchant): MerchantLookup => ({
  merchantId: merchant.id,
  merchantKey: merchantKey(merchant.name),
});

// The stored rules that are this Merchant's.
async function rulesOf(database: Queries, merchant: Merchant): Promise<StoredCategoryRule[]> {
  return (await listRulesNamed(database, lookupOf(merchant))).filter((rule) =>
    sameMerchant(merchantOfRule(rule), merchant),
  );
}

// Step 2: the Category rule for the Transaction's Merchant. A rule matches a Transaction with the
// same Merchant ID; when the rule or the Transaction has no Merchant ID, it matches by clean name.
// When two rules match, such as a rule with no Merchant ID and one with the Transaction's, the one
// with the same Merchant ID wins, then the newer one.
export async function ruleFor(
  database: Queries,
  merchant: Merchant | null,
): Promise<CategoryRule | undefined> {
  if (merchant === null) return undefined;
  const [best] = (await rulesOf(database, merchant))
    .filter((rule) => isCategory(rule.category))
    .sort(
      (a, b) =>
        Number(b.merchantId !== null && b.merchantId === merchant.id) -
          Number(a.merchantId !== null && a.merchantId === merchant.id) ||
        b.madeAt.getTime() - a.madeAt.getTime(),
    );
  return best === undefined ? undefined : ruleOf(best);
}

function ruleOf(stored: StoredCategoryRule): CategoryRule {
  if (!isCategory(stored.category)) throw new Error("A Category rule holds an unknown Category.");
  return {
    id: stored.id,
    merchant: merchantOfRule(stored),
    category: stored.category,
    madeAt: stored.madeAt,
  };
}

// Whether a correction on a Transaction with this Merchant may make a rule. A Transaction with no
// Merchant, such as a paper check, makes none. Neither does a payment-app line that names no
// person, such as VENMO PAYMENT: its Merchant is the payment app. A line that names a person, as
// Zelle lines do, has the person as its Merchant, who may have a rule. Nor does a masked Merchant,
// such as Privacy.com: its bank line hides the shop, so one Merchant holds many shops.
export function makesRule(merchant: Merchant | null): merchant is Merchant {
  return merchant !== null && !isPaymentApp(merchant) && !isMaskedMerchant(merchant);
}

// The IDs of the Merchant's shown Transactions, oldest first.
async function transactionsOf(database: Queries, merchant: Merchant): Promise<string[]> {
  const candidates = await listMerchantCandidates(database, { merchantId: merchant.id });
  return candidates
    .filter((txn) => sameMerchant({ id: txn.merchantId, name: txn.merchantCleanName }, merchant))
    .map((txn) => txn.id);
}

// Makes the Merchant's rule in place of its earlier ones, and marks for the follow-up job the
// Transactions each rule covers. Writes only through `database`, so it may run inside a
// correction's transaction. Call askForFollowUp after it commits.
async function makeRule(
  database: Queries,
  merchant: Merchant,
  category: Category,
  made: { memberId: string; at: Date },
): Promise<string> {
  const replaced = await rulesOf(database, merchant);
  const id = await storeCategoryRule(
    database,
    {
      merchantId: merchant.id,
      merchantName: merchant.name,
      merchantKey: merchantKey(merchant.name),
      category,
      madeAt: made.at,
      madeBy: made.memberId,
    },
    replaced.map((rule) => rule.id),
  );
  const again = new Set(await transactionsOf(database, merchant));
  for (const rule of replaced) {
    for (const txn of await transactionsOf(database, merchantOfRule(rule))) again.add(txn);
  }
  await followUpAgain(database, [...again]);
  log.info("A Member's correction made a Category rule", {
    replaced: replaced.length,
    transactions: again.size,
  });
  return id;
}

// Starts a follow-up job for Transactions a Member's change made unhandled. If that fails, the app
// logs it: the change is stored, and the next follow-up job handles them.
async function followUpSoon(): Promise<void> {
  try {
    await askForFollowUp();
  } catch (error) {
    log.error("Could not start a follow-up job after a Member's change", { error });
  }
}

// A Member gives a Transaction a Category (spec 04, Category rules). The Category becomes the
// Transaction's hand-set Category, and, unless the Member picks "only this Transaction", the app
// makes a Category rule for its Merchant. Giving a Category to a Transfer, Income, or Saving also
// sets its type to Spending by hand. One Category for the whole Transaction ends any split (spec 04,
// Splits). Writes only through `database`, so it may run inside a Review list answer's transaction.
// Call askForFollowUp after it commits.
export async function applyCorrection(
  database: Queries,
  record: { id: string; merchant: Merchant | null; takesCategory: boolean },
  category: Category,
  options: { onlyThisTransaction: boolean; memberId: string; at: Date },
): Promise<{ ruleId: string | null; setSpending: boolean }> {
  const setSpending = !record.takesCategory;
  await setHandSetFields(database, record.id, {
    category,
    split: undefined,
    ...(setSpending ? { type: "Spending" } : {}),
  });
  await followUpAgain(database, [record.id]);
  const ruleId =
    !options.onlyThisTransaction && makesRule(record.merchant)
      ? await makeRule(database, record.merchant, category, options)
      : null;
  return { ruleId, setSpending };
}

// The part types that have a Category (spec 03, Transaction types).
const TAKES_CATEGORY: ReadonlySet<string> = new Set(["Spending", "Refund", "Reimbursement"]);

// Whether the Transaction's type has a Category: Spending, a Refund, or a Reimbursement. A
// Transfer, Income, or Saving has none.
export function takesCategory(record: { parts: readonly { type: string }[] }): boolean {
  return record.parts.some((part) => TAKES_CATEGORY.has(part.type));
}

export type Correction =
  | { result: "corrected"; category: Category; rule: CategoryRule | null; setSpending: boolean }
  | { result: "not found" }
  | { result: "not decided" };

// PUT /api/transactions/:id/category. "Not found" when no Transaction that shows has the ID, and
// "not decided" before Matching has decided its type, since the type decides whether the Category
// also sets it to Spending.
export async function correctCategory(
  database: Database,
  transactionId: string,
  category: Category,
  options: { onlyThisTransaction: boolean; memberId: string },
  now = new Date(),
): Promise<Correction> {
  const applied = await database.transaction(async (tx) => {
    const [record] = await readCategoryRecords(tx, [transactionId]);
    if (record === undefined || record.hidden) return "not found" as const;
    if (record.parts.length === 0) return "not decided" as const;
    return applyCorrection(
      tx,
      { id: record.id, merchant: merchantOf(record), takesCategory: takesCategory(record) },
      category,
      { ...options, at: now },
    );
  });
  if (typeof applied === "string") return { result: applied };
  // A hand-set Transaction leaves its Category card on the Review list at once (spec 04, Review
  // list items). If that fails, the follow-up job takes it off.
  try {
    await updateCategoryCards(database, [transactionId]);
  } catch (error) {
    log.error("Could not take a hand-set Transaction off its Review list card", { error });
  }
  await followUpSoon();
  log.info("A Member set a Transaction's Category by hand", {
    rule: applied.ruleId !== null,
    setSpending: applied.setSpending,
  });
  const rule =
    applied.ruleId === null ? undefined : await readCategoryRule(database, applied.ruleId);
  return {
    result: "corrected",
    category,
    rule: rule === undefined ? null : ruleOf(rule),
    setSpending: applied.setSpending,
  };
}

// Every Category rule, by Merchant name, for Settings → Categories.
export async function categoryRules(database: Queries): Promise<CategoryRule[]> {
  return (await listCategoryRules(database))
    .filter((rule) => isCategory(rule.category))
    .map(ruleOf);
}

// Deletes a rule, then runs the cascade again on the Merchant's Transactions not set by hand.
// False when no rule has the ID.
export async function deleteCategoryRule(database: Database, id: string): Promise<boolean> {
  const removed = await database.transaction(async (tx) => {
    const rule = await removeCategoryRule(tx, id);
    if (rule !== undefined) await followUpAgain(tx, await transactionsOf(tx, merchantOfRule(rule)));
    return rule;
  });
  if (removed === undefined) return false;
  await followUpSoon();
  log.info("A Member deleted a Category rule");
  return true;
}

// The choices behind "Not this" on a Category item (spec 04, Review list items): each Category,
// which makes a rule, and, when the Transaction's Merchant may have one, each Category for only
// this Transaction.
export function categoryChoices(merchant: Merchant | null): { value: string; label: string }[] {
  const names = CATEGORIES.map((category) => category.name);
  return [
    ...names.map((name) => ({ value: name, label: name })),
    ...(makesRule(merchant)
      ? names.map((name) => ({
          value: categoryChoiceValue(name, true),
          label: `${name}, only this Transaction`,
        }))
      : []),
  ];
}

export { readCategoryChoice };
