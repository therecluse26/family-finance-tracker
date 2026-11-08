import { mapPlaidCategory, plaidConfidence } from "../bank/index.ts";
import { type Category, isCategory } from "../categories/index.ts";
import type {
  CategoryConfidence,
  CategoryRecord,
  CategorySource,
  MerchantHistoryRow,
} from "../db/index.ts";
import { isMaskedMerchant, type Merchant, merchantKey, sameMerchant } from "../merchants/index.ts";

// The categorization cascade (spec 04, The categorization cascade). Each Spending Transaction
// takes the first answer it gets: 1 hand-set, 2 a Member's Category on its Recurring charge, then a
// Category rule, 3 a confident provider category, 4 the Merchant's own history, 5 the AI, 6 the best
// guess. Step 2 belongs to Recurring charges and Category rules, which register it here; an empty
// step gives no answer. Step 5 asks the AI in batches, so the
// Categorization step runs it (src/categorization/categorize.ts).

// A Category and the step that chose it, with that step's confidence (spec 04, Provenance).
export type Choice = { category: Category; source: CategorySource; confidence: CategoryConfidence };

// What the cascade reads of a Transaction. A Category a Member set by hand is its hand-set field
// `category`.
export type CascadeInput = {
  id: string;
  postedDate: string;
  merchant: Merchant | null;
  providerCategory: string | null;
  providerCategoryConfidence: string | null;
  handSet: Record<string, unknown>;
};

// A registered step's answer. A Category rule is certain.
export type CascadeAnswer = { category: Category; confidence: CategoryConfidence };
export type CascadeStep = (txn: CascadeInput) => Promise<CascadeAnswer | undefined>;
export type RegisteredStep = "Recurring charge" | "Category rule";

const registered = new Map<RegisteredStep, CascadeStep>();

// Registers a part of step 2: a Member's Category on the Recurring charge the Transaction is in
// (X31), which comes first, then the Merchant's Category rule (T32). Returns a function that
// removes it again.
export function registerCascadeStep(source: RegisteredStep, step: CascadeStep): () => void {
  if (registered.has(source)) throw new Error(`The cascade's ${source} step already has a rule.`);
  registered.set(source, step);
  return () => {
    if (registered.get(source) === step) registered.delete(source);
  };
}

async function registeredAnswer(
  source: RegisteredStep,
  txn: CascadeInput,
): Promise<Choice | undefined> {
  const answer = await registered.get(source)?.(txn);
  return answer === undefined ? undefined : { ...answer, source };
}

// Step 1.
function handSet(txn: CascadeInput): Choice | undefined {
  const category = txn.handSet.category;
  return typeof category === "string" && isCategory(category)
    ? { category, source: "hand-set", confidence: "certain" }
    : undefined;
}

// Steps 1 and 2: the answers that win over a Category a Money movement rule names. In step 2, a
// Member's Category on the Transaction's Recurring charge comes before the Merchant's Category rule.
export async function handSetOrRule(txn: CascadeInput): Promise<Choice | undefined> {
  return (
    handSet(txn) ??
    (await registeredAnswer("Recurring charge", txn)) ??
    (await registeredAnswer("Category rule", txn))
  );
}

// One Spending Transaction in a Merchant's history. Its Category is null while it waits for the
// AI's answer.
type Entry = {
  id: string;
  postedDate: string;
  merchant: Merchant;
  category: Category | null;
  source: CategorySource | null;
};

const isBefore = (a: { postedDate: string; id: string }, b: { postedDate: string; id: string }) =>
  a.postedDate < b.postedDate || (a.postedDate === b.postedDate && a.id < b.id);

// Each Merchant's Spending Transactions and their Categories. The cascade works through
// Transactions oldest first and adds each one it chooses, so history builds in date order.
// "Before this one" follows the same order: the posted date, then the ID.
export class MerchantHistory {
  private readonly entries = new Map<string, Entry>();
  // The entries by the provider's Merchant ID, and by clean name as identity compares it.
  private readonly byMerchantId = new Map<string, Set<Entry>>();
  private readonly byName = new Map<string, Set<Entry>>();

  constructor(rows: readonly MerchantHistoryRow[]) {
    for (const row of rows) {
      if (!isCategory(row.category)) continue;
      this.set({
        id: row.id,
        postedDate: row.postedDate,
        merchant: { id: row.merchantId, name: row.merchantCleanName },
        category: row.category,
        source: row.categorySource,
      });
    }
  }

  private static bucket(index: Map<string, Set<Entry>>, key: string): Set<Entry> {
    let bucket = index.get(key);
    if (bucket === undefined) {
      bucket = new Set();
      index.set(key, bucket);
    }
    return bucket;
  }

  // Adds a Transaction, in place of its earlier entry.
  set(entry: Entry): void {
    this.remove(entry.id);
    this.entries.set(entry.id, entry);
    if (entry.merchant.id !== null) {
      MerchantHistory.bucket(this.byMerchantId, entry.merchant.id).add(entry);
    }
    MerchantHistory.bucket(this.byName, merchantKey(entry.merchant.name)).add(entry);
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    this.entries.delete(id);
    if (entry.merchant.id !== null) this.byMerchantId.get(entry.merchant.id)?.delete(entry);
    this.byName.get(merchantKey(entry.merchant.name))?.delete(entry);
  }

  // The Merchant's Spending Transactions before this one, newest first.
  before(txn: CascadeInput): Entry[] {
    const merchant = txn.merchant;
    if (merchant === null) return [];
    const candidates = new Set([
      ...(merchant.id === null ? [] : (this.byMerchantId.get(merchant.id) ?? [])),
      ...(this.byName.get(merchantKey(merchant.name)) ?? []),
    ]);
    return [...candidates]
      .filter((entry) => sameMerchant(entry.merchant, merchant) && isBefore(entry, txn))
      .sort((a, b) => (isBefore(a, b) ? 1 : -1));
  }
}

// How many earlier Transactions step 4 compares.
const HISTORY_LENGTH = 3;

// Step 3: a provider category that maps cleanly to one Category, at VERY_HIGH or HIGH. A lossy code
// always goes on down the cascade. UNKNOWN counts as LOW, and a category with no confidence level
// is only a hint to the AI.
function providerCategory(txn: CascadeInput): Choice | undefined {
  if (txn.providerCategory === null) return undefined;
  const match = mapPlaidCategory(txn.providerCategory, txn.merchant);
  if (match?.kind !== "category" || match.lossy) return undefined;
  const level = plaidConfidence(txn.providerCategoryConfidence);
  if (level === "VERY_HIGH")
    return { category: match.category, source: "provider", confidence: "very high" };
  if (level === "HIGH") return { category: match.category, source: "provider", confidence: "high" };
  return undefined;
}

// Step 4: the Merchant's last 3 Spending Transactions before this one all have one Category. A
// Category from step 6 does not count. With fewer than 3, the step gives no answer. "waits" when
// one of the 3 still waits for the AI's answer, which decides the step. A masked Merchant, such as
// Privacy.com, gets no answer: its Transactions are many shops.
function merchantHistory(
  txn: CascadeInput,
  history: MerchantHistory,
): Choice | undefined | "waits" {
  if (txn.merchant !== null && isMaskedMerchant(txn.merchant)) return undefined;
  const last = history
    .before(txn)
    .filter((entry) => entry.source !== "best guess")
    .slice(0, HISTORY_LENGTH);
  const [first] = last;
  if (first === undefined || last.length < HISTORY_LENGTH) return undefined;
  if (last.some((entry) => entry.category === null)) return "waits";
  if (first.category === null || last.some((entry) => entry.category !== first.category)) {
    return undefined;
  }
  return { category: first.category, source: "Merchant history", confidence: "high" };
}

// Step 6, when no AI answers: the Category the provider's code maps to, even when lossy or low;
// with no provider category, the Merchant's most recent Category; with neither, Miscellaneous. A
// provider category with no confidence level is only a hint to the AI, so it counts as none here.
// A masked Merchant, such as Privacy.com, never takes its most recent Category: its Transactions are
// many shops.
export function bestGuess(txn: CascadeInput, history: MerchantHistory): Choice {
  const match =
    txn.providerCategory === null || txn.providerCategoryConfidence === null
      ? undefined
      : mapPlaidCategory(txn.providerCategory, txn.merchant);
  const masked = txn.merchant !== null && isMaskedMerchant(txn.merchant);
  const latest = masked ? undefined : history.before(txn).find((entry) => entry.category !== null);
  const category =
    match?.kind === "category" ? match.category : (latest?.category ?? "Miscellaneous");
  return { category, source: "best guess", confidence: "low" };
}

// Steps 3 and 4, which a Category that a Money movement rule names takes the place of, with steps 5
// and 6. No answer sends the Transaction on to the AI, or to the best guess. "waits" when step 4
// needs the AI's answer for an earlier Transaction first.
export function fromProviderOrHistory(
  txn: CascadeInput,
  history: MerchantHistory,
): Choice | undefined | "waits" {
  return providerCategory(txn) ?? merchantHistory(txn, history);
}

// How the Category was chosen, as the Transactions page shows it (spec 07, Transactions page).
// Below high, the AI counts as unsure.
export function provenance(choice: Pick<Choice, "source" | "confidence">): string {
  switch (choice.source) {
    case "provider":
      return "Plaid";
    case "AI":
      return choice.confidence === "high" ? "AI" : "AI, unsure";
    case "Web lookup":
      return choice.confidence === "high" ? "Web lookup" : "Web lookup, unsure";
    case "money movement":
      return "Money movement";
    default:
      return choice.source;
  }
}

// The parts the cascade covers: Spending, and a Refund with no link, which goes through the cascade
// as if it were Spending. A linked Refund takes its Spending's Category from the link, and so does
// a Reimbursement, so the cascade leaves them alone.
export function coveredByCascade(part: CategoryRecord["parts"][number]): boolean {
  if (part.type === "Spending") return true;
  return part.type === "Refund" && !part.linked;
}

// The Transaction's Merchant: the provider's Merchant ID with its clean name. A Transaction with
// no clean name has none, such as a paper check.
export function merchantOf(record: {
  merchantId: string | null;
  merchantCleanName: string | null;
}): Merchant | null {
  return record.merchantCleanName === null
    ? null
    : { id: record.merchantId, name: record.merchantCleanName };
}
