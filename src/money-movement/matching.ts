import {
  type Database,
  type DecisionRecord,
  linkTransferByHand,
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
  setHandSetFields,
  storeDecisions,
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
import { type DecisionStep, decide, type Part } from "./order.ts";
import { type PairingResult, pairTransfers, type TransferSignal } from "./transfers.ts";
import type { HandSetType } from "./types.ts";

// The Matching follow-up step, the daily task for provisional results, a hand-set type, and the
// Review list items for Transfer pairs.

// The Household's date. Until the wizard's step 4 sets the Household time zone, it is the date in
// UTC.
async function householdToday(database: Database, now: Date): Promise<string> {
  return calendarDateIn(now, (await householdTimeZone(database)) ?? "UTC");
}

async function decideAll(
  database: Database,
  records: readonly DecisionRecord[],
  now: Date,
): Promise<StoredDecision[]> {
  const today = await householdToday(database, now);
  const decisions: StoredDecision[] = [];
  for (const { hidden, ...record } of records) {
    const { step, parts, provisionalUntil } = await decide({ ...record, today });
    decisions.push({
      transactionId: record.id,
      step,
      provisionalUntil: provisionalUntil ?? null,
      decidedAt: now,
      parts,
    });
  }
  return decisions;
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
  await removeDecisions(
    database,
    records.filter((record) => record.hidden).map((record) => record.id),
  );
  const decisions = await decideAll(database, shown, now);
  await storeDecisions(
    database,
    decisions.map((decision) => carryOver(decision, pending.get(decision.transactionId))),
  );
  await updatePairItems(database, pairing);
  await tellDecidedAgain(shown.filter((record) => !handled.has(record.id)));
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
  await storeDecisions(database, await decideAll(database, records, now));
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
    today: await householdToday(database, now),
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
