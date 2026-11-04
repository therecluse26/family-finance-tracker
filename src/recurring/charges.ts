import {
  type Database,
  endRecurringCharge,
  listPostedSpending,
  listRecurringCharges,
  replaceRecurringCharges,
  type StoredRecurringCharge,
} from "../db/index.ts";
import { registerFollowUpStep } from "../follow-up/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { log } from "../log.ts";
import { type Merchant, merchantKey } from "../merchants/index.ts";
import { lastActiveDay, type Schedule } from "./schedules.ts";
import { factsOf, replayMerchant, type SpendingTxn, type Status } from "./series.ts";

// The Recurring charge checks (spec 06, Recurring charges; When checks run). They run in the
// follow-up job's checks step, after Matching and Categorization, on posted Transactions only. Each
// run finds every Recurring charge again from posted Spending, so those a history load brings are
// Recurring charges at once, and a removed Transaction leaves its series. A Recurring charge a
// Member marked ended never changes again.

export type RecurringCharge = {
  id: string;
  merchant: Merchant;
  category: string | null;
  schedule: Schedule;
  nextExpectedDate: string;
  // Whole cents spent.
  latestAmount: number;
  // Each Transaction's posted date and amount in whole cents spent, oldest first.
  priceHistory: { transactionId: string; date: string; amount: number }[];
  // The Account its last Transaction landed on.
  accountId: string;
  status: Status;
};

// The Household's date. Until the wizard's step 4 sets the Household time zone, it is the date in
// UTC.
async function householdToday(database: Database, now: Date): Promise<string> {
  return calendarDateIn(now, (await householdTimeZone(database)) ?? "UTC");
}

// The Transactions of one Merchant, as identity knows it: by the provider's Merchant ID when the
// Transaction has one, else by clean name.
const groupOf = (merchant: Merchant) =>
  merchant.id === null ? `name ${merchantKey(merchant.name)}` : `id ${merchant.id}`;

// Finds every Recurring charge again, and stores them in place of the ones not marked ended. A
// Recurring charge that keeps one of its Transactions keeps its ID.
export async function findRecurringCharges(database: Database, now = new Date()): Promise<void> {
  const today = await householdToday(database, now);
  const stored = await listRecurringCharges(database);
  const ended = stored.filter((charge) => charge.status === "ended");
  const claimed = new Set(
    ended.flatMap((charge) => charge.priceHistory.map((entry) => entry.transactionId)),
  );
  const earlier = new Map<string, StoredRecurringCharge>();
  for (const charge of stored) {
    if (charge.status === "ended") continue;
    for (const entry of charge.priceHistory) earlier.set(entry.transactionId, charge);
  }

  const merchants = new Map<string, { merchant: Merchant; txns: SpendingTxn[] }>();
  for (const row of await listPostedSpending(database)) {
    if (row.merchantCleanName === null || row.spending >= 0) continue;
    const merchant = { id: row.merchantId, name: row.merchantCleanName };
    if (merchant.id === null && merchantKey(merchant.name) === "") continue;
    const key = groupOf(merchant);
    const group = merchants.get(key) ?? { merchant, txns: [] };
    group.merchant = merchant;
    group.txns.push({
      id: row.id,
      date: row.postedDate,
      amount: -row.spending,
      accountId: row.accountId,
      category: row.category,
    });
    merchants.set(key, group);
  }

  const kept = new Set<string>();
  const charges: StoredRecurringCharge[] = [];
  for (const { merchant, txns } of merchants.values()) {
    for (const series of replayMerchant(txns, claimed, today)) {
      const previous = series.txns
        .map((txn) => earlier.get(txn.id))
        .find((charge) => charge !== undefined && !kept.has(charge.id));
      if (previous !== undefined) kept.add(previous.id);
      charges.push({
        id: previous?.id ?? crypto.randomUUID(),
        merchantId: merchant.id,
        merchantName: merchant.name,
        schedule: series.schedule,
        ...factsOf(series.schedule, series.txns),
        priceHistory: series.txns.map((txn) => ({
          transactionId: txn.id,
          date: txn.date,
          amount: txn.amount,
        })),
        status: series.status,
        foundAt: previous?.foundAt ?? now,
        endedAt: null,
        endedBy: null,
      });
    }
  }
  await replaceRecurringCharges(database, charges);
  log.info("Found Recurring charges", {
    active: charges.filter((charge) => charge.status === "active").length,
    inactive: charges.filter((charge) => charge.status === "inactive").length,
  });
}

// The status on `today`: an active Recurring charge whose last active day has passed since the
// last checks is inactive.
function statusOn(charge: StoredRecurringCharge, today: string): Status {
  const last = charge.priceHistory.at(-1);
  if (charge.status !== "active" || last === undefined) return charge.status;
  return today > lastActiveDay(charge.schedule, last.date) ? "inactive" : "active";
}

function chargeOf(stored: StoredRecurringCharge, today: string): RecurringCharge {
  return {
    id: stored.id,
    merchant: { id: stored.merchantId, name: stored.merchantName },
    category: stored.category,
    schedule: stored.schedule,
    nextExpectedDate: stored.nextExpectedDate,
    latestAmount: stored.latestAmount,
    priceHistory: stored.priceHistory,
    accountId: stored.accountId,
    status: statusOn(stored, today),
  };
}

// Every Recurring charge, by next expected date, with its status on the Household's today.
export async function recurringCharges(
  database: Database,
  now = new Date(),
): Promise<RecurringCharge[]> {
  const today = await householdToday(database, now);
  return (await listRecurringCharges(database)).map((stored) => chargeOf(stored, today));
}

// A Member marks a Recurring charge ended. It never comes back by itself: later Transactions from
// that Merchant start a new series. Undefined when no Recurring charge has the ID.
export async function endCharge(
  database: Database,
  id: string,
  memberId: string,
  now = new Date(),
): Promise<RecurringCharge | undefined> {
  const ended = await endRecurringCharge(database, id, { memberId, at: now });
  if (ended === undefined) return undefined;
  log.info("A Member marked a Recurring charge ended");
  return chargeOf(ended, await householdToday(database, now));
}

// Registers the checks step. The start calls it before jobs run.
export function startRecurringCharges(options: { database: Database; now?: () => Date }): {
  stop(): void;
} {
  const { database, now = () => new Date() } = options;
  const stop = registerFollowUpStep("recurring charge and anomaly checks", async () => {
    await findRecurringCharges(database, now());
    return undefined;
  });
  return { stop };
}
