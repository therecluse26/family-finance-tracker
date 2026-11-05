import {
  type Database,
  listLoanLinksOf,
  listRefusedOtherLinks,
  listReimbursableSpending,
  listSpendingLinksOf,
  listTransferLinksOf,
  type Queries,
  type ReimbursableSpending,
  readDecisionRecords,
  setHandSetFields,
  storeOtherLink,
} from "../db/index.ts";
import { askForFollowUp, followUpAgain } from "../follow-up/index.ts";
import { dateLabel, dollarsAndCents } from "../format.ts";
import { log } from "../log.ts";
import {
  NotAChoice,
  openReviewItemBatch,
  openReviewItemsOfKind,
  type ReviewChoice,
  type ReviewItem,
  type ReviewKind,
  settleReviewItems,
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
    const busy = new Set([
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

// Opens an item for each result booked as money from a person that has none open, and settles each
// open item whose Transaction is now decided another way or no longer shows. `gone` are
// Transactions that no longer show. The open items and the Spending the money may pay back are
// read once, and items are opened and settled in one batch each. In a Matching run, the AI may pick
// for the new money first: money it links with high confidence opens no item. Returns the
// Transactions to decide again: each side of a link it made, and each Transaction whose other
// links ended with it.
export async function updateMoneyFromPersonItems(
  database: Database,
  decided: readonly { transactionId: string; step: string; parts: readonly { type: string }[] }[],
  gone: readonly string[],
  run?: AiRun,
  now = new Date(),
): Promise<string[]> {
  if (decided.length === 0 && gone.length === 0) return [];
  const open = new Set(
    (await openReviewItemsOfKind(database, MONEY_FROM_PERSON_KIND)).map(moneyOf),
  );
  const settled = gone.filter((id) => open.has(id));
  const asked: string[] = [];
  for (const result of decided) {
    const { transactionId } = result;
    if (!bookedAsIncome(result)) {
      if (open.has(transactionId)) settled.push(transactionId);
    } else if (!open.has(transactionId)) {
      open.add(transactionId);
      asked.push(transactionId);
    }
  }
  await settleReviewItems(
    database,
    { kind: MONEY_FROM_PERSON_KIND, subjectIds: settled },
    "linked, or decided again",
  );
  if (asked.length === 0) return [];
  const found = await moneyToPick(database, asked);
  const picks = await picksFor(found, run);
  const refused = await listRefusedOtherLinks(database, "Reimbursement", [...picks.keys()]);
  const { linked, again } =
    run === undefined
      ? { linked: new Set<string>(), again: [] }
      : await linkHighPicks(database, found, picks, refused, now);
  const foundOf = new Map(found.map((each) => [each.money.id, each]));
  const items = asked
    .filter((moneyId) => !linked.has(moneyId))
    .map((moneyId) => ({
      kind: MONEY_FROM_PERSON_KIND,
      subject: { type: "transactions" as const, transactionIds: [moneyId] },
      decided: DECIDED,
      ...bestAnswerOf(foundOf.get(moneyId), picks.get(moneyId), refused),
    }));
  await openReviewItemBatch(database, items);
  if (items.length > 0) {
    log.info("Money from a person went on the Review list", { opened: items.length });
  }
  return again;
}

// A Member links the money to Spending, which makes it a Reimbursement, or keeps it as Income,
// which sets its type to Income by hand. The choices are read when the Member opens them, so they
// hold only Spending that may still be linked. The follow-up job then decides the money, and the
// Spending's other Reimbursements and Refunds, again.
export function moneyFromPersonKind(database: Database): ReviewKind {
  // Every Spending the money may still be linked to.
  const linksFor = async (item: ReviewItem): Promise<ReviewChoice[]> => {
    const found = await spendingFor(database, moneyOf(item));
    return (found?.spending ?? []).map((each) => linkChoice(each, found?.postedDate ?? ""));
  };
  return {
    // Keep as Income and the links, without the best answer, which shows on its own.
    otherChoices: async (item) =>
      [KEEP, ...(await linksFor(item))].filter((each) => each.value !== item.bestAnswer.value),
    async answer(item, choice, answering: { memberId: string; database: Queries }) {
      const moneyId = moneyOf(item);
      if (choice.value === KEEP.value) {
        await setHandSetFields(answering.database, moneyId, { type: "Income" });
        await followUpAgain(answering.database, [moneyId]);
        return;
      }
      // The best answer is the AI's pick from when the item opened: it links only while the
      // Spending may still be linked, so not once it is hidden, removed, or out of the window.
      const spendingTransactionId = choice.value.slice(LINK.length);
      if (!(await linksFor(item)).some((each) => each.value === choice.value)) {
        throw new NotAChoice("This Spending can no longer be linked to the money from a person.");
      }
      const made = await storeOtherLink(
        answering.database,
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
      await followUpAgain(answering.database, [moneyId, spendingTransactionId, ...made.ended]);
    },
    afterAnswer: () => askForFollowUp(),
  };
}
