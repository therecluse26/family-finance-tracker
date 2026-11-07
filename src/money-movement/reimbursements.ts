import {
  type Database,
  listHandSetTypes,
  listLoanLinksOf,
  listRefusedOtherLinks,
  listReimbursableSpending,
  listSpendingLinksOf,
  listTransferLinksOf,
  type Queries,
  type ReimbursableSpending,
  readCardFacts,
  readDecisionRecords,
  setHandSetType,
  storeOtherLink,
} from "../db/index.ts";
import { askForFollowUp, followUpAgain } from "../follow-up/index.ts";
import { dateLabel, dollarsAndCents } from "../format.ts";
import { log } from "../log.ts";
import { paymentAppLine, plainForms } from "../merchants/index.ts";
import {
  type CardMember,
  cardsByKey,
  NotAChoice,
  openReviewItemsOfKind,
  type ReviewChoice,
  type ReviewItem,
  type ReviewKind,
  regroupCards,
  regroupReviewItems,
} from "../review/index.ts";
import type { AiRun } from "./ai-run.ts";
import { addDays } from "./business-days.ts";
import { purchaseDate } from "./totals.ts";

// Money from a person with no link (spec 03, Reimbursements, Review list items). Only the AI or a
// Member links a Reimbursement. With no link, the money is Income at step 6.5, and it goes on the
// Review list. A Member links it to Spending there, which makes it a Reimbursement, or keeps it as
// Income. A hand link from the Transactions page settles the item too.

export const MONEY_FROM_PERSON_KIND = "money from a person";

// The step of the order of decisions that books money from a person as Income.
const MONEY_FROM_PERSON_STEP = "6.5";

// A Reimbursement pays back Spending from at most this many days before the money arrived.
export const REIMBURSEMENT_WINDOW_DAYS = 60;

// The money from a person that the AI picks for, with the Spending it may pay back: shown money out
// with a Spending part, bought in the 60 days up to the day the money posted, newest first.
export type MoneyToPick = {
  money: {
    id: string;
    accountId: string;
    postedDate: string;
    amount: number;
    description: string;
  };
  spending: readonly ReimbursableSpending[];
};

// The AI's pick for money from a person (spec 03, Reimbursements): the Spending it named, or null
// when it named none, with its confidence. `justAsked` is true when the AI answered in this run,
// and false for an answer stored from an earlier one.
export type ReimbursementPick = {
  spendingTransactionId: string | null;
  confidence: "high" | "medium" | "low";
  justAsked: boolean;
};

// The AI's picks, by the money's ID. Money with no entry has no answer, so its item takes the
// no-AI path and is marked for an AI redo. src/money-movement/ai-links.ts registers it, and keeps
// its answers so the app never asks about the same money twice. In a Matching run, it asks the AI
// in batches about money it has no answer for, and records in the run a use that stops or a retry
// that waits. Without a run, it gives stored answers only and asks nothing.
export type ReimbursementPicker = (
  money: readonly MoneyToPick[],
  run: AiRun | undefined,
) => Promise<ReadonlyMap<string, ReimbursementPick>>;

let picker: ReimbursementPicker | undefined;

// Registers the AI's pick. Returns a function that removes it again.
export function registerReimbursementPicker(registered: ReimbursementPicker): () => void {
  if (picker !== undefined) throw new Error("A Reimbursement picker is already registered.");
  picker = registered;
  return () => {
    if (picker === registered) picker = undefined;
  };
}

const DECIDED = "Money from a person with no link counts as Income.";
const KEEP: ReviewChoice = { value: "keep", label: "Keep as Income" };
const LINK = "link ";

// A card of more than one Transaction (spec 03, Review list items): its answer keeps each as
// Income. A link is about one Transaction, so a Member links one from its own page.
const KEEP_ALL: ReviewChoice = { value: KEEP.value, label: "Keep all as Income" };
const decidedFor = (count: number) =>
  count > 1 ? `${count} payments from this person have no link, so they count as Income.` : DECIDED;

// A card's key: the payment app with the person the line names, as a letter-only, case-folded
// skeleton, so "JOHN SMITH" and "John  Smith" are one card (K13). Null for a line that names no
// person, such as VENMO CASHOUT or a check deposit, which keeps an item of its own. The key stays in
// the app and never goes to the AI.
export function personKeyOf(txn: {
  description: string;
  merchantName: string | null;
  providerCategory: string | null;
}): string | null {
  // Plain forms with no marks first, so a full-width or accented spelling reads as its letters.
  const plain = (text: string) =>
    plainForms(text)
      .normalize("NFKD")
      .replace(/\p{M}/gu, "");
  const line = paymentAppLine({
    ...txn,
    description: plain(txn.description),
    merchantName: txn.merchantName === null ? null : plain(txn.merchantName),
  });
  if (line === undefined || typeof line.party !== "object") return null;
  const skeleton = line.party.person
    .normalize("NFKD")
    .replace(/[^\p{L}]/gu, "")
    .toLowerCase();
  return skeleton === "" ? null : `${line.app ?? ""} ${skeleton}`;
}

const spendingLabel = (spending: ReimbursableSpending, moneyDate: string) =>
  `${spending.merchantCleanName ?? spending.description}, ${dollarsAndCents(-spending.amount)}, ${dateLabel(purchaseDate(spending), moneyDate)}`;

const linkChoice = (spending: ReimbursableSpending, moneyDate: string): ReviewChoice => ({
  value: `${LINK}${spending.id}`,
  label: spendingLabel(spending, moneyDate),
});

const moneyOf = (item: ReviewItem): string => {
  const [moneyId] = item.subject.type === "transactions" ? item.subject.transactionIds : [];
  if (moneyId === undefined) throw new Error("A money from a person item is about money in.");
  return moneyId;
};

// The days of Spending that money posted on `postedDate` may pay back.
const windowOf = (postedDate: string) => ({
  from: addDays(postedDate, -REIMBURSEMENT_WINDOW_DAYS),
  to: postedDate,
});

// The Spending the money may pay back: shown money out with a Spending part, bought in the 60 days
// up to the day the money posted. Newest first.
async function spendingFor(
  database: Database,
  moneyId: string,
): Promise<{ postedDate: string; spending: ReimbursableSpending[] } | undefined> {
  const [money] = await readDecisionRecords(database, [moneyId]);
  if (money === undefined || money.hidden || money.amount <= 0) return undefined;
  const { from, to } = windowOf(money.postedDate);
  const spending = await listReimbursableSpending(database, from, to);
  return { postedDate: money.postedDate, spending };
}

// The first place in `spending`, newest first, where `test` holds; it holds from there on.
function firstWhere(
  spending: readonly ReimbursableSpending[],
  test: (each: ReimbursableSpending) => boolean,
): number {
  let low = 0;
  let high = spending.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const each = spending[middle];
    if (each !== undefined && test(each)) high = middle;
    else low = middle + 1;
  }
  return low;
}

// The money among these that still shows, each with the Spending it may pay back. Reads the
// Spending of every window at once, and keeps for each money what listReimbursableSpending would
// give for its own window, found by purchase date in the list, newest first, with no pass over the
// whole list (K3).
async function moneyToPick(
  database: Database,
  moneyIds: readonly string[],
): Promise<MoneyToPick[]> {
  const money = (await readDecisionRecords(database, moneyIds)).filter(
    (record) => !record.hidden && record.amount > 0,
  );
  if (money.length === 0) return [];
  const dates = money.map((record) => record.postedDate).sort();
  const all = await listReimbursableSpending(
    database,
    windowOf(dates[0] ?? "").from,
    dates.at(-1) ?? "",
  );
  return money.map((record) => {
    const { from, to } = windowOf(record.postedDate);
    const bought = all.slice(
      firstWhere(all, (each) => purchaseDate(each) <= to),
      firstWhere(all, (each) => purchaseDate(each) < from),
    );
    return {
      money: {
        id: record.id,
        accountId: record.accountId,
        postedDate: record.postedDate,
        amount: record.amount,
        description: record.description,
      },
      spending: bought.filter((each) => each.postedDate >= from),
    };
  });
}

// The AI's picks for this money. A picker that throws leaves each item to the no-AI path.
async function picksFor(
  money: readonly MoneyToPick[],
  run: AiRun | undefined,
): Promise<ReadonlyMap<string, ReimbursementPick>> {
  if (picker === undefined || money.length === 0) return new Map();
  try {
    return await picker(money, run);
  } catch (error) {
    log.warn("The Reimbursement picker failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return new Map();
  }
}

// The Spending the AI picked for this money, while it may still be linked: in the money's window,
// and with no one having refused that link.
function pickedOf(
  found: MoneyToPick,
  pick: ReimbursementPick | undefined,
  refused: ReadonlySet<string>,
): ReimbursableSpending | undefined {
  if (pick === undefined || refused.has(`${found.money.id} ${pick.spendingTransactionId}`)) {
    return undefined;
  }
  return found.spending.find((each) => each.id === pick.spendingTransactionId);
}

// The best answer: the AI's pick when it made one that may still be linked, else "Keep as Income".
function bestAnswerOf(
  found: MoneyToPick | undefined,
  pick: ReimbursementPick | undefined,
  refused: ReadonlySet<string>,
): { bestAnswer: ReviewChoice; needsAi: boolean } {
  if (pick === undefined) return { bestAnswer: KEEP, needsAi: true };
  const picked = found === undefined ? undefined : pickedOf(found, pick, refused);
  if (found === undefined || picked === undefined) return { bestAnswer: KEEP, needsAi: false };
  return {
    bestAnswer: {
      value: `${LINK}${picked.id}`,
      label: `Yes, it pays back ${spendingLabel(picked, found.money.postedDate)}`,
    },
    needsAi: false,
  };
}

// Links each pick the AI just made with high confidence, as the AI's Reimbursement (spec 03,
// Reimbursements), in one transaction. A pick never ends another link: it links only when neither
// side is in a Transfer pair or a loan link, the money has no Refund or Reimbursement link, and no
// one refused the link. Returns the money it linked, and the Transactions to decide again.
async function linkHighPicks(
  database: Database,
  found: readonly MoneyToPick[],
  picks: ReadonlyMap<string, ReimbursementPick>,
  refused: ReadonlySet<string>,
  now: Date,
): Promise<{ linked: Set<string>; again: string[] }> {
  const wanted = found.flatMap((each) => {
    const pick = picks.get(each.money.id);
    if (pick?.justAsked !== true || pick.confidence !== "high") return [];
    const picked = pickedOf(each, pick, refused);
    return picked === undefined ? [] : [{ money: each.money.id, spending: picked.id }];
  });
  const linked = new Set<string>();
  const again: string[] = [];
  if (wanted.length === 0) return { linked, again };
  const moneyIds = wanted.map((each) => each.money);
  await database.transaction(async (tx) => {
    const ids = wanted.flatMap((each) => [each.money, each.spending]);
    // A Member's decision always wins: money a Member kept as Income, such as during the pick
    // call, stays Income.
    const busy = new Set([
      ...(await listHandSetTypes(tx, moneyIds)),
      ...(await listTransferLinksOf(tx, ids)).flatMap((link) => [
        link.outTransactionId,
        link.inTransactionId,
      ]),
      ...(await listLoanLinksOf(tx, ids)).map((link) => link.transactionId),
      ...(await listSpendingLinksOf(tx, moneyIds)).map((link) => link.transactionId),
    ]);
    for (const { money, spending } of wanted) {
      if (busy.has(money) || busy.has(spending)) continue;
      const made = await storeOtherLink(
        tx,
        { kind: "Reimbursement", transactionId: money, spendingTransactionId: spending },
        {
          tier: "Unclear",
          signals: [],
          aiAnswer: "yes",
          aiConfidence: "high",
          madeBy: "AI",
          memberId: null,
          createdAt: now,
        },
      );
      linked.add(money);
      again.push(money, spending, ...made.ended);
    }
  });
  if (linked.size > 0) log.info("The AI linked Reimbursements", { linked: linked.size });
  return { linked, again };
}

// Whether the order booked money from a person as Income: step 6.5, with no Reimbursement part.
const bookedAsIncome = (result: { step: string; parts: readonly { type: string }[] }) =>
  result.step === MONEY_FROM_PERSON_STEP &&
  !result.parts.some((part) => part.type === "Reimbursement");

// Keeps the money from a person cards in step (spec 03, Review list items): each result booked as
// money from a person joins its person's card, and leaves it once it is decided another way or no
// longer shows. `gone` are Transactions that no longer show. A card with none left closes. The open
// items, the facts of their Transactions, and the Spending the money may pay back are read once,
// and the cards are written in one transaction (K3). In a Matching run, the AI may pick for the new
// money first: money it links with high confidence joins no card. Money on an open card that a no-AI
// path decided goes to the AI the same way, once (spec 03, AI decisions and the no-AI path): a link
// takes it off its card, and any other answer becomes its best answer. Returns the Transactions to
// decide again: each side of a link it made, and each Transaction whose other links ended with it.
export async function updateMoneyFromPersonItems(
  database: Database,
  decided: readonly { transactionId: string; step: string; parts: readonly { type: string }[] }[],
  gone: readonly string[],
  run?: AiRun,
  now = new Date(),
): Promise<string[]> {
  if (decided.length === 0 && gone.length === 0) return [];
  const openItems = await openReviewItemsOfKind(database, MONEY_FROM_PERSON_KIND);
  // Each money's open card. Money on two, which only a race leaves, belongs to the newest.
  const cardOf = new Map<string, ReviewItem>();
  for (const item of openItems) {
    if (item.subject.type !== "transactions") continue;
    for (const id of item.subject.transactionIds) if (!cardOf.has(id)) cardOf.set(id, item);
  }
  // The money on open cards a no-AI path decided: only a Matching run asks the AI.
  const redo = new Set(
    run === undefined ? [] : [...cardOf].filter(([, item]) => item.needsAi).map(([id]) => id),
  );
  const leaving = new Set(gone);
  const asking = new Set<string>();
  for (const result of decided) {
    const { transactionId } = result;
    if (!bookedAsIncome(result)) leaving.add(transactionId);
    else if (!cardOf.has(transactionId) || redo.has(transactionId)) asking.add(transactionId);
  }
  if (openItems.length === 0 && asking.size === 0) return [];
  const asked = [...asking];
  const found = await moneyToPick(database, asked);
  const picks = await picksFor(found, run);
  const refused = await listRefusedOtherLinks(database, "Reimbursement", [...picks.keys()]);
  const { linked, again } =
    run === undefined
      ? { linked: new Set<string>(), again: [] }
      : await linkHighPicks(database, found, picks, refused, now);
  const foundOf = new Map(found.map((each) => [each.money.id, each]));
  // Each money's own best answer and no-AI mark: this run's, or its card's when it is a card of
  // one. On a card of more, it has none of its own, so Keep as Income.
  const faces = new Map<string, { bestAnswer: ReviewChoice; needsAi: boolean }>();
  for (const [id, item] of cardOf) {
    if (leaving.has(id) || linked.has(id)) continue;
    const alone = item.subject.type === "transactions" && item.subject.transactionIds.length === 1;
    faces.set(id, { bestAnswer: alone ? item.bestAnswer : KEEP, needsAi: item.needsAi });
  }
  for (const moneyId of asked) {
    if (linked.has(moneyId) || leaving.has(moneyId)) continue;
    const answer = bestAnswerOf(foundOf.get(moneyId), picks.get(moneyId), refused);
    // Money a no-AI path decided keeps its mark until the AI answers it.
    const before = faces.get(moneyId);
    faces.set(moneyId, answer.needsAi && before !== undefined ? before : answer);
  }
  const members: CardMember[] = (await readCardFacts(database, [...faces.keys()]))
    .filter((facts) => !facts.hidden)
    .map((facts) => ({ id: facts.id, postedDate: facts.postedDate, key: personKeyOf(facts) }));
  const { grouped, ...regroup } = regroupCards(
    MONEY_FROM_PERSON_KIND,
    openItems,
    cardsByKey(members),
    (card) => {
      const [only] = card;
      const face = only === undefined ? undefined : faces.get(only.id);
      if (card.length === 1 && face !== undefined) return { decided: DECIDED, ...face };
      return {
        decided: decidedFor(card.length),
        bestAnswer: KEEP_ALL,
        needsAi: card.some((member) => faces.get(member.id)?.needsAi === true),
      };
    },
    "linked, or decided again",
  );
  await regroupReviewItems(database, regroup);
  if (regroup.open.length > 0) {
    log.info("Money from a person went on the Review list", { opened: regroup.open.length });
  }
  if (grouped > 0) log.info("Money from a person items were grouped", { closed: grouped });
  return again;
}

// A Member links the money to Spending, which makes it a Reimbursement, or keeps it as Income,
// which sets its type to Income by hand. On a card of more than one, Keep all as Income keeps each
// still on the card. The choices are read when the Member opens them, so they hold only Spending
// that may still be linked; a card of more offers none, since a link is about one Transaction. The
// follow-up job then decides the money, and the Spending's other Reimbursements and Refunds, again.
export function moneyFromPersonKind(database: Database): ReviewKind {
  // Every Spending the money may still be linked to.
  const linksFor = async (item: ReviewItem): Promise<ReviewChoice[]> => {
    const found = await spendingFor(database, moneyOf(item));
    return (found?.spending ?? []).map((each) => linkChoice(each, found?.postedDate ?? ""));
  };
  const alone = (item: ReviewItem) =>
    item.subject.type === "transactions" && item.subject.transactionIds.length === 1;
  return {
    // Keep as Income and the links, without the best answer, which shows on its own.
    otherChoices: async (item) =>
      alone(item)
        ? [KEEP, ...(await linksFor(item))].filter((each) => each.value !== item.bestAnswer.value)
        : [],
    async answer(item, choice, answering: { memberId: string; database: Queries }) {
      const tx = answering.database;
      if (choice.value === KEEP.value) {
        // Only the money still on the card, read inside the answer's transaction: still shown,
        // still booked as money from a person with no link and no type set by hand, and still from
        // the person most of the card's money is from.
        const ids = item.subject.type === "transactions" ? item.subject.transactionIds : [];
        const byKey = new Map<string, string[]>();
        for (const facts of await readCardFacts(tx, ids)) {
          if (
            facts.hidden ||
            facts.amount <= 0 ||
            facts.step !== MONEY_FROM_PERSON_STEP ||
            facts.reducesSpending ||
            facts.handSet.type !== undefined
          ) {
            continue;
          }
          const key = personKeyOf(facts) ?? `none ${facts.id}`;
          byKey.set(key, [...(byKey.get(key) ?? []), facts.id]);
        }
        const [onCard = []] = [...byKey.values()].sort((a, b) => b.length - a.length);
        if (onCard.length === 0) {
          log.info("A money from a person card's answer found none of its money still on it");
          return;
        }
        await setHandSetType(tx, onCard, "Income");
        await followUpAgain(tx, onCard);
        return;
      }
      if (!alone(item)) throw new NotAChoice("A link is about one Transaction.");
      const moneyId = moneyOf(item);
      // The best answer is the AI's pick from when the item opened: it links only while the
      // Spending may still be linked, so not once it is hidden, removed, or out of the window.
      const spendingTransactionId = choice.value.slice(LINK.length);
      if (!(await linksFor(item)).some((each) => each.value === choice.value)) {
        throw new NotAChoice("This Spending can no longer be linked to the money from a person.");
      }
      const made = await storeOtherLink(
        tx,
        { kind: "Reimbursement", transactionId: moneyId, spendingTransactionId },
        {
          tier: "Unclear",
          signals: [],
          aiAnswer: null,
          aiConfidence: null,
          madeBy: "Member",
          memberId: answering.memberId,
          createdAt: new Date(),
        },
      );
      await followUpAgain(tx, [moneyId, spendingTransactionId, ...made.ended]);
    },
    afterAnswer: () => askForFollowUp(),
  };
}
