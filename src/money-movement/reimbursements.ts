import {
  type Database,
  listReimbursableSpending,
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

// The AI's pick for money from a person that it did not link: the Spending it named with less than
// high confidence, or null when it named none. Undefined when no AI answered, so the item takes the
// no-AI path and is marked for an AI redo. T81 registers it, and links a pick with high confidence
// itself.
export type ReimbursementPicker = (money: {
  transactionId: string;
}) => Promise<{ spendingTransactionId: string } | null | undefined>;

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

// The Spending the money may pay back: shown money out with a Spending part, bought in the 60 days
// up to the day the money posted. Newest first.
async function spendingFor(
  database: Database,
  moneyId: string,
): Promise<{ postedDate: string; spending: ReimbursableSpending[] } | undefined> {
  const [money] = await readDecisionRecords(database, [moneyId]);
  if (money === undefined || money.hidden || money.amount <= 0) return undefined;
  const spending = await listReimbursableSpending(
    database,
    addDays(money.postedDate, -REIMBURSEMENT_WINDOW_DAYS),
    money.postedDate,
  );
  return { postedDate: money.postedDate, spending };
}

// The best answer: the AI's pick when it made one that may still be linked, else "Keep as Income".
async function bestAnswerFor(
  database: Database,
  moneyId: string,
): Promise<{ bestAnswer: ReviewChoice; needsAi: boolean }> {
  const pick = await picker?.({ transactionId: moneyId });
  if (pick === undefined) return { bestAnswer: KEEP, needsAi: true };
  if (pick === null) return { bestAnswer: KEEP, needsAi: false };
  const found = await spendingFor(database, moneyId);
  const picked = found?.spending.find((each) => each.id === pick.spendingTransactionId);
  if (found === undefined || picked === undefined) return { bestAnswer: KEEP, needsAi: false };
  return {
    bestAnswer: {
      value: `${LINK}${picked.id}`,
      label: `Yes, it pays back ${spendingLabel(picked, found.postedDate)}`,
    },
    needsAi: false,
  };
}

// Opens an item for each result booked as money from a person that has none open, and settles each
// open item whose Transaction is now decided another way or no longer shows. `gone` are
// Transactions that no longer show. The open items are read once, and opened and settled in one
// batch each.
export async function updateMoneyFromPersonItems(
  database: Database,
  decided: readonly { transactionId: string; step: string }[],
  gone: readonly string[],
): Promise<void> {
  if (decided.length === 0 && gone.length === 0) return;
  const open = new Set(
    (await openReviewItemsOfKind(database, MONEY_FROM_PERSON_KIND)).map(moneyOf),
  );
  const settled = gone.filter((id) => open.has(id));
  const asked: string[] = [];
  for (const { transactionId, step } of decided) {
    if (step !== MONEY_FROM_PERSON_STEP) {
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
  if (asked.length === 0) return;
  const items = [];
  for (const transactionId of asked) {
    items.push({
      kind: MONEY_FROM_PERSON_KIND,
      subject: { type: "transactions" as const, transactionIds: [transactionId] },
      decided: DECIDED,
      ...(await bestAnswerFor(database, transactionId)),
    });
  }
  await openReviewItemBatch(database, items);
  log.info("Money from a person went on the Review list", { opened: asked.length });
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
