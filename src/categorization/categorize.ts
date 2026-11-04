import { CATEGORIES, type Category, isCategory } from "../categories/index.ts";
import {
  type CategoryRecord,
  type CategorySource,
  type Database,
  listMerchantHistory,
  type PartCategory,
  readCategoryRecords,
  setHandSetFields,
  storePartCategories,
} from "../db/index.ts";
import { askForFollowUp, followUpAgain, registerFollowUpStep } from "../follow-up/index.ts";
import { log } from "../log.ts";
import { registerDecidedAgain } from "../money-movement/index.ts";
import {
  openReviewItemBatch,
  openReviewItems,
  registerReviewKind,
  settleReviewItems,
} from "../review/index.ts";
import {
  type CascadeInput,
  type Choice,
  fromProviderOrHistory,
  handSetOrRule,
  MerchantHistory,
  merchantOf,
} from "./cascade.ts";

// The Categorization follow-up step (spec 10, The follow-up pipeline; spec 04, The categorization
// cascade). It runs after Matching, on the parts Matching decided, and works through Transactions
// oldest first, in batches. A new decision from Matching clears a part's Category, so the step
// chooses it again on every provider change; a Member's hand-set Category wins at step 1.

// The Review list kind for a best guess (spec 04, Review list items).
export const BEST_GUESS_KIND = "best guess made without AI";

const BATCH = 500;

type RecordPart = CategoryRecord["parts"][number];

// The parts the cascade covers: Spending, and a Refund with no link, which goes through the cascade
// as if it were Spending. A linked Refund takes its Spending's Category from the link, and so does
// a Reimbursement, so the cascade leaves them alone.
function coveredByCascade(part: RecordPart): boolean {
  if (part.type === "Spending") return true;
  return part.type === "Refund" && (part.category === null || part.categorySource !== null);
}

// The Category of one part. A part of a tracked loan payment keeps Money movement's Category, and
// only a hand edit changes it. A Category that a Money movement rule names takes the place of steps
// 3 to 6, and steps 1 and 2 still win.
async function choosePart(
  part: RecordPart,
  winning: () => Promise<Choice | undefined>,
  rest: () => Promise<Choice>,
): Promise<Choice> {
  const named = part.category !== null && isCategory(part.category) ? part.category : undefined;
  if (part.keepsCategory && named !== undefined) {
    const hand = await winning();
    return hand?.source === "hand-set"
      ? hand
      : { category: named, source: "money movement", confidence: "certain" };
  }
  const won = await winning();
  if (won !== undefined) return won;
  if (named !== undefined)
    return { category: named, source: "money movement", confidence: "certain" };
  return rest();
}

// Runs the cascade on each Transaction's covered parts that have no Category chosen yet, in the
// order given: oldest first, so Merchant history sees an earlier Transaction first. Returns each
// shown Transaction's best guess, or null when none of its parts is a best guess; a hidden
// Transaction has none.
export async function chooseCategories(
  database: Database,
  ids: readonly string[],
): Promise<Map<string, Category | null>> {
  // Merchant history loads when a step first needs it. Until then, each Category chosen here waits
  // in `unloaded`, since the batch is stored only at its end.
  let history: MerchantHistory | undefined;
  const unloaded = new Map<string, Parameters<MerchantHistory["set"]>[0] | undefined>();
  const loadHistory = async () => {
    if (history === undefined) {
      history = new MerchantHistory(await listMerchantHistory(database));
      for (const [id, entry] of unloaded) {
        if (entry === undefined) history.remove(id);
        else history.set(entry);
      }
    }
    return history;
  };
  const guesses = new Map<string, Category | null>();
  for (let start = 0; start < ids.length; start += BATCH) {
    const records = await readCategoryRecords(database, ids.slice(start, start + BATCH));
    const choices: PartCategory[] = [];
    for (const record of records) {
      if (record.hidden) {
        guesses.set(record.id, null);
        continue;
      }
      const txn: CascadeInput = { ...record, merchant: merchantOf(record) };
      let won: Promise<Choice | undefined> | undefined;
      let rest: Promise<Choice> | undefined;
      const winning = () => {
        won ??= handSetOrRule(txn);
        return won;
      };
      const fromRest = () => {
        rest ??= loadHistory().then((loaded) => fromProviderOrHistory(txn, loaded));
        return rest;
      };
      const parts = new Map<number, { category: string | null; source: CategorySource | null }>();
      for (const part of record.parts) {
        parts.set(part.part, { category: part.category, source: part.categorySource });
        if (!coveredByCascade(part)) continue;
        if (part.categorySource !== null) continue;
        const choice = await choosePart(part, winning, fromRest);
        parts.set(part.part, { category: choice.category, source: choice.source });
        choices.push({
          transactionId: record.id,
          part: part.part,
          category: choice.category,
          categorySource: choice.source,
          categoryConfidence: choice.confidence,
          categoryNeedsAi: choice.source === "best guess",
        });
      }
      // The Transaction's first Spending part, outside a loan payment, joins its Merchant's history.
      const spending = record.parts.find((part) => part.type === "Spending" && !part.keepsCategory);
      const chosen = spending === undefined ? undefined : parts.get(spending.part);
      const entry =
        txn.merchant !== null && chosen?.category != null && isCategory(chosen.category)
          ? {
              id: record.id,
              postedDate: record.postedDate,
              merchant: txn.merchant,
              category: chosen.category,
              source: chosen.source,
            }
          : undefined;
      if (history === undefined) unloaded.set(record.id, entry);
      else if (entry === undefined) history.remove(record.id);
      else history.set(entry);
      const guess = record.parts.find(
        (part) => coveredByCascade(part) && parts.get(part.part)?.source === "best guess",
      );
      const guessed = guess === undefined ? undefined : parts.get(guess.part)?.category;
      guesses.set(record.id, guessed != null && isCategory(guessed) ? guessed : null);
    }
    await storePartCategories(database, choices);
  }
  return guesses;
}

// Runs the cascade, then keeps the Review list in step: a best guess made without AI has one open
// item, and a Transaction whose Category is no longer a best guess has none.
export async function categorize(database: Database, ids: readonly string[]): Promise<void> {
  const guesses = await chooseCategories(database, ids);
  const open = new Set(
    (await openReviewItems(database))
      .filter((item) => item.kind === BEST_GUESS_KIND && item.subject.type === "transactions")
      .flatMap((item) => (item.subject.type === "transactions" ? item.subject.transactionIds : [])),
  );
  const settled: string[] = [];
  const opening: { id: string; guess: string }[] = [];
  for (const [id, guess] of guesses) {
    if (guess !== null && !open.has(id)) opening.push({ id, guess });
    else if (guess === null && open.has(id)) settled.push(id);
  }
  // In one batch each, so a large re-run reads the open items once.
  await settleReviewItems(
    database,
    { kind: BEST_GUESS_KIND, subjectIds: settled },
    "its Category was chosen again",
  );
  await openReviewItemBatch(
    database,
    opening.map(({ id, guess }) => ({
      kind: BEST_GUESS_KIND,
      subject: { type: "transactions", transactionIds: [id] },
      decided: `No AI was available, so the app guessed ${guess}.`,
      bestAnswer: { value: guess, label: `Yes, ${guess}` },
    })),
  );
  const opened = opening.length;
  if (opened > 0) log.info("Best guesses made without AI went on the Review list", { opened });
}

// Registers the Categorization step, the best-guess Review list kind, and the listener for
// Transactions Money movement decides again. The start calls it before jobs run.
export function startCategorization(options: { database: Database }): { stop(): void } {
  const { database } = options;
  const stops = [
    registerFollowUpStep("categorization", async (unhandled) => {
      await categorize(database, unhandled);
      return undefined;
    }),
    registerDecidedAgain((ids) => categorize(database, ids)),
    registerReviewKind(BEST_GUESS_KIND, {
      // "Not this" offers the Category list.
      async otherChoices() {
        return CATEGORIES.map((category) => ({ value: category.name, label: category.name }));
      },
      // Every answer counts as hand-set: the Category becomes the Transaction's hand-set Category.
      // Accepting also makes a Category rule once T32 (#58) adds them. The follow-up job then runs
      // the cascade again, so Categorization never runs beside a sync.
      async answer(item, choice, answering) {
        if (item.subject.type !== "transactions" || !isCategory(choice.value)) {
          throw new Error("A best guess is about a Transaction, and its answer is a Category.");
        }
        for (const id of item.subject.transactionIds) {
          await setHandSetFields(answering.database, id, { category: choice.value });
        }
        await followUpAgain(answering.database, item.subject.transactionIds);
      },
      afterAnswer: () => askForFollowUp(),
    }),
  ];
  return {
    stop() {
      for (const stop of stops.reverse()) stop();
    },
  };
}
