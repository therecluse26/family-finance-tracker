import {
  type Database,
  type DecisionRecord,
  listProvisionalPassed,
  readDecision,
  readDecisionRecords,
  removeDecisions,
  type StoredDecision,
  setHandSetFields,
  storeDecisions,
} from "../db/index.ts";
import { registerFollowUpStep } from "../follow-up/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { Job } from "../jobs/index.ts";
import { log } from "../log.ts";
import { type DecisionStep, decide, isHandSetType, type Part } from "./order.ts";
import type { HandSetType } from "./types.ts";

// The Matching follow-up step, the daily task for provisional results, and a hand-set type.

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
  for (const { hidden, decided, decidedAmount, ...record } of records) {
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

// A Transaction whose type a Member set by hand, and whose result still fits its amount. A sync
// that changes the amount needs the hand-set type's one part made again.
const keepsHandSetResult = (record: DecisionRecord) =>
  isHandSetType(record.handSet.type) && record.decided && record.decidedAmount === record.amount;

// The Matching step: runs the order again for each added or changed Transaction, and skips each
// one with a hand-set type. A hidden Transaction loses its result, as it no longer counts.
export async function runMatching(
  database: Database,
  unhandled: readonly string[],
  now = new Date(),
): Promise<void> {
  const records = await readDecisionRecords(database, unhandled);
  await removeDecisions(
    database,
    records.filter((record) => record.hidden).map((record) => record.id),
  );
  const open = records.filter((record) => !record.hidden && !keepsHandSetResult(record));
  await storeDecisions(database, await decideAll(database, open, now));
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
  if (passed.length > 0) log.info("Decided provisional results again", { count: passed.length });
  return passed.length;
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

// A Member sets the type by hand. It wins over every rule and survives every re-run. Undefined
// when no Transaction that shows has the ID.
export async function setTransactionType(
  database: Database,
  transactionId: string,
  type: HandSetType,
  now = new Date(),
): Promise<TransactionDecision | undefined> {
  const [record] = await readDecisionRecords(database, [transactionId]);
  if (record === undefined || record.hidden) return undefined;
  await setHandSetFields(database, transactionId, { type });
  await storeDecisions(
    database,
    await decideAll(database, [{ ...record, handSet: { ...record.handSet, type } }], now),
  );
  log.info("A Member set a Transaction's type by hand", { type });
  return readTransactionDecision(database, transactionId);
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
  const unregister = registerFollowUpStep("matching", async (unhandled) => {
    await runMatching(started.database, unhandled);
    return undefined;
  });
  return {
    stop() {
      unregister();
      if (running === started) running = undefined;
    },
  };
}
