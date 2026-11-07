import { type HouseholdAi, QUICK_BATCH_SIZE } from "../ai/index.ts";
import { type Category, isCategory } from "../categories/index.ts";
import {
  type CategoryConfidence,
  type CategoryRecord,
  type CategorySource,
  type Database,
  listBestGuessIds,
  listMarkedNameIds,
  listMerchantHistory,
  type PartCategory,
  readCategoryFixFacts,
  readCategoryRecords,
  storePartCategories,
} from "../db/index.ts";
import { askForFollowUp, followUpAgain, registerFollowUpStep } from "../follow-up/index.ts";
import { log } from "../log.ts";
import { registerDecidedAgain } from "../money-movement/index.ts";
import { registerRedoStep } from "../redo/index.ts";
import {
  openReviewItemBatch,
  openReviewItemsOfKind,
  type ReviewItem,
  type ReviewKind,
  registerReviewKind,
  settleReviewItems,
} from "../review/index.ts";
import {
  bestGuess,
  type CascadeInput,
  type Choice,
  fromProviderOrHistory,
  handSetOrRule,
  MerchantHistory,
  merchantOf,
  registerCascadeStep,
} from "./cascade.ts";
import {
  type CategoryFixAnswer,
  type CategoryFixRow,
  cleanMarkedNames,
  fixCategories,
  type QuickAnswer,
} from "./quick-tier.ts";
import {
  applyCorrection,
  categoryChoices,
  readCategoryChoice,
  ruleFor,
  takesCategory,
} from "./rules.ts";
import {
  type LookupResult,
  lookupKeys,
  readKeptAnswers,
  skipsLookup,
  WebLookups,
} from "./web-lookup.ts";

// The Categorization follow-up step (spec 10, The follow-up pipeline; spec 04, The categorization
// cascade). It runs after Matching, on the parts Matching decided, and works through Transactions
// oldest first, in batches. A new decision from Matching clears a part's Category, so the step
// chooses it again on every provider change; a Member's hand-set Category wins at step 1. With an
// AI provider, it first cleans the Merchant names the fixed rules could not fix, so the cascade
// reads the clean names, and asks the AI at step 5 in batches of up to 100 Transactions.

// The Review list kinds (spec 04, Review list items): a best guess made without AI, and a Category
// the AI chose with confidence below high.
export const BEST_GUESS_KIND = "best guess made without AI";
export const AI_UNSURE_KIND = "Category the AI was unsure of";

const BATCH = 500;

type RecordPart = CategoryRecord["parts"][number];

// How step 5 runs.
// - The Household's AI: it answers in batches of up to 100 Transactions.
// - "follow-up job": no AI call here. The Transactions step 5 would ask about, and every one after
//   them, are left for the follow-up job's Categorization step, which asks.
// - undefined: no AI. Step 6 answers, and marks each best guess for the redo of no-AI work.
export type AiStep = HouseholdAi | "follow-up job" | undefined;

// The Transactions a run left unchosen, oldest first: they wait for the AI's retry at `again`, or
// for the follow-up job.
export type CategoryRun = { left: string[]; again: Date | undefined };

// What the Review list holds for a Transaction: its best guess made without AI, and the Category
// the AI was unsure of. `unsure` is undefined when the AI chose a part's Category in an earlier
// run, so this run does not know how sure it was.
type ReviewState = { guess: Category | null; unsure: Category | null | undefined };

// A part's Category, the step that chose it, and that step's confidence when this run chose it.
type Chosen = {
  category: string | null;
  source: CategorySource | null;
  confidence?: CategoryConfidence;
};

// The parts the cascade covers: Spending, and a Refund with no link, which goes through the cascade
// as if it were Spending. A linked Refund takes its Spending's Category from the link, and so does
// a Reimbursement, so the cascade leaves them alone.
function coveredByCascade(part: RecordPart): boolean {
  if (part.type === "Spending") return true;
  return part.type === "Refund" && !part.linked;
}

// Steps 3 to 6 for one Transaction: a Category, "ai" when step 5 asks the AI, or "waits" when step
// 4 needs an earlier Transaction's AI answer first.
type Rest = Choice | "ai" | "waits";

// The Category of one part. A part of a tracked loan payment keeps Money movement's Category, and
// only a hand edit changes it. A Category that a Money movement rule names takes the place of steps
// 3 to 6, and steps 1 and 2 still win.
async function choosePart(
  part: RecordPart,
  winning: () => Promise<Choice | undefined>,
  rest: () => Promise<Rest>,
): Promise<Rest> {
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

function reviewState(record: CategoryRecord, chosen: ReadonlyMap<number, Chosen>): ReviewState {
  const covered = record.parts.flatMap((part) => {
    const choice = coveredByCascade(part) ? chosen.get(part.part) : undefined;
    return choice === undefined ? [] : [choice];
  });
  const asCategory = (choice: Chosen | undefined) =>
    choice?.category != null && isCategory(choice.category) ? choice.category : null;
  const guess = asCategory(covered.find((choice) => choice.source === "best guess"));
  // A Web lookup's answer counts as the AI's: below high, the AI was unsure.
  const ai = covered.filter((choice) => choice.source === "AI" || choice.source === "Web lookup");
  const unsure = ai.find(
    (choice) => choice.confidence !== undefined && choice.confidence !== "high",
  );
  if (unsure !== undefined) return { guess, unsure: asCategory(unsure) };
  return { guess, unsure: ai.some((choice) => choice.confidence === undefined) ? undefined : null };
}

// One Transaction waiting for the AI's answer, with the parts that answer decides.
type Waiting = {
  record: CategoryRecord;
  txn: CascadeInput;
  parts: number[];
  chosen: Map<number, Chosen>;
  // Step 4 needed an answer in this batch, so it is checked again once the answers come.
  historyWaits: boolean;
  // The parts the AI decides past steps 3 and 4. With no answer, each keeps its Category and mark.
  direct: ReadonlySet<number>;
};

// Runs the cascade on each Transaction's covered parts that have no Category chosen yet, in the
// order given: oldest first, so Merchant history sees an earlier Transaction first. A Transaction
// that waits for the AI joins Merchant history once its answer comes. A later Transaction whose
// step 4 needs that answer joins the same batch, so a Merchant whose answers differ never sends a
// batch for each Transaction; once the answers come, step 4 is checked again for it, and wins over
// the AI's answer when it gives one.
// - With `redo`, a best guess made without AI counts as not chosen, so the cascade decides it again
//   (spec 08, Redo of no-AI work); a hand-set Category is never one. So does every other marked
//   part: "Run AI on all history" marked it (spec 08, AI work on your Transactions), and steps 1
//   and 2 still win, but the AI decides it at step 5, past the provider's category and Merchant
//   history. With `allHistory`, a marked best guess goes past steps 3 and 4 too.
// - A part the AI decides past steps 3 and 4 keeps its Category and its mark when the AI gives no
//   answer, for AI's next return: a best guess never takes the place of a Category the AI or
//   another step chose.
// Returns what the Review list holds for each Transaction the run decided, the Transactions it
// left, and how many Transactions' Categories the AI answered.
export async function chooseCategories(
  database: Database,
  ids: readonly string[],
  ai: AiStep = undefined,
  options: { redo?: boolean; allHistory?: boolean } = {},
): Promise<CategoryRun & { reviews: Map<string, ReviewState>; answered: number }> {
  const unchosen = (part: RecordPart) =>
    part.categorySource === null ||
    (options.redo === true && (part.categorySource === "best guess" || part.categoryNeedsAi));
  // A marked part the AI decides at step 5, past steps 3 and 4.
  const direct = (part: RecordPart) =>
    options.redo === true &&
    part.categoryNeedsAi &&
    (part.categorySource !== "best guess" || options.allHistory === true);
  // Merchant history loads when a step first needs it. Until then, each Category chosen here waits
  // in `unloaded`, since the batch is stored only at its end.
  let history: MerchantHistory | undefined;
  type Entry = Parameters<MerchantHistory["set"]>[0];
  const unloaded = new Map<string, Entry | undefined>();
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
  const remember = (id: string, entry: Entry | undefined) => {
    if (history === undefined) unloaded.set(id, entry);
    else if (entry === undefined) history.remove(id);
    else history.set(entry);
  };

  const reviews = new Map<string, ReviewState>();
  const left: string[] = [];
  let again: Date | undefined;
  let stopped = false;
  let answered = 0;
  // Off once the AI is not available in this run, so no new retry cycle starts.
  let aiOn = ai !== undefined;
  let choices: PartCategory[] = [];
  let waiting: Waiting[] = [];
  // The run's Web lookups, started at the first batch the AI answers.
  let lookups: WebLookups | undefined;

  // `needsAi` marks a Category whose Web lookup an AI error or the AI cost cap stopped, for the redo
  // of no-AI work.
  const choose = (
    record: CategoryRecord,
    part: number,
    choice: Choice,
    chosen: Map<number, Chosen>,
    needsAi = false,
  ) => {
    chosen.set(part, choice);
    choices.push({
      transactionId: record.id,
      part,
      category: choice.category,
      categorySource: choice.source,
      categoryConfidence: choice.confidence,
      categoryNeedsAi: choice.source === "best guess" || needsAi,
    });
  };

  // The Transaction's first Spending part, outside a loan payment, joins its Merchant's history,
  // with no Category while the AI's answer for it is still to come.
  const joinHistory = (
    record: CategoryRecord,
    txn: CascadeInput,
    chosen: ReadonlyMap<number, Chosen>,
    asking: readonly number[] = [],
  ) => {
    const spending = record.parts.find((part) => part.type === "Spending" && !part.keepsCategory);
    const merchant = txn.merchant;
    if (spending === undefined || merchant === null) return remember(record.id, undefined);
    const { id, postedDate } = record;
    if (asking.includes(spending.part)) {
      return remember(id, { id, postedDate, merchant, category: null, source: null });
    }
    const choice = chosen.get(spending.part);
    remember(
      id,
      choice?.category != null && isCategory(choice.category)
        ? { id, postedDate, merchant, category: choice.category, source: choice.source }
        : undefined,
    );
  };

  // Asks the AI about the waiting Transactions, and chooses their Categories from its answers. With
  // no answer, each takes the best guess, in order; with a retry time, the run stops and leaves
  // them.
  async function flush(): Promise<void> {
    if (waiting.length === 0) return;
    const asked = waiting;
    waiting = [];
    let answer: QuickAnswer<CategoryFixAnswer> = { noAi: "off" };
    // The answer for each waiting Transaction by its place in `asked`: a kept Web lookup's, the
    // AI's, or a new Web lookup's in the AI's place. `marked` holds the places whose Web lookup
    // waits for the redo.
    const answers = new Map<number, Choice>();
    const marked = new Set<number>();
    if (aiOn && typeof ai === "object") {
      const facts = await readCategoryFixFacts(
        database,
        asked.map(({ record }) => record.id),
      );
      lookups ??= await WebLookups.start(database, ai);
      const lookable = await lookableLines(
        ai,
        lookups,
        asked.map(({ record, txn }) => ({
          merchant: txn.merchant,
          description: facts.get(record.id)?.description ?? "",
          providerCategory: record.providerCategory,
        })),
      );
      // Step 5 starts with the Web lookup's kept answers, read once for the batch: a found answer
      // decides at once, with no AI call and no search.
      const kept = await readKeptAnswers(
        database,
        asked.map(({ txn }, index) => (lookable[index] === true ? txn.merchant : null)),
        new Date(),
      );
      const sent: number[] = [];
      for (const [index, each] of kept.entries()) {
        if (typeof each === "object") {
          answers.set(index, {
            category: each.category,
            source: "Web lookup",
            confidence: each.confidence,
          });
        } else sent.push(index);
      }
      const labels = sent.length === 0 ? new Map<string, string>() : await ai.accountLabels();
      answer =
        sent.length === 0
          ? { answers: [] }
          : await fixCategories(
              ai,
              sent.map((index): CategoryFixRow => {
                const { record, txn } = asked[index] as Waiting;
                const fact = facts.get(record.id);
                return {
                  merchant: txn.merchant?.name || null,
                  description: fact?.description ?? "",
                  amount: fact?.amount ?? 0,
                  date: record.postedDate,
                  account: fact === undefined ? null : (labels.get(fact.accountId) ?? null),
                  providerCategory: record.providerCategory,
                  mcc: fact?.mcc ?? null,
                };
              }),
            );
      if ("answers" in answer) {
        const unsure: number[] = [];
        for (const reply of answer.answers) {
          const index = sent[reply.row - 1];
          if (index === undefined) continue;
          answers.set(index, {
            category: reply.category,
            source: "AI",
            confidence: reply.confidence,
          });
          // Only an unsure answer about a Merchant the AI does not know needs a lookup.
          if (
            reply.needsLookup &&
            reply.confidence !== "high" &&
            lookable[index] === true &&
            kept[index] === undefined
          ) {
            unsure.push(index);
          }
        }
        await lookUp(
          lookups,
          unsure.map((index) => (asked[index] as Waiting).txn.merchant),
          (place, result) => {
            const index = unsure[place] as number;
            if (typeof result !== "object") return;
            if ("found" in result) {
              answers.set(index, { ...result.found, source: "Web lookup" });
            } else if (result.stopped.mark) marked.add(index);
          },
        );
      }
    }
    if ("retryAt" in answer) {
      again = answer.retryAt;
      stopped = true;
      left.push(...asked.map(({ record }) => record.id));
      return;
    }
    if ("noAi" in answer && answer.noAi === "off") aiOn = false;
    const loaded = await loadHistory();
    // A row the AI gave no good answer takes the no-AI path.
    for (const [index, { record, txn, parts, chosen, historyWaits, direct }] of asked.entries()) {
      const fromAi = answers.get(index);
      const needsAi = marked.has(index);
      // The earlier Transactions of this batch are in Merchant history by now.
      const history = historyWaits ? fromProviderOrHistory(txn, loaded) : undefined;
      const choice: Choice =
        typeof history === "object" ? history : (fromAi ?? bestGuess(txn, loaded));
      let tookAnswer = false;
      for (const part of parts) {
        if (direct.has(part)) {
          if (fromAi === undefined) continue;
          choose(record, part, fromAi, chosen, needsAi);
          tookAnswer = true;
        } else {
          choose(record, part, choice, chosen, needsAi && choice === fromAi);
          if (choice === fromAi) tookAnswer = true;
        }
      }
      if (tookAnswer) answered += 1;
      joinHistory(record, txn, chosen);
      reviews.set(record.id, reviewState(record, chosen));
    }
  }

  // Chooses the Category of each covered part of one Transaction, or of none: "later" when step 5
  // is left for the follow-up job.
  async function decide(record: CategoryRecord): Promise<"done" | "later"> {
    if (record.hidden) {
      reviews.set(record.id, { guess: null, unsure: null });
      return "done";
    }
    const txn: CascadeInput = { ...record, merchant: merchantOf(record) };
    let won: Promise<Choice | undefined> | undefined;
    let rest: Promise<Rest> | undefined;
    const winning = () => {
      won ??= handSetOrRule(txn);
      return won;
    };
    const fromRest = () => {
      rest ??= loadHistory().then((loaded) => {
        const found = fromProviderOrHistory(txn, loaded);
        if (found !== undefined) return found;
        return aiOn ? "ai" : bestGuess(txn, loaded);
      });
      return rest;
    };
    const chosen = new Map<number, Chosen>(
      record.parts.map((part) => [
        part.part,
        { category: part.category, source: part.categorySource },
      ]),
    );
    // Steps 3 and 4 give no answer for a part the AI decides at step 5.
    const toAi = async (): Promise<Rest> => "ai";
    const picked: [number, Choice][] = [];
    const asking: number[] = [];
    const straight = new Set<number>();
    let historyWaits = false;
    for (const part of record.parts) {
      if (!coveredByCascade(part) || !unchosen(part)) continue;
      const past = direct(part);
      // A best guess is the cascade's own answer, never a Category Money movement named.
      const choice = await choosePart(
        part.categorySource === null ? part : { ...part, category: null },
        winning,
        past ? toAi : fromRest,
      );
      if (choice === "waits") historyWaits = true;
      if (choice === "ai" || choice === "waits") {
        asking.push(part.part);
        if (past) straight.add(part.part);
      } else picked.push([part.part, choice]);
    }
    if (asking.length > 0 && ai === "follow-up job") return "later";
    for (const [part, choice] of picked) choose(record, part, choice, chosen);
    joinHistory(record, txn, chosen, asking);
    if (asking.length === 0) {
      reviews.set(record.id, reviewState(record, chosen));
      return "done";
    }
    waiting.push({ record, txn, parts: asking, chosen, historyWaits, direct: straight });
    if (waiting.length >= QUICK_BATCH_SIZE) await flush();
    return "done";
  }

  for (let start = 0; start < ids.length; start += BATCH) {
    const chunk = ids.slice(start, start + BATCH);
    if (stopped) {
      left.push(...chunk);
      continue;
    }
    for (const record of await readCategoryRecords(database, chunk)) {
      if (stopped) {
        left.push(record.id);
        continue;
      }
      if ((await decide(record)) !== "done") {
        stopped = true;
        left.push(record.id);
      }
    }
    await flush();
    await storePartCategories(database, choices);
    choices = [];
  }
  // Merchants past the run's cap of lookups wait for the redo, which this makes due.
  if (lookups?.waitsPastCap === true && typeof ai === "object") await ai.lookupsWait();
  return { reviews, left, again, answered };
}

// Whether each line may be looked up: the Web lookup is on, the skip rules pass it, and the privacy
// filter finds no Member's name or protected number in its Merchant name, with one read of the
// filter's facts for the batch (spec 04, Web lookup).
async function lookableLines(
  ai: HouseholdAi,
  lookups: WebLookups,
  lines: readonly Parameters<typeof skipsLookup>[0][],
): Promise<boolean[]> {
  if (!lookups.on) return lines.map(() => false);
  const passed = lines.map((line) => !skipsLookup(line));
  const names = lines.flatMap((line, index) =>
    passed[index] === true && line.merchant !== null ? [line.merchant.name] : [],
  );
  const matched = await ai.privacyMatches(names);
  let next = 0;
  return passed.map((passes) => {
    if (!passes) return false;
    const found = matched[next];
    next += 1;
    return found === false;
  });
}

// Looks up each Merchant once, one at a time, in order, and hands each Transaction's place its
// Merchant's result. Once the run stops, every place left gets the stop.
async function lookUp(
  lookups: WebLookups,
  merchants: readonly CascadeInput["merchant"][],
  each: (place: number, result: LookupResult) => void,
): Promise<void> {
  const results = new Map<string, LookupResult>();
  for (const [place, merchant] of merchants.entries()) {
    const key = merchant === null ? undefined : lookupKeys(merchant)[0];
    if (merchant === null || key === undefined) continue;
    let result = results.get(key);
    if (result === undefined) {
      result = await lookups.lookUp(merchant);
      results.set(key, result);
    }
    each(place, result);
  }
}

const transactionIdsOf = (item: ReviewItem) =>
  item.subject.type === "transactions" ? item.subject.transactionIds : [];

// Keeps the Review list in step: a best guess made without AI has one open item, and so does a
// Category the AI chose below high. A Transaction whose Category is no longer one has none, such
// as when a later AI answer is high. Reads each kind's open items once, and writes each kind in one
// batch, so a large re-run reads the open items once.
async function updateReviewList(
  database: Database,
  reviews: ReadonlyMap<string, ReviewState>,
): Promise<void> {
  if (reviews.size === 0) return;
  const kinds = [
    {
      kind: BEST_GUESS_KIND,
      of: (state: ReviewState) => state.guess,
      decided: (category: string) => `No AI was available, so the app guessed ${category}.`,
      logged: "Best guesses made without AI went on the Review list",
    },
    {
      kind: AI_UNSURE_KIND,
      of: (state: ReviewState) => state.unsure,
      decided: (category: string) => `The AI chose ${category}, but it was unsure.`,
      logged: "Categories the AI was unsure of went on the Review list",
    },
  ];
  for (const { kind, of, decided, logged } of kinds) {
    const open = new Set((await openReviewItemsOfKind(database, kind)).flatMap(transactionIdsOf));
    const settled: string[] = [];
    const opening: { id: string; category: string }[] = [];
    for (const [id, state] of reviews) {
      const category = of(state);
      if (category === undefined) continue;
      if (category !== null && !open.has(id)) opening.push({ id, category });
      else if (category === null && open.has(id)) settled.push(id);
    }
    await settleReviewItems(
      database,
      { kind, subjectIds: settled },
      "its Category was chosen again",
    );
    await openReviewItemBatch(
      database,
      opening.map(({ id, category }) => ({
        kind,
        subject: { type: "transactions", transactionIds: [id] },
        decided: decided(category),
        bestAnswer: { value: category, label: `Yes, ${category}` },
      })),
    );
    if (opening.length > 0) log.info(logged, { opened: opening.length });
  }
}

// Runs the cascade, then keeps the Review list in step. Returns the Transactions it left.
export async function categorize(
  database: Database,
  ids: readonly string[],
  ai: AiStep = undefined,
  options: { redo?: boolean; allHistory?: boolean } = {},
): Promise<CategoryRun & { answered: number }> {
  const { reviews, left, again, answered } = await chooseCategories(database, ids, ai, options);
  await updateReviewList(database, reviews);
  return { left, again, answered };
}

// The Categorization step with the Household's AI. AI cleanup comes first, since the cascade reads
// the clean names. A name that waits for its AI retry stops the cascade at that Transaction: the
// cascade works oldest first, so every Transaction from there on waits too.
async function categorizeWithAi(
  database: Database,
  ai: HouseholdAi,
  unhandled: readonly string[],
): Promise<CategoryRun> {
  const names = await cleanMarkedNames(database, ai, unhandled);
  const first = unhandled.findIndex((id) => names.waiting.has(id));
  const ready = first === -1 ? unhandled : unhandled.slice(0, first);
  const run = await categorize(database, ready, ai);
  const waiting = first === -1 ? [] : unhandled.slice(first);
  const times = [run.again, names.again].flatMap((time) => (time === undefined ? [] : [time]));
  const again = times.sort((a, b) => a.getTime() - b.getTime())[0];
  return { left: [...run.left, ...waiting], again };
}

// Each answer counts as hand-set: the Category becomes the Transaction's hand-set Category.
// Accepting the guess makes a Category rule with it (spec 04, Review list items). Picking another
// Category is a correction, and makes a rule unless the Member picks "only this Transaction". The
// follow-up job then runs the cascade again, so Categorization never runs beside a sync.
function categoryReviewKind(database: Database): ReviewKind {
  return {
    // "Not this" offers the Category list, and the same list for only this Transaction.
    async otherChoices(item) {
      const [record] = await readCategoryRecords(database, transactionIdsOf(item));
      return categoryChoices(record === undefined ? null : merchantOf(record));
    },
    async answer(item, choice, answering) {
      const answer = readCategoryChoice(choice.value);
      if (item.subject.type !== "transactions" || answer === undefined) {
        throw new Error("A Category item is about a Transaction, and its answer is a Category.");
      }
      const at = new Date();
      for (const record of await readCategoryRecords(answering.database, transactionIdsOf(item))) {
        await applyCorrection(
          answering.database,
          { id: record.id, merchant: merchantOf(record), takesCategory: takesCategory(record) },
          answer.category,
          { onlyThisTransaction: answer.onlyThisTransaction, memberId: answering.memberId, at },
        );
      }
    },
    afterAnswer: () => askForFollowUp(),
  };
}

// The redo of no-AI work (spec 08, Redo of no-AI work), with the Household's AI. Each marked
// Merchant name goes to the AI cleanup once, and each best guess from step 6 through the cascade
// again, in the Quick tier's batches, with every Transaction an earlier redo step decided again.
// Every other marked Category, which "Run AI on all history" marked, goes to the AI at step 5 (spec
// 08, AI work on your Transactions), and so does a best guess in that run. A Transaction the AI did
// not reach keeps its Category and its mark; one with no Category, such as one decided again, takes
// the best guess. The step counts the Transactions whose Category the AI answered.
function registerRedoSteps(database: Database, ai: HouseholdAi): (() => void)[] {
  return [
    registerRedoStep("Merchant names", async (run) => {
      if (run.ai) await cleanMarkedNames(database, ai, await listMarkedNameIds(database));
      return [];
    }),
    registerRedoStep("Categories", async (run) => {
      if (!run.ai) {
        await categorize(database, run.decided);
        return [];
      }
      const ids = await listBestGuessIds(database, run.decided);
      const { left, answered } = await categorize(database, ids, ai, {
        redo: true,
        allHistory: run.allHistory,
      });
      run.countAiCategories(answered);
      if (left.length > 0) await categorize(database, left);
      return [];
    }),
  ];
}

// Registers the Categorization step, the cascade's Category rule step, the two Review list kinds,
// and the listener for Transactions Money movement decides again. With `ai`, the step cleans marked
// Merchant names and asks the AI at step 5, and the redo of no-AI work gets its two steps. The
// start calls it before jobs run.
export function startCategorization(options: { database: Database; ai?: HouseholdAi }): {
  stop(): void;
} {
  const { database, ai } = options;
  const stops = [
    registerFollowUpStep("categorization", async (unhandled) => {
      const run =
        ai === undefined
          ? await categorize(database, unhandled)
          : await categorizeWithAi(database, ai, unhandled);
      if (run.again === undefined) return undefined;
      const left = new Set(run.left);
      return { handled: unhandled.filter((id) => !left.has(id)), again: run.again };
    }),
    // Money movement decides Transactions again inside Matching, and in the daily task, which make
    // no AI call. A Transaction that needs the AI goes to the next follow-up job, with every one
    // after it.
    registerDecidedAgain(async (ids) => {
      const run = await categorize(database, ids, ai === undefined ? undefined : "follow-up job");
      if (run.left.length === 0) return;
      await followUpAgain(database, run.left);
      await askForFollowUp();
    }),
    registerCascadeStep("Category rule", async (txn) => {
      const rule = await ruleFor(database, txn.merchant);
      return rule === undefined ? undefined : { category: rule.category, confidence: "certain" };
    }),
    registerReviewKind(BEST_GUESS_KIND, categoryReviewKind(database)),
    registerReviewKind(AI_UNSURE_KIND, categoryReviewKind(database)),
    ...(ai === undefined ? [] : registerRedoSteps(database, ai)),
  ];
  return {
    stop() {
      for (const stop of stops.reverse()) stop();
    },
  };
}
