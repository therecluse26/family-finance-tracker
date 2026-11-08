import {
  type Database,
  endRecurringCharge,
  listPostedSpending,
  listRecurringCharges,
  replaceRecurringCharges,
  type StoredRecurringCharge,
} from "../db/index.ts";
import { registerFollowUpStep } from "../follow-up/index.ts";
import { log } from "../log.ts";
import { isMaskedMerchant, type Merchant, merchantKey } from "../merchants/index.ts";
import { findIncomeSeries } from "./income.ts";
import { groupOf, householdToday } from "./merchant-days.ts";
import {
  type ChargeSchedule,
  fixedDayOf,
  lastActiveDay,
  type Schedule,
  scheduleName,
} from "./schedules.ts";
import {
  factsOf,
  MASKED_CHARGE_RULE,
  RECURRING_CHARGE_RULE,
  replayMerchant,
  type SeriesTxn,
  type Status,
} from "./series.ts";

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
  // A monthly one's fixed day of the month (spec 06, Monthly series), from its price history. 31
  // is the last day of every month. Null on the other schedules.
  fixedDay: number | null;
  nextExpectedDate: string;
  // Whole cents spent.
  latestAmount: number;
  // Each Transaction's posted date and amount in whole cents spent, oldest first.
  priceHistory: { transactionId: string; date: string; amount: number }[];
  // The Account its last Transaction landed on.
  accountId: string;
  status: Status;
};

const INTEREST_AND_FEES = "Interest and fees";

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

  const merchants = new Map<string, { merchant: Merchant; txns: SeriesTxn[] }>();
  // Spending in Interest and fees never forms a Recurring charge (spec 06, Finding a series): card
  // interest and fees send the Card interest or fee Alert, and loan interest is a part of a loan
  // payment.
  for (const row of await listPostedSpending(database, { exceptCategory: INTEREST_AND_FEES })) {
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
    // A masked Merchant's series match only exact cents (spec 06, A masked Merchant's series).
    const rule = isMaskedMerchant(merchant) ? MASKED_CHARGE_RULE : RECURRING_CHARGE_RULE;
    for (const series of replayMerchant(txns, claimed, today, rule)) {
      const previous = series.txns
        .map((txn) => earlier.get(txn.id))
        .find((charge) => charge !== undefined && !kept.has(charge.id));
      if (previous !== undefined) kept.add(previous.id);
      charges.push({
        id: previous?.id ?? crypto.randomUUID(),
        merchantId: merchant.id,
        merchantName: merchant.name,
        schedule: scheduleName(series.schedule),
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

// The schedule a Recurring charge's dates follow: a monthly one's from its fixed day. Every caller
// of the next expected date and the last active day reads it.
export function chargeSchedule(
  charge: Pick<RecurringCharge, "schedule" | "fixedDay">,
): ChargeSchedule {
  if (charge.schedule !== "monthly") return charge.schedule;
  if (charge.fixedDay === null) throw new Error("A monthly Recurring charge has a fixed day.");
  return { fixedDay: charge.fixedDay };
}

// The status on `today`: an active Recurring charge whose last active day has passed since the
// last checks is inactive.
function statusOn(charge: RecurringCharge, today: string): Status {
  const last = charge.priceHistory.at(-1);
  if (charge.status !== "active" || last === undefined) return charge.status;
  return today > lastActiveDay(chargeSchedule(charge), last.date) ? "inactive" : "active";
}

function chargeOf(stored: StoredRecurringCharge, today: string): RecurringCharge {
  const charge: RecurringCharge = {
    id: stored.id,
    merchant: { id: stored.merchantId, name: stored.merchantName },
    category: stored.category,
    schedule: stored.schedule,
    fixedDay:
      stored.schedule === "monthly"
        ? fixedDayOf(stored.priceHistory.map((entry) => entry.date))
        : null,
    nextExpectedDate: stored.nextExpectedDate,
    latestAmount: stored.latestAmount,
    priceHistory: stored.priceHistory,
    accountId: stored.accountId,
    status: stored.status,
  };
  return { ...charge, status: statusOn(charge, today) };
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

// Registers the checks step, which finds the Recurring charges, then the Income series behind
// Steady Income, after each sync (spec 05, Steady Income). The start calls it before jobs run.
export function startRecurringCharges(options: { database: Database; now?: () => Date }): {
  stop(): void;
} {
  const { database, now = () => new Date() } = options;
  const stop = registerFollowUpStep("recurring charge checks", async () => {
    await findRecurringCharges(database, now());
    await findIncomeSeries(database, now());
    return undefined;
  });
  return { stop };
}
