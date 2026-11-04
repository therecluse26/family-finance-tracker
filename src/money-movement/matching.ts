import {
  type Database,
  type DecisionAccount,
  type DecisionRecord,
  type LoanFields,
  linkTransferByHand,
  listAccountTransactionIds,
  listDecidedAt,
  listDecisionAccounts,
  listLoanPaymentIds,
  listMemberNames,
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
  setAccountExcluded,
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
  openReviewItemBatch,
  openReviewItems,
  type ReviewChoice,
  type ReviewItem,
  registerReviewKind,
  settleReviewItems,
} from "../review/index.ts";
import {
  findManualLoanPayments,
  MISSED_PAYMENT_KIND,
  missedPaymentKind,
  POSSIBLE_PAYMENT_KIND,
  possiblePaymentKind,
  updateMissedLoanPayments,
} from "./loan-payments.ts";
import { isLoan, type LoanSettings, loanFactsReader, readLoanSettings } from "./loans.ts";
import { linkManualLoanPayouts, manualLoanFactsReader } from "./manual-loans.ts";
import { ONE_SIDED_KIND, ONE_SIDED_STEPS, oneSidedKind } from "./one-sided.ts";
import {
  type Decision,
  type DecisionContext,
  type DecisionStep,
  decide,
  type Part,
} from "./order.ts";
import { endBrokenOtherLinks, readOtherLinkEvidence } from "./other-links.ts";
import { linkRefunds, readSpendingAllocations, reducingIds } from "./refunds.ts";
import {
  MONEY_FROM_PERSON_KIND,
  moneyFromPersonKind,
  updateMoneyFromPersonItems,
} from "./reimbursements.ts";
import { isSplit, readSplit, type SplitPart } from "./splits.ts";
import { type PairingResult, pairTransfers, type TransferSignal } from "./transfers.ts";
import type { HandSetType } from "./types.ts";
import {
  loanPayoutsReader,
  UNTRACKED_LOAN_KIND,
  untrackedLoanKind,
  updateUntrackedLoanItems,
} from "./untracked-loans.ts";

// The Matching follow-up step, the daily task for provisional results, a hand-set type, and the
// Review list items for Transfer pairs.

// The Household's date. Until the wizard's step 4 sets the Household time zone, it is the date in
// UTC.
async function householdToday(database: Database, now: Date): Promise<string> {
  return calendarDateIn(now, (await householdTimeZone(database)) ?? "UTC");
}

// The paying sides of Unclear pairs with a connected loan: those this run's pairing asks about,
// and those open on the Review list whose Transactions it did not look at.
async function unclearLoanPayments(
  database: Database,
  accounts: ReadonlyMap<string, DecisionAccount>,
  pairing: PairingResult | undefined,
): Promise<Set<string>> {
  if (![...accounts.values()].some(isLoan)) return new Set();
  const pairs: TransferPair[] = (pairing?.items ?? [])
    .filter((item) => item.kind === "unclear")
    .map((item) => item.pair);
  for (const item of await openReviewItems(database)) {
    if (item.kind !== UNCLEAR_PAIR_KIND || item.subject.type !== "transactions") continue;
    const [outTransactionId, inTransactionId] = item.subject.transactionIds;
    if (outTransactionId === undefined || inTransactionId === undefined) continue;
    if (pairing?.looked.has(outTransactionId) || pairing?.looked.has(inTransactionId)) continue;
    pairs.push({ outTransactionId, inTransactionId });
  }
  if (pairs.length === 0) return new Set();
  const onLoan = new Set(
    (await readDecisionRecords(database, [...new Set(pairs.map((pair) => pair.inTransactionId))]))
      .filter((record) => !record.hidden && isLoan(accounts.get(record.accountId)))
      .map((record) => record.id),
  );
  return new Set(
    pairs.filter((pair) => onLoan.has(pair.inTransactionId)).map((pair) => pair.outTransactionId),
  );
}

// What the order reads besides each Transaction, read once a run for the records it decides. A
// Matching run passes its pairing, which the Review list does not show yet.
async function decisionContext(
  database: Database,
  now: Date,
  records: readonly DecisionRecord[],
  pairing?: PairingResult,
): Promise<DecisionContext> {
  const today = await householdToday(database, now);
  const accounts = new Map(
    (await listDecisionAccounts(database)).map((account) => [account.id, account]),
  );
  const members = await listMemberNames(database);
  return {
    today,
    accounts,
    members,
    loanFacts: loanFactsReader(database, accounts),
    manualLoanFacts: manualLoanFactsReader(database),
    loanPayouts: loanPayoutsReader(database),
    unclearLoanPayments: await unclearLoanPayments(database, accounts, pairing),
    spendingAllocations: await readSpendingAllocations(database, records),
  };
}

// A result to store, with the Unconnected account it goes to and the Review list item it asks
// for.
type Decided = {
  stored: StoredDecision;
  unconnectedAccountId: string | null;
  asks: Decision["asks"];
  offersManualLoan: Decision["offersManualLoan"];
};

async function decideAll(
  database: Database,
  records: readonly DecisionRecord[],
  now: Date,
  pairing?: PairingResult,
): Promise<Decided[]> {
  const context = await decisionContext(database, now, records, pairing);
  const decided: Decided[] = [];
  for (const { hidden, ...record } of records) {
    const { step, parts, provisionalUntil, unconnectedAccountId, asks, offersManualLoan } =
      await decide({
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
      offersManualLoan,
    });
  }
  return decided;
}

// Opens a one-sided Transfer item for each result that asks for one, and settles each open item
// whose Transaction no longer asks for it, or now asks with another best answer. `gone` are
// Transactions that no longer show. The open items are read once, and settled in one batch.
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
  const settled = gone.filter((id) => open.has(id));
  const asked: { id: string; asks: NonNullable<Decision["asks"]> }[] = [];
  for (const { stored, asks } of decided) {
    const id = stored.transactionId;
    const item = open.get(id);
    if (item !== undefined && item.bestAnswer.value === asks?.bestAnswer.value) continue;
    if (item !== undefined) settled.push(id);
    if (asks !== undefined) asked.push({ id, asks });
  }
  await settleReviewItems(database, { kind: ONE_SIDED_KIND, subjectIds: settled }, "decided again");
  await openReviewItemBatch(
    database,
    asked.map(({ id, asks }) => ({
      kind: ONE_SIDED_KIND,
      subject: { type: "transactions", transactionIds: [id] },
      ...asks,
    })),
  );
  if (asked.length > 0) {
    log.info("One-sided Transfers went on the Review list", { opened: asked.length });
  }
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
  await updateMoneyFromPersonItems(
    database,
    decided.map((result) => result.stored),
    gone,
  );
  await updateUntrackedLoanItems(
    database,
    decided.flatMap((result) => (result.offersManualLoan ? [result.offersManualLoan] : [])),
    decided.map((result) => result.stored.transactionId),
    gone,
  );
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
    // A split part's Category is the Member's own.
    if (part.categorySource !== undefined && part.categorySource !== null) return part;
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
// Returns the paying side of each Unclear pair item it settled.
async function updatePairItems(database: Database, pairing: PairingResult): Promise<string[]> {
  const wanted = new Map(
    pairing.items.map((item) => [
      `${PAIR_KINDS[item.kind]} ${item.pair.outTransactionId} ${item.pair.inTransactionId}`,
      item,
    ]),
  );
  const open = new Set<string>();
  const settled = new Map<string, string[]>(Object.values(PAIR_KINDS).map((kind) => [kind, []]));
  for (const item of await openReviewItems(database)) {
    const settling = settled.get(item.kind);
    if (settling === undefined || item.subject.type !== "transactions") continue;
    const ids = item.subject.transactionIds;
    const key = `${item.kind} ${ids.join(" ")}`;
    if (wanted.has(key)) open.add(key);
    else if (ids.some((id) => pairing.looked.has(id))) settling.push(ids[0] ?? "");
  }
  for (const [kind, subjectIds] of settled) {
    await settleReviewItems(database, { kind, subjectIds }, "Transfer pairing changed");
  }
  const unclear = settled.get(UNCLEAR_PAIR_KIND) ?? [];
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
  return unclear;
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
  const relinked = [
    ...(await endBrokenOtherLinks(database, unhandled)),
    ...(await linkManualLoanPayouts(database, unhandled, now)),
  ];
  const pairing = await pairTransfers(database, [...unhandled, ...unlinked, ...relinked], now);
  const handled = new Set(unhandled);
  // The paying side of an Unclear pair counts nowhere while the pair waits, when the other side is
  // a connected loan, so it is decided again too.
  const asked = pairing.items
    .filter((item) => item.kind === "unclear")
    .map((item) => item.pair.outTransactionId);
  const others = [...new Set([...pairing.changed, ...unlinked, ...relinked, ...asked])].filter(
    (id) => !handled.has(id),
  );
  const records = await readDecisionRecords(database, [...unhandled, ...others]);
  const shown = records.filter((record) => !record.hidden);
  const pending = await readPendingParts(
    database,
    shown.filter((record) => handled.has(record.id)).map((record) => record.id),
  );
  const gone = records.filter((record) => record.hidden).map((record) => record.id);
  await removeDecisions(database, gone);
  const decided = await decideAll(database, shown, now, pairing);
  const withCarried = (results: readonly Decided[]) =>
    results.map((result) => ({
      ...result,
      stored: carryOver(result.stored, pending.get(result.stored.transactionId)),
    }));
  await storeResults(database, withCarried(decided), now, gone);
  // Refunds link at once, to Spending that is now decided (spec 03, Refunds), and so do the
  // payments the app finds for a Manual loan (spec 02, Finding payments). Each Refund and
  // Reimbursement on Spending that this run decided, or that a link of this run reduces, is
  // decided again, as the amount its link reduces may have changed; so is every payment on a loan
  // whose links changed, as its interest counts from the balance the ones before it left. This
  // includes a Refund or Reimbursement this run decided too: it read its Spending's parts before
  // they were stored.
  const steps = shown.map((record, index) => ({ record, step: decided[index]?.stored.step ?? "" }));
  const linked = await linkRefunds(database, steps, now);
  const paid = await findManualLoanPayments(database, steps, now);
  const reducing = await reducingIds(database, [...shown.map((record) => record.id), ...linked]);
  const reduced = (
    await readDecisionRecords(database, [...new Set([...reducing, ...linked, ...paid])])
  ).filter((record) => !record.hidden);
  if (reduced.length > 0) {
    await storeResults(database, withCarried(await decideAll(database, reduced, now)), now);
  }
  const settled = await updatePairItems(database, pairing);
  const told = new Set<string>();
  await tellDecidedAgain(
    [...shown, ...reduced].filter((record) => {
      if (handled.has(record.id) || told.has(record.id)) return false;
      told.add(record.id);
      return true;
    }),
  );
  await decideSettledPairsAgain(
    database,
    settled.filter((id) => !shown.some((record) => record.id === id)),
    now,
  );
  await decideLoanPaymentsAgain(database, shown, now);
  await updateLoanPaymentItems(database, records, paid, now);
}

// A payment the Review list asks about settles once it links to a Manual loan or no longer shows.
// When this run changed a loan's links, its missed-payment item may settle too. Only the daily task
// opens one.
async function updateLoanPaymentItems(
  database: Database,
  records: readonly DecisionRecord[],
  paid: readonly string[],
  now: Date,
): Promise<void> {
  const settled = records
    .filter((record) => record.hidden || record.loanLink !== null)
    .map((record) => record.id);
  if (settled.length > 0) {
    await settleReviewItems(
      database,
      { kind: POSSIBLE_PAYMENT_KIND, subjectIds: settled },
      "linked, or no longer shows",
    );
  }
  if (paid.length > 0 || records.some((record) => record.loanLink !== null)) {
    await updateMissedLoanPayments(database, now, "settle");
  }
}

// An Unclear pair that settled without a link leaves its paying side to count again on its own.
async function decideSettledPairsAgain(
  database: Database,
  ids: readonly string[],
  now: Date,
): Promise<void> {
  if (ids.length === 0) return;
  const again = (await readDecisionRecords(database, ids)).filter((record) => !record.hidden);
  if (again.length === 0) return;
  await storeResults(database, await decideAll(database, again, now), now);
  await tellDecidedAgain(again);
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
  id: string;
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
    id: link.id,
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
export async function followUpSoon(): Promise<void> {
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

// The steps whose result depends on the Household's Accounts: a card payment's card, and each
// one-sided Transfer's account.
const ACCOUNT_STEPS = ["5.1", ...ONE_SIDED_STEPS];

// A Member turns an Account's Exclude switch on or off (spec 02, Exclude). Matching and totals run
// again over all history: the follow-up job pairs the Account's own Transactions again, with the
// other side of each of their links, and decides them again with every result that depends on the
// Accounts. Totals add up the new results. Returns false when no Account has the ID.
export async function switchExclude(
  database: Database,
  accountId: string,
  excluded: boolean,
): Promise<boolean> {
  const changed = await database.transaction(async (tx) => {
    const result = await setAccountExcluded(tx, accountId, excluded);
    if (result !== "changed") return result;
    const ids = [
      ...(await listAccountTransactionIds(tx, accountId)),
      ...(await listDecidedAt(tx, ACCOUNT_STEPS)),
    ];
    await followUpAgain(tx, [...new Set(ids)]);
    return result;
  });
  if (changed === "not found") return false;
  if (changed === "changed") {
    await followUpSoon();
    log.info("A Member switched an Account's Exclude", { excluded });
  }
  return true;
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
    ...(await decisionContext(database, now, [record])),
  });
  return { step, parts, provisionalUntil: provisionalUntil ?? null };
}

export type SplitResult =
  | { outcome: "split"; decision: TransactionDecision }
  | { outcome: "not found" }
  | { outcome: "not Spending" }
  | { outcome: "wrong total" };

// A Member splits a Spending Transaction by amount across Categories (spec 04, Splits). The parts,
// in whole cents spent, add up to the Transaction's amount. The split replaces any earlier one. It
// makes no Category rule. The follow-up job stores the result, as for a type set by hand, and the
// links that use the Transaction stay as they are. Returns the result the job stores. "Not found"
// when no Transaction that shows has the ID; "not Spending" when the Transaction is not Spending
// now, such as a Transfer or money in.
export async function splitTransaction(
  database: Database,
  transactionId: string,
  split: readonly SplitPart[],
  now = new Date(),
): Promise<SplitResult> {
  const [record] = await readDecisionRecords(database, [transactionId]);
  if (record === undefined || record.hidden) return { outcome: "not found" };
  const parts = split.map(({ amount, category }) => ({ amount, category }));
  const { hidden, ...updated } = { ...record, handSet: { ...record.handSet, split: parts } };
  const decided = await decide({
    ...updated,
    ...(await decisionContext(database, now, [record])),
  });
  if (!isSplit(decided)) return { outcome: "not Spending" };
  if (parts.reduce((sum, part) => sum + part.amount, 0) !== -record.amount) {
    return { outcome: "wrong total" };
  }
  await database.transaction(async (tx) => {
    await setHandSetFields(tx, transactionId, { split: parts });
    await followUpAgain(tx, [transactionId]);
  });
  await followUpSoon();
  log.info("A Member split a Transaction", { parts: parts.length });
  const { step, parts: decidedParts, provisionalUntil } = decided;
  return {
    outcome: "split",
    decision: { step, parts: decidedParts, provisionalUntil: provisionalUntil ?? null },
  };
}

// A Member removes a split. The Transaction goes back to the cascade. Returns false when no
// Transaction that shows has the ID and a split.
export async function removeSplit(database: Database, transactionId: string): Promise<boolean> {
  const [record] = await readDecisionRecords(database, [transactionId]);
  if (record === undefined || record.hidden || readSplit(record.handSet) === undefined) {
    return false;
  }
  await database.transaction(async (tx) => {
    await setHandSetFields(tx, transactionId, { split: undefined });
    await followUpAgain(tx, [transactionId]);
  });
  await followUpSoon();
  log.info("A Member removed a split");
  return true;
}

let running: { database: Database } | undefined;

// The daily task's job. It is safe to run twice: a second run finds no provisional result that
// has passed.
export class ProvisionalResultsJob extends Job {
  override async run(): Promise<void> {
    if (running === undefined) throw new Error("Money movement is not running.");
    await decideProvisionalAgain(running.database);
    await updateMissedLoanPayments(running.database, new Date());
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
      const ended: string[] = [];
      if (choice.value === LINK.value) {
        const made = await linkTransferByHand(answering.database, pairOf(item), {
          memberId: answering.memberId,
          at,
        });
        ended.push(...made.ended);
      } else {
        await refuseTransferLink(answering.database, pairOf(item), {
          refusedBy: "Member",
          memberId: answering.memberId,
          at,
        });
      }
      const pair = pairOf(item);
      await followUpAgain(answering.database, [
        pair.outTransactionId,
        pair.inTransactionId,
        ...ended,
      ]);
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
    registerReviewKind(UNTRACKED_LOAN_KIND, untrackedLoanKind),
    registerReviewKind(POSSIBLE_PAYMENT_KIND, {
      ...possiblePaymentKind,
      afterAnswer: () => askForFollowUp(),
    }),
    registerReviewKind(MISSED_PAYMENT_KIND, missedPaymentKind),
    registerReviewKind(MONEY_FROM_PERSON_KIND, moneyFromPersonKind(started.database)),
  ];
  return {
    stop() {
      for (const stop of stops.reverse()) stop();
      if (running === started) running = undefined;
    },
  };
}

// One Transaction that shows, with its last result and its links' evidence (spec 03, Evidence).
// Undefined when no Transaction that shows has the ID.
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
    otherLinks: await readOtherLinkEvidence(database, transactionId),
  };
}
