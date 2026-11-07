import { type Category, isCategory } from "../categories/index.ts";
import { type CategoryRecord, type Database, readCategoryRecords } from "../db/index.ts";
import { log } from "../log.ts";
import { isPaymentApp, type Merchant, merchantKey } from "../merchants/index.ts";
import { openReviewItemsOfKind, type ReviewItem, regroupReviewItems } from "../review/index.ts";
import { coveredByCascade, merchantOf } from "./cascade.ts";

// The Category cards on the Review list (spec 04, Review list items). Each Category kind has one
// open item per Merchant, a card that holds every Transaction of that kind of the Merchant. A
// Transaction with no Merchant that may have a rule keeps an item of its own.
//
// The cards follow the stored Categories: each update reads the open cards of both kinds and their
// Transactions once, with the Transactions a run just decided, and works out which card each
// Transaction belongs on. A Transaction joins its Merchant's card, leaves it when its Category is
// no longer of that kind, and a card with none left closes. Items from before cards, one per
// Transaction, group into one card per Merchant the first time, with no marker: once grouped, a
// second update finds nothing to change.

// The Review list kinds: a best guess made without AI, and a Category the AI or a Web lookup chose
// with low confidence. A medium answer counts as decided.
export const BEST_GUESS_KIND = "best guess made without AI";
export const AI_UNSURE_KIND = "Category the AI was unsure of";

// Why an item closes with no answer.
export const GROUPED = "grouped by Merchant";
export const CHOSEN_AGAIN = "its Category was chosen again";
export const MEDIUM_DECIDED = "a medium answer counts as decided";

type CardKind = {
  kind: string;
  // The Category that puts the Transaction on a card of this kind, or null.
  of(record: CategoryRecord): Category | null;
  decided(category: Category, count: { of: number; total: number }): string;
  logged: string;
};

// The parts whose Category may put the Transaction on a card. A Category or split a Member set by
// hand wins at step 1 even before the follow-up job stores it on the parts, so the Transaction
// leaves its card at once, and so does one a Member made Money movement by hand.
const coveredParts = (record: CategoryRecord) =>
  record.hidden ||
  record.handSet.category !== undefined ||
  record.handSet.split !== undefined ||
  movedByHand(record)
    ? []
    : record.parts.filter(coveredByCascade);

// A type set by hand that has no Category of the cascade's, such as a Transfer.
const movedByHand = ({ handSet }: CategoryRecord) =>
  handSet.type !== undefined && handSet.type !== "Spending" && handSet.type !== "Refund";

const chosenBy = (part: CategoryRecord["parts"][number]) =>
  part.categorySource === "AI" || part.categorySource === "Web lookup";

// "for 9 of 14", when the card's Transactions differ.
const share = ({ of, total }: { of: number; total: number }) =>
  of === total ? "" : ` for ${of} of ${total}`;

const KINDS: readonly CardKind[] = [
  {
    kind: BEST_GUESS_KIND,
    of(record) {
      const part = coveredParts(record).find((each) => each.categorySource === "best guess");
      return part?.category != null && isCategory(part.category) ? part.category : null;
    },
    decided: (category, count) =>
      `No AI was available, so the app guessed ${category}${share(count)}.`,
    logged: "Best guesses made without AI went on the Review list",
  },
  {
    kind: AI_UNSURE_KIND,
    // A Web lookup's answer counts as the AI's.
    of(record) {
      const part = coveredParts(record).find(
        (each) => chosenBy(each) && each.categoryConfidence === "low",
      );
      return part?.category != null && isCategory(part.category) ? part.category : null;
    },
    decided: (category, count) => `The AI chose ${category}${share(count)}, but it was unsure.`,
    logged: "Categories the AI was unsure of went on the Review list",
  },
];

// Whether the AI's answer for the Transaction is medium, so its item closes as decided.
const mediumAnswer = (record: CategoryRecord | undefined) =>
  record !== undefined &&
  coveredParts(record).some((part) => chosenBy(part) && part.categoryConfidence === "medium");

// The Merchant whose card a Transaction joins, or null when it keeps an item of its own: no clean
// name, or a payment app that names no one, which may have no Category rule (as makesRule says).
function cardMerchant(record: CategoryRecord): Merchant | null {
  const merchant = merchantOf(record);
  if (merchant === null || merchantKey(merchant.name) === "" || isPaymentApp(merchant)) return null;
  return merchant;
}

type Member = { record: CategoryRecord; category: Category };

// Groups the Transactions by Merchant identity (spec 04, Identity): by clean name, and by the
// provider's Merchant ID when one name has several. A Transaction with no Merchant ID joins the
// largest group of its name. A Transaction with no card Merchant is a group of its own.
export function groupByMerchant(members: readonly Member[]): Member[][] {
  const groups: Member[][] = [];
  const byName = new Map<string, Member[]>();
  for (const member of members) {
    const merchant = cardMerchant(member.record);
    if (merchant === null) {
      groups.push([member]);
      continue;
    }
    const key = merchantKey(merchant.name);
    const named = byName.get(key);
    if (named === undefined) byName.set(key, [member]);
    else named.push(member);
  }
  for (const named of byName.values()) {
    const byId = new Map<string, Member[]>();
    const noId: Member[] = [];
    for (const member of named) {
      const id = member.record.merchantId;
      if (id === null) noId.push(member);
      else byId.set(id, [...(byId.get(id) ?? []), member]);
    }
    const withId = [...byId.values()].sort((a, b) => b.length - a.length);
    const [largest] = withId;
    if (largest === undefined) groups.push(noId);
    else {
      largest.push(...noId);
      groups.push(...withId);
    }
  }
  return groups;
}

// Newest first, by posted date, then by ID, as the Review list shows a card's Transactions.
const newestFirst = (a: Member, b: Member) =>
  b.record.postedDate.localeCompare(a.record.postedDate) || a.record.id.localeCompare(b.record.id);

// The Category chosen most often on the card. A tie goes to the newest Transaction's Category.
export function mostChosen(members: readonly Member[]): { category: Category; of: number } {
  const counts = new Map<Category, number>();
  for (const { category } of members) counts.set(category, (counts.get(category) ?? 0) + 1);
  let best: { category: Category; of: number } | undefined;
  for (const { category } of members) {
    const of = counts.get(category) ?? 0;
    if (best === undefined || of > best.of) best = { category, of };
  }
  if (best === undefined) throw new Error("A Category card needs a Transaction.");
  return best;
}

// The card's Transactions an answer writes, read inside the answer's transaction: those still of
// the card's kind, so not hidden, not set by hand and not Money movement, and still with the card's
// Merchant, the one most of them share. The card's list is only as fresh as its last update.
export function stillOnCard(kind: string, records: readonly CategoryRecord[]): CategoryRecord[] {
  const card = KINDS.find((each) => each.kind === kind);
  if (card === undefined) return [];
  const members: Member[] = [];
  for (const record of records) {
    const category = card.of(record);
    if (category !== null) members.push({ record, category });
  }
  const [largest] = groupByMerchant(members).sort((a, b) => b.length - a.length);
  return (largest ?? []).map(({ record }) => record);
}

const transactionIdsOf = (item: ReviewItem) =>
  item.subject.type === "transactions" ? item.subject.transactionIds : [];

type Wanted = Parameters<typeof regroupReviewItems>[1];
type Regroup = {
  close: Wanted["close"][number][];
  revise: Wanted["revise"][number][];
  open: Wanted["open"][number][];
};

// What one kind's cards need: the closings, the revised cards, and the new ones.
function regroupKind(
  card: CardKind,
  open: readonly ReviewItem[],
  decided: readonly string[],
  records: ReadonlyMap<string, CategoryRecord>,
): Regroup & { grouped: number } {
  // Each Transaction's open card. A Transaction on two cards, which only a race leaves, belongs to
  // the newest; the other card lets it go.
  const cardOf = new Map<string, ReviewItem>();
  for (const item of open) {
    for (const id of transactionIdsOf(item)) if (!cardOf.has(id)) cardOf.set(id, item);
  }
  const seen = new Set<string>();
  const members: Member[] = [];
  for (const id of [...decided, ...cardOf.keys()]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const record = records.get(id);
    const category = record === undefined ? null : card.of(record);
    if (record !== undefined && category !== null) members.push({ record, category });
  }
  const groups = groupByMerchant(members).sort((a, b) => b.length - a.length);
  const kept = new Set<string>();
  const onCard = new Set<string>();
  const regroup: Regroup & { grouped: number } = { close: [], revise: [], open: [], grouped: 0 };
  for (const group of groups) {
    group.sort(newestFirst);
    const transactionIds = group.map(({ record }) => record.id);
    for (const id of transactionIds) onCard.add(id);
    const best = mostChosen(group);
    const decidedText = card.decided(best.category, { of: best.of, total: group.length });
    const bestAnswer = { value: best.category, label: `Yes, ${best.category}` };
    // The group keeps the open card that holds the most of its Transactions.
    const holds = new Map<ReviewItem, number>();
    for (const id of transactionIds) {
      const item = cardOf.get(id);
      if (item !== undefined && !kept.has(item.id)) holds.set(item, (holds.get(item) ?? 0) + 1);
    }
    let keeper: ReviewItem | undefined;
    for (const [item, count] of holds) {
      if (keeper === undefined || count > (holds.get(keeper) ?? 0)) keeper = item;
    }
    const subject = { type: "transactions" as const, transactionIds };
    if (keeper === undefined) {
      regroup.open.push({ kind: card.kind, subject, decided: decidedText, bestAnswer });
      continue;
    }
    kept.add(keeper.id);
    if (
      transactionIdsOf(keeper).join() !== transactionIds.join() ||
      keeper.decided !== decidedText ||
      keeper.bestAnswer.value !== bestAnswer.value ||
      keeper.bestAnswer.label !== bestAnswer.label
    ) {
      regroup.revise.push({ id: keeper.id, subject, decided: decidedText, bestAnswer });
    }
  }
  for (const item of open) {
    if (kept.has(item.id)) continue;
    const ids = transactionIdsOf(item);
    const reason = ids.some((id) => onCard.has(id))
      ? GROUPED
      : card.kind === AI_UNSURE_KIND && ids.every((id) => mediumAnswer(records.get(id)))
        ? MEDIUM_DECIDED
        : CHOSEN_AGAIN;
    if (reason === GROUPED) regroup.grouped += 1;
    regroup.close.push({ id: item.id, reason });
  }
  return regroup;
}

// One update at a time, so two never open a card for the same Merchant side by side. The app is
// one Node process (ADR 0002).
let queue: Promise<unknown> = Promise.resolve();

// Keeps the Category cards in step with the stored Categories, after a run decided these
// Transactions, or after a Member set one by hand. Reads each kind's open cards once, the
// Transactions of all of them in one batch, and writes each kind in one transaction.
export function updateCategoryCards(database: Database, decided: readonly string[]): Promise<void> {
  const run = queue.then(async () => {
    const open = new Map<string, ReviewItem[]>();
    for (const { kind } of KINDS) open.set(kind, await openReviewItemsOfKind(database, kind));
    const ids = new Set(decided);
    for (const items of open.values()) {
      for (const item of items) for (const id of transactionIdsOf(item)) ids.add(id);
    }
    const records = new Map(
      (await readCategoryRecords(database, [...ids])).map((record) => [record.id, record]),
    );
    for (const card of KINDS) {
      const { grouped, ...regroup } = regroupKind(
        card,
        open.get(card.kind) ?? [],
        decided,
        records,
      );
      await regroupReviewItems(database, regroup);
      if (regroup.open.length > 0) log.info(card.logged, { opened: regroup.open.length });
      if (grouped > 0) log.info("Category items were grouped by Merchant", { closed: grouped });
    }
  });
  queue = run.catch(() => {});
  return run;
}
