import {
  type Database,
  type DecisionRecord,
  type LoanFields,
  linkTransferByHand,
  listDecidedAt,
  listDecisionAccounts,
  listLoanPaymentIds,
  listProvisionalPassed,
  listUnlinkedTransferDecisions,
  type Queries,
  readDecision,
  readDecisionRecords,
  readPendingParts,
  readTransferLink,
  refuseTransferLink,
  removeDecisions,
  type StoredDecision,
  type StoredPart,
  saveUnconnectedAssignments,
  setHandSetFields,
  storeDecisions,
  storeLoanFields,
  type TransferPair,
} from "../db/index.ts";
import { askForFollowUp, followUpAgain, registerFollowUpStep } from "../follow-up/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { Job } from "../jobs/index.ts";
import { log } from "../log.ts";
import {
  openReviewItem,
  openReviewItems,
  type ReviewChoice,
  type ReviewItem,
  registerReviewKind,
  settleReviewItems,
} from "../review/index.ts";
import { isLoan, type LoanSettings, loanFactsReader, readLoanSettings } from "./loans.ts";
import { ONE_SIDED_KIND, ONE_SIDED_STEPS, oneSidedKind } from "./one-sided.ts";
import {
  type Decision,
  type DecisionContext,
  type DecisionStep,
  decide,
  type Part,
} from "./order.ts";
import { type PairingResult, pairTransfers, type TransferSignal } from "./transfers.ts";
import type { HandSetType } from "./types.ts";

// The Matching follow-up step, the daily task for provisional results, a hand-set type, and the
// Review list items for Transfer pairs.

// The Household's date. Until the wizard's step 4 sets the Household time zone, it is the date in
// UTC.
async function householdToday(database: Database, now: Date): Promise<string> {
  return calendarDateIn(now, (await householdTimeZone(database)) ?? "UTC");
}

// What the order reads besides each Transaction, read once a run.
async function decisionContext(database: Database, now: Date): Promise<DecisionContext> {
  const today = await householdToday(database, now);
  const accounts = new Map(
    (await listDecisionAccounts(database)).map((account) => [account.id, account]),
  );
  return { today, accounts, loanFacts: loanFactsReader(database, accounts) };
}

// A result to store, with the Unconnected account it goes to and the Review list item it asks
// for.
type Decided = {
  stored: StoredDecision;
  unconnectedAccountId: string | null;
  asks: Decision["asks"];
};

async function decideAll(
  database: Database,
  records: readonly DecisionRecord[],
  now: Date,
): Promise<Decided[]> {
  const context = await decisionContext(database, now);
  const decided: Decided[] = [];
  for (const { hidden, ...record } of records) {
    const { step, parts, provisionalUntil, unconnectedAccountId, asks } = await decide({
      ...record,
      ...context,
    });
    decided.push({
      stored: {
        transactionId: record.id,
        step,
        provisionalUntil: provisionalUntil ?? null,
        decidedAt: now,
        parts,
      },
      unconnectedAccountId: unconnectedAccountId ?? null,
      asks,
    });
  }
  return decided;
}

// Opens a one-sided Transfer item for each result that asks for one, and settles each open item
// whose Transaction no longer asks for it, or now asks with another best answer. `gone` are
// Transactions that no longer show.
async function updateOneSidedItems(
  database: Database,
  decided: readonly Decided[],
  gone: readonly string[],
): Promise<void> {
  const open = new Map<string, ReviewItem>();
  for (const item of await openReviewItems(database)) {
    if (item.kind !== ONE_SIDED_KIND || item.subject.type !== "transactions") continue;
    open.set(item.subject.transactionIds[0] ?? "", item);
  }
  const settle = (id: string) =>
    settleReviewItems(database, { kind: ONE_SIDED_KIND, subjectId: id }, "decided again");
  let opened = 0;
  for (const { stored, asks } of decided) {
    const id = stored.transactionId;
    const item = open.get(id);
    if (item !== undefined && item.bestAnswer.value === asks?.bestAnswer.value) continue;
    if (item !== undefined) await settle(id);
    if (asks === undefined) continue;
    await openReviewItem(database, {
      kind: ONE_SIDED_KIND,
      subject: { type: "transactions", transactionIds: [id] },
      ...asks,
    });
    opened += 1;
  }
  for (const id of gone) if (open.has(id)) await settle(id);
  if (opened > 0) log.info("One-sided Transfers went on the Review list", { opened });
}

// Stores each result in place of the Transaction's earlier one, with the Unconnected account it
// goes to, and keeps the one-sided Transfer items in step.
async function storeResults(
  database: Database,
  decided: readonly Decided[],
  now: Date,
  gone: readonly string[] = [],
): Promise<void> {
  await storeDecisions(
    database,
    decided.map((result) => result.stored),
  );
  await saveUnconnectedAssignments(
    database,
    [
      ...decided.map((result) => ({
        transactionId: result.stored.transactionId,
        accountId: result.unconnectedAccountId,
      })),
      ...gone.map((transactionId) => ({ transactionId, accountId: null })),
    ],
    now,
  );
  await updateOneSidedItems(database, decided, gone);
}

// Transactions the order decided again outside the Matching step's own list: a type set by hand, a
// provisional result whose window passed, or the other side of a pair that began or ended. A new
// decision clears their Categories, so the categorization step registers here to choose them
// again.
export type DecidedAgain = (transactionIds: readonly string[]) => Promise<void>;

let decidedAgain: DecidedAgain | undefined;

// Registers the listener. Returns a function that removes it again.
export function registerDecidedAgain(listener: DecidedAgain): () => void {
  if (decidedAgain !== undefined) throw new Error("A listener is already registered.");
  decidedAgain = listener;
  return () => {
    if (decidedAgain === listener) decidedAgain = undefined;
  };
}

// Tells the listener, oldest first, so Merchant history sees an earlier Transaction first.
async function tellDecidedAgain(
  records: readonly { id: string; postedDate: string }[],
): Promise<void> {
  if (records.length === 0) return;
  const oldestFirst = [...records].sort(
    (a, b) => a.postedDate.localeCompare(b.postedDate) || a.id.localeCompare(b.id),
  );
  await decidedAgain?.(oldestFirst.map((record) => record.id));
}

// A posted Transaction takes the Categories of the pending one it replaces, part by part, when its
// parts have the same types (spec 03, Pending Transactions; spec 04, Re-runs). The categorization
// step leaves a part with a carried Category as it is.
function carryOver(decision: StoredDecision, pending: StoredPart[] | undefined): StoredDecision {
  if (
    pending === undefined ||
    pending.length !== decision.parts.length ||
    pending.some((before, index) => before.type !== decision.parts[index]?.type)
  ) {
    return decision;
  }
  const parts = decision.parts.map((part, index) => {
    const before = pending[index];
    if (before === undefined || before.categorySource === null) return part;
    return {
      ...part,
      category: before.category,
      categorySource: before.categorySource,
      categoryConfidence: before.categoryConfidence,
      categoryNeedsAi: before.categoryNeedsAi,
    };
  });
  return { ...decision, parts };
}

// The Review list kinds for Transfer pairs (spec 03, Review list items). Each item is about the
// pair's money-out side, then its money-in side.
export const UNCLEAR_PAIR_KIND = "unclear Transfer pair";
export const PAIR_GUESS_KIND = "Transfer pair guess";

const PAIR_KINDS = { unclear: UNCLEAR_PAIR_KIND, guess: PAIR_GUESS_KIND } as const;
const DECIDED = {
  unclear: "These match as a Transfer, but nothing more ties them, so they are not linked.",
  guess: "Two sets of Transfer pairs were equally good, so the app picked this one.",
} as const;
const LINK: ReviewChoice = { value: "link", label: "Yes, they are one Transfer" };
const NOT_THIS: ReviewChoice = { value: "not this", label: "No, they are not a Transfer" };

// Opens an item for each pair that pairing asks about, and settles each open item about a
// Transaction it looked at that it no longer asks about.
async function updatePairItems(database: Database, pairing: PairingResult): Promise<void> {
  const wanted = new Map(
    pairing.items.map((item) => [
      `${PAIR_KINDS[item.kind]} ${item.pair.outTransactionId} ${item.pair.inTransactionId}`,
      item,
    ]),
  );
  const kinds = new Set<string>(Object.values(PAIR_KINDS));
  const open = new Set<string>();
  for (const item of await openReviewItems(database)) {
    if (!kinds.has(item.kind) || item.subject.type !== "transactions") continue;
    const ids = item.subject.transactionIds;
    const key = `${item.kind} ${ids.join(" ")}`;
    if (wanted.has(key)) open.add(key);
    else if (ids.some((id) => pairing.looked.has(id))) {
      await settleReviewItems(
        database,
        { kind: item.kind, subjectId: ids[0] ?? "" },
        "Transfer pairing changed",
      );
    }
  }
  for (const [key, item] of wanted) {
    if (open.has(key)) continue;
    await openReviewItem(database, {
      kind: PAIR_KINDS[item.kind],
      subject: {
        type: "transactions",
        transactionIds: [item.pair.outTransactionId, item.pair.inTransactionId],
      },
      decided: DECIDED[item.kind],
      bestAnswer: LINK,
    });
  }
}

// The Matching step: pairs Transfers around each added or changed Transaction, then runs the order
// again for it and for each Transaction whose link began or ended. A hand-set type wins at step 1,
// so the rules never change it. A hidden Transaction loses its result, as it no longer counts.
// Each new result clears the Categories, so the categorization step chooses them again, except
// those a posted Transaction carries over from its pending one. A Transaction decided as a linked
// Transfer whose link has ended since, such as when a Member linked its other side elsewhere, pairs
// and is decided again too.
export async function runMatching(
  database: Database,
  unhandled: readonly string[],
  now = new Date(),
): Promise<void> {
  const unlinked = await listUnlinkedTransferDecisions(database);
  const pairing = await pairTransfers(database, [...unhandled, ...unlinked], now);
  const handled = new Set(unhandled);
  const others = [...new Set([...pairing.changed, ...unlinked])].filter((id) => !handled.has(id));
  const records = await readDecisionRecords(database, [...unhandled, ...others]);
  const shown = records.filter((record) => !record.hidden);
  const pending = await readPendingParts(
    database,
    shown.filter((record) => handled.has(record.id)).map((record) => record.id),
  );
  const gone = records.filter((record) => record.hidden).map((record) => record.id);
  await removeDecisions(database, gone);
  const decided = await decideAll(database, shown, now);
  await storeResults(
    database,
    decided.map((result) => ({
      ...result,
      stored: carryOver(result.stored, pending.get(result.stored.transactionId)),
    })),
    now,
    gone,
  );
  await updatePairItems(database, pairing);
  await tellDecidedAgain(shown.filter((record) => !handled.has(record.id)));
  await decideLoanPaymentsAgain(database, shown, now);
}

// A payout the app sees for the first time may make a loan a Cash loan (spec 02, Connected loans),
// so the payments of each loan whose type the app decides are decided again. A payout is money in
// under a LOAN_DISBURSEMENTS_* code, or the other side of a pair with a loan.
async function decideLoanPaymentsAgain(
  database: Database,
  records: readonly DecisionRecord[],
  now: Date,
): Promise<void> {
  if (!records.some((record) => record.amount > 0)) return;
  const loans = (await listDecisionAccounts(database)).filter(
    (account) => isLoan(account) && account.loanType === null,
  );
  const loanIds = new Set(loans.map((loan) => loan.id));
  const payout = records.some(
    (record) =>
      record.amount > 0 &&
      !loanIds.has(record.accountId) &&
      (record.providerCategory?.startsWith("LOAN_DISBURSEMENTS_") === true ||
        (record.otherSide !== null && loanIds.has(record.otherSide.accountId))),
  );
  if (!payout) return;
  const ids: string[] = [];
  for (const loan of loans) ids.push(...(await listLoanPaymentIds(database, loan.id)));
  const again = (await readDecisionRecords(database, ids)).filter((record) => !record.hidden);
  if (again.length === 0) return;
  await storeResults(database, await decideAll(database, again, now), now);
  await tellDecidedAgain(again);
}

// The daily task: decides again each Transaction whose provisional result ended before the
// Household's today, so the result changes even when no sync brings changes. It makes no AI call.
// Returns how many it decided again.
export async function decideProvisionalAgain(
  database: Database,
  now = new Date(),
): Promise<number> {
  const passed = await listProvisionalPassed(database, await householdToday(database, now));
  const records = await readDecisionRecords(database, passed);
  await storeResults(database, await decideAll(database, records, now), now);
  await tellDecidedAgain(records);
  if (passed.length > 0) log.info("Decided provisional results again", { count: passed.length });
  return passed.length;
}

// A Transfer link's evidence (spec 03, Evidence).
export type TransferLinkEvidence = {
  otherTransactionId: string;
  tier: "Strong" | "Unclear";
  signals: TransferSignal[];
  aiAnswer: "yes" | "no" | null;
  aiConfidence: "high" | "medium" | "low" | null;
  madeBy: "app" | "AI" | "Member";
  uncertain: boolean;
};

// The Transfer link that uses the Transaction, with its evidence, or null.
async function readTransferEvidence(
  database: Database,
  transactionId: string,
): Promise<TransferLinkEvidence | null> {
  const link = await readTransferLink(database, transactionId);
  if (link === undefined) return null;
  return {
    otherTransactionId:
      link.outTransactionId === transactionId ? link.inTransactionId : link.outTransactionId,
    tier: link.tier,
    signals: link.signals as TransferSignal[],
    aiAnswer: link.aiAnswer,
    aiConfidence: link.aiConfidence,
    madeBy: link.madeBy,
    uncertain: link.uncertain,
  };
}

export type TransactionDecision = {
  step: DecisionStep;
  provisionalUntil: string | null;
  parts: Part[];
};

const decisionOf = (stored: StoredDecision): TransactionDecision => ({
  step: stored.step as DecisionStep,
  provisionalUntil: stored.provisionalUntil,
  parts: stored.parts as Part[],
});

// The Transaction's last result, or undefined before Matching has decided it.
export async function readTransactionDecision(
  database: Database,
  transactionId: string,
): Promise<TransactionDecision | undefined> {
  const stored = await readDecision(database, transactionId);
  return stored === undefined ? undefined : decisionOf(stored);
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

// A Member added, edited, closed, or reopened an Account, so each one-sided Transfer may go to
// another account now, such as one whose name it holds. The follow-up job decides them again.
export async function decideOneSidedAgain(database: Database): Promise<void> {
  const ids = await listDecidedAt(database, ONE_SIDED_STEPS);
  if (ids.length === 0) return;
  await followUpAgain(database, ids);
  await followUpSoon();
}

// A Member switches a connected loan's type, or types its APR. The follow-up job decides its
// payments again. Undefined when no connected loan has the ID.
export async function setLoanSettings(
  database: Database,
  accountId: string,
  fields: Partial<LoanFields>,
): Promise<LoanSettings | undefined> {
  if (!(await storeLoanFields(database, accountId, fields))) return undefined;
  const ids = await listLoanPaymentIds(database, accountId);
  if (ids.length > 0) {
    await followUpAgain(database, ids);
    await followUpSoon();
  }
  log.info("A Member set a loan's type or APR", { fields: Object.keys(fields) });
  return readLoanSettings(database, accountId);
}

// A Member sets the type by hand. It wins over every rule and survives every re-run. The follow-up
// job stores the result and pairs the other side of any link again, so Matching never runs beside
// a sync. Returns the result the job stores, or undefined when no Transaction that shows has the
// ID.
export async function setTransactionType(
  database: Database,
  transactionId: string,
  type: HandSetType,
  now = new Date(),
): Promise<TransactionDecision | undefined> {
  const [record] = await readDecisionRecords(database, [transactionId]);
  if (record === undefined || record.hidden) return undefined;
  await database.transaction(async (tx) => {
    await setHandSetFields(tx, transactionId, { type });
    await followUpAgain(tx, [transactionId]);
  });
  await followUpSoon();
  log.info("A Member set a Transaction's type by hand", { type });
  const { hidden, ...updated } = { ...record, handSet: { ...record.handSet, type } };
  const { step, parts, provisionalUntil } = await decide({
    ...updated,
    ...(await decisionContext(database, now)),
  });
  return { step, parts, provisionalUntil: provisionalUntil ?? null };
}

let running: { database: Database } | undefined;

// The daily task's job. It is safe to run twice: a second run finds no provisional result that
// has passed.
export class ProvisionalResultsJob extends Job {
  override async run(): Promise<void> {
    if (running === undefined) throw new Error("Money movement is not running.");
    await decideProvisionalAgain(running.database);
  }
}

// Registers the Matching step and gives the daily task app.db. The start calls it before jobs
// run.
export function startMoneyMovement(options: { database: Database }): { stop(): void } {
  if (running !== undefined) throw new Error("Money movement is already running.");
  const started = { database: options.database };
  running = started;
  const pairOf = (item: ReviewItem): TransferPair => {
    const [outTransactionId, inTransactionId] =
      item.subject.type === "transactions" ? item.subject.transactionIds : [];
    if (outTransactionId === undefined || inTransactionId === undefined) {
      throw new Error("A Transfer pair item is about two Transactions.");
    }
    return { outTransactionId, inTransactionId };
  };
  // Accepting makes a hand-made link. "Not this" acts as an undo: the app never makes that link
  // again. The follow-up job then matches both sides again.
  const pairKind = {
    async otherChoices() {
      return [NOT_THIS];
    },
    async answer(
      item: ReviewItem,
      choice: ReviewChoice,
      answering: { memberId: string; database: Queries },
    ) {
      const at = new Date();
      if (choice.value === LINK.value) {
        await linkTransferByHand(answering.database, pairOf(item), {
          memberId: answering.memberId,
          at,
        });
      } else {
        await refuseTransferLink(answering.database, pairOf(item), {
          refusedBy: "Member",
          memberId: answering.memberId,
          at,
        });
      }
      const pair = pairOf(item);
      await followUpAgain(answering.database, [pair.outTransactionId, pair.inTransactionId]);
    },
    afterAnswer: () => askForFollowUp(),
  };
  const stops = [
    registerFollowUpStep("matching", async (unhandled) => {
      await runMatching(started.database, unhandled);
      return undefined;
    }),
    registerReviewKind(UNCLEAR_PAIR_KIND, pairKind),
    registerReviewKind(PAIR_GUESS_KIND, pairKind),
    registerReviewKind(ONE_SIDED_KIND, oneSidedKind(started.database)),
  ];
  return {
    stop() {
      for (const stop of stops.reverse()) stop();
      if (running === started) running = undefined;
    },
  };
}

// One Transaction that shows, with its last result and its Transfer link's evidence (spec 03,
// Evidence). Undefined when no Transaction that shows has the ID.
export async function readTransactionDetail(database: Database, transactionId: string) {
  const [record] = await readDecisionRecords(database, [transactionId]);
  if (record === undefined || record.hidden) return undefined;
  return {
    transaction: {
      id: record.id,
      accountId: record.accountId,
      amount: record.amount,
      postedDate: record.postedDate,
      authorizedDate: record.authorizedDate,
      pending: record.pending,
      description: record.description,
      merchantName: record.merchantName,
    },
    decision: (await readTransactionDecision(database, transactionId)) ?? null,
    transferLink: await readTransferEvidence(database, transactionId),
  };
}
