import {
  type Database,
  listIncomeSeries,
  listPostedIncome,
  readTypedSteadyIncome,
  replaceIncomeSeries,
  type StoredIncomeSeries,
  storeTypedSteadyIncome,
  sumIncomeByMonth,
} from "../db/index.ts";
import { log } from "../log.ts";
import { type Merchant, merchantKey } from "../merchants/index.ts";
import { groupOf, householdToday } from "./merchant-days.ts";
import { addMonths, lastActiveDay, nextExpected, type SeriesSchedule } from "./schedules.ts";
import { factsOf, INCOME_RULE, replayMerchant, type SeriesTxn } from "./series.ts";

// Steady Income (spec 05, Steady Income): the Household's regular Income per month, from repeating
// Income series. The checks step finds the series after each sync. The figure and the paydays are
// worked out from them on the Household's today, each time they are read.

export type IncomeSchedule = StoredIncomeSeries["schedule"];

// What one month of each schedule holds.
const FACTORS: Record<IncomeSchedule, number> = {
  weekly: 52 / 12,
  "every 2 weeks": 26 / 12,
  "twice a month": 2,
  monthly: 1,
};

// How long back a series must have Income to count, and how many complete months the fallback
// median covers.
const RECENT_MONTHS = 3;

export type IncomeSeries = {
  id: string;
  payer: Merchant;
  schedule: IncomeSchedule;
  // A twice-a-month series' two fixed days of the month. 31 is the last day of every month.
  fixedDays: [number, number] | null;
  nextExpectedDate: string;
  // Whole cents received.
  latestAmount: number;
  // Each Transaction's posted date and amount in whole cents received, oldest first.
  history: { transactionId: string; date: string; amount: number }[];
  accountId: string;
  status: "active" | "inactive";
};

// A predicted payday: a counted series' next expected date, at its latest amount.
export type Payday = {
  payer: Merchant;
  schedule: IncomeSchedule;
  // A twice-a-month series' two fixed days of the month.
  fixedDays: [number, number] | null;
  date: string;
  amount: number;
};

export type SteadyIncome = {
  // I, in whole cents per month: the typed figure while a Member has one, else the detected one.
  amount: number;
  detected: number;
  // "Income series" when at least one series counts. Otherwise "median": the median of total
  // Income over the last 3 complete months.
  detectedFrom: "Income series" | "median";
  typed: number | null;
};

const storedSchedule = (schedule: Exclude<SeriesSchedule, "yearly">) =>
  typeof schedule === "object"
    ? { schedule: "twice a month" as const, fixedDays: [...schedule.days] as [number, number] }
    : { schedule, fixedDays: null };

// Finds every Income series again from posted Income on checking and savings Accounts, grouped by
// payer, and stores them in place of the earlier ones. Yearly series never count, so they are not
// stored.
export async function findIncomeSeries(database: Database, now = new Date()): Promise<void> {
  const today = await householdToday(database, now);
  const payers = new Map<string, { payer: Merchant; txns: SeriesTxn[] }>();
  for (const row of await listPostedIncome(database)) {
    if (row.merchantCleanName === null || row.income <= 0) continue;
    const payer = { id: row.merchantId, name: row.merchantCleanName };
    if (payer.id === null && merchantKey(payer.name) === "") continue;
    const key = groupOf(payer);
    const group = payers.get(key) ?? { payer, txns: [] };
    group.payer = payer;
    group.txns.push({
      id: row.id,
      date: row.postedDate,
      amount: row.income,
      accountId: row.accountId,
      category: null,
    });
    payers.set(key, group);
  }

  const found: StoredIncomeSeries[] = [];
  for (const { payer, txns } of payers.values()) {
    for (const series of replayMerchant(txns, new Set(), today, INCOME_RULE)) {
      const { schedule } = series;
      if (schedule === "yearly") continue;
      const { nextExpectedDate, latestAmount, accountId } = factsOf(schedule, series.txns);
      found.push({
        id: crypto.randomUUID(),
        merchantId: payer.id,
        merchantName: payer.name,
        ...storedSchedule(schedule),
        nextExpectedDate,
        latestAmount,
        history: series.txns.map((txn) => ({
          transactionId: txn.id,
          date: txn.date,
          amount: txn.amount,
        })),
        accountId,
        status: series.status,
      });
    }
  }
  await replaceIncomeSeries(database, found);
  log.info("Found Income series", {
    active: found.filter((series) => series.status === "active").length,
    inactive: found.filter((series) => series.status === "inactive").length,
  });
}

function scheduleOf(stored: Pick<StoredIncomeSeries, "schedule" | "fixedDays">): SeriesSchedule {
  if (stored.schedule !== "twice a month") return stored.schedule;
  if (stored.fixedDays === null) throw new Error("A twice-a-month series has two fixed days.");
  return { days: stored.fixedDays };
}

// The status on `today`: an active series whose last active day has passed since the last checks
// is inactive.
function seriesOf(stored: StoredIncomeSeries, today: string): IncomeSeries {
  const last = stored.history.at(-1);
  const lapsed = last !== undefined && today > lastActiveDay(scheduleOf(stored), last.date);
  return {
    id: stored.id,
    payer: { id: stored.merchantId, name: stored.merchantName },
    schedule: stored.schedule,
    fixedDays: stored.fixedDays,
    nextExpectedDate: stored.nextExpectedDate,
    latestAmount: stored.latestAmount,
    history: stored.history,
    accountId: stored.accountId,
    status: stored.status === "active" && !lapsed ? "active" : "inactive",
  };
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? 0) + upper) / 2;
};

// Whole dollars, in cents, as the spec's example gives I.
const wholeDollars = (cents: number) => Math.max(0, Math.round(cents / 100) * 100);

// The first day of `today`'s month.
const monthStart = (today: string) => `${today.slice(0, 7)}-01`;

// The series that count on `today`, each with its Income in the last 3 months: active, with at
// least one Transaction in that time. Yearly series are never stored, so they never count.
async function countedSeries(
  database: Database,
  today: string,
): Promise<{ series: IncomeSeries; recent: number[] }[]> {
  const since = addMonths(today, -RECENT_MONTHS);
  return (await listIncomeSeries(database))
    .map((stored) => seriesOf(stored, today))
    .filter((series) => series.status === "active")
    .map((series) => ({
      series,
      recent: series.history
        .filter((entry) => since < entry.date && entry.date <= today)
        .map((entry) => entry.amount),
    }))
    .filter(({ recent }) => recent.length > 0);
}

// I, as detected: the sum, over counted series, of each one's median amount in the last 3 months
// times its schedule's factor. Income outside every series is left out. With no counted series, I
// is the median of total Income over the last 3 complete months.
async function detectedSteadyIncome(
  database: Database,
  today: string,
): Promise<Pick<SteadyIncome, "detected" | "detectedFrom">> {
  const counted = await countedSeries(database, today);
  if (counted.length > 0) {
    const total = counted.reduce(
      (sum, { series, recent }) => sum + median(recent) * FACTORS[series.schedule],
      0,
    );
    return { detected: wholeDollars(total), detectedFrom: "Income series" };
  }
  const to = monthStart(today);
  const from = addMonths(to, -RECENT_MONTHS);
  const totals = await sumIncomeByMonth(database, { from, to });
  const months = [3, 2, 1].map((back) => addMonths(to, -back).slice(0, 7));
  return {
    detected: wholeDollars(median(months.map((month) => totals.get(month) ?? 0))),
    detectedFrom: "median",
  };
}

// Steady Income on the Household's today. A typed figure replaces the detected one.
export async function steadyIncome(database: Database, now = new Date()): Promise<SteadyIncome> {
  const today = await householdToday(database, now);
  const detected = await detectedSteadyIncome(database, today);
  const typed = (await readTypedSteadyIncome(database))?.amount ?? null;
  return { amount: typed ?? detected.detected, ...detected, typed };
}

// A Member types a Steady Income figure in whole cents per month, or with null clears it.
export async function typeSteadyIncome(
  database: Database,
  amount: number | null,
  memberId: string,
  now = new Date(),
): Promise<SteadyIncome> {
  await storeTypedSteadyIncome(
    database,
    amount === null ? null : { amount, typedAt: now, typedBy: memberId },
  );
  log.info(
    amount === null
      ? "A Member cleared the typed Steady Income"
      : "A Member typed a Steady Income figure",
  );
  return steadyIncome(database, now);
}

// Each counted series' next payday, from its schedule, at its latest amount, by date.
export async function paydays(database: Database, now = new Date()): Promise<Payday[]> {
  const today = await householdToday(database, now);
  return (await countedSeries(database, today))
    .map(({ series }) => ({
      payer: series.payer,
      schedule: series.schedule,
      fixedDays: series.fixedDays,
      date: series.nextExpectedDate,
      amount: series.latestAmount,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// The payday one interval after `date`, on the series' own schedule.
export function paydayAfter(payday: Payday, date: string): string {
  return nextExpected(scheduleOf(payday), date);
}
