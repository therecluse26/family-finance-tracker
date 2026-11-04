import {
  addDays,
  daysBetween,
  fitsSchedule,
  inWindow,
  isLastDayOfMonth,
  lastActiveDay,
  nextExpected,
  onSchedule,
  type Schedule,
  type SeriesSchedule,
  type TwiceAMonth,
  window,
} from "./schedules.ts";

// Finding, continuing, and reviving Recurring charges (spec 06, Recurring charges), and Income
// series, which use a variant of the same rule (spec 05, Steady Income). The checks replay each
// Merchant's posted Transactions in date order, so a history load and a later sync find the same
// series.

// One posted Transaction of a series. The amount is the whole cents spent, or for Income the whole
// cents received, so it is positive.
export type SeriesTxn = {
  id: string;
  date: string;
  amount: number;
  accountId: string;
  category: string | null;
};

export type Status = "active" | "inactive" | "ended";

// A series the replay found. Its Transactions are in date order.
export type Series<S extends SeriesSchedule = Schedule> = {
  schedule: S;
  txns: SeriesTxn[];
  status: Exclude<Status, "ended">;
};

// How a series is found: the band its amounts stay within, in tenths of a percent, and the new
// series that ends at a Transaction, from the earlier ones that belong to no series.
export type SeriesRule<S extends SeriesSchedule> = {
  band: number;
  newSeries(txn: SeriesTxn, free: readonly SeriesTxn[]): Series<S> | undefined;
};

// Amounts within `percent` of each other: the largest is at most the smallest × (1 + percent).
// Finding a Recurring charge uses 7.5%; a yearly one, and every Income series, uses 15%.
function withinPercent(amounts: readonly number[], tenthsOfPercent: number): boolean {
  const largest = Math.max(...amounts);
  const smallest = Math.min(...amounts);
  return largest * 1000 <= smallest * (1000 + tenthsOfPercent);
}
const BAND = 75;
const WIDE_BAND = 150;

// The fewest Transactions a new series needs.
const FEWEST = { weekly: 3, "every 2 weeks": 3, monthly: 3, yearly: 2 } as const;
const FEWEST_TWICE_A_MONTH = 3;

// Days from the previous Transaction to the next, at least and at most, a little wider than each
// schedule's margin. Only a quick first cut: the window decides.
const DAYS_APART = {
  weekly: [5, 9],
  "every 2 weeks": [12, 16],
  monthly: [26, 34],
  yearly: [330, 400],
} as const;
const DAYS_APART_TWICE_A_MONTH = [8, 23] as const;

// The two fixed days of a twice-a-month schedule are 12 to 18 days apart, such as the 1st and the
// 15th, or the 15th and the last day.
const FIXED_DAYS_APART = [12, 18] as const;

const last = <S extends SeriesSchedule>(series: Series<S>): SeriesTxn => {
  const txn = series.txns.at(-1);
  if (txn === undefined) throw new Error("A series has at least one Transaction.");
  return txn;
};

const isBefore = (a: SeriesTxn, b: SeriesTxn) =>
  a.date < b.date || (a.date === b.date && a.id < b.id);

// The Transaction whose amount is nearest `amount`; on a tie, the earlier one.
function nearest(txns: readonly SeriesTxn[], amount: number): SeriesTxn | undefined {
  let best: SeriesTxn | undefined;
  for (const txn of txns) {
    const gap = Math.abs(txn.amount - amount);
    const bestGap = best === undefined ? Number.POSITIVE_INFINITY : Math.abs(best.amount - amount);
    if (gap < bestGap || (gap === bestGap && best !== undefined && isBefore(txn, best))) best = txn;
  }
  return best;
}

// The longest chain on one schedule that ends at `txn`, from the Transactions before it that
// belong to no series. Each Transaction lands within the schedule's margin from the previous one,
// and every amount is within `band` of the others. `free` is in date order.
function chainEndingAt(
  txn: SeriesTxn,
  free: readonly SeriesTxn[],
  schedule: SeriesSchedule,
  band: number,
): SeriesTxn[] {
  const [fewestDays, mostDays] =
    typeof schedule === "object" ? DAYS_APART_TWICE_A_MONTH : DAYS_APART[schedule];
  const chain = [txn];
  for (let current = txn; ; ) {
    const amounts = chain.map((each) => each.amount);
    const earliest = addDays(current.date, -mostDays);
    const latest = addDays(current.date, -fewestDays);
    const fits: SeriesTxn[] = [];
    for (let at = free.length - 1; at >= 0; at -= 1) {
      const earlier = free[at];
      if (earlier === undefined || earlier.date < earliest) break;
      // The date checks build dates, so they come last.
      if (
        earlier.date <= latest &&
        withinPercent([...amounts, earlier.amount], band) &&
        !chain.includes(earlier) &&
        fitsSchedule(schedule, earlier.date) &&
        inWindow(window(schedule, earlier.date), current.date)
      ) {
        fits.push(earlier);
      }
    }
    const previous = nearest(fits, current.amount);
    if (previous === undefined) return chain;
    chain.unshift(previous);
    current = previous;
  }
}

// The days between each Transaction after the first and the date the schedule expected from the
// one before it, added up.
function daysOff(schedule: SeriesSchedule, chain: readonly SeriesTxn[]): number {
  let total = 0;
  for (const [index, txn] of chain.entries()) {
    const previous = chain[index - 1];
    if (previous !== undefined) {
      total += Math.abs(daysBetween(nextExpected(schedule, previous.date), txn.date));
    }
  }
  return total;
}

// A Recurring charge (spec 06, Finding a series): weekly, every 2 weeks, and monthly need 3
// Transactions within 7.5% of each other; yearly needs 2, within 15%. Shorter schedules are tried
// first.
export const RECURRING_CHARGE_RULE: SeriesRule<Schedule> = {
  band: BAND,
  newSeries(txn, free) {
    for (const schedule of ["weekly", "every 2 weeks", "monthly", "yearly"] as const) {
      const chain = chainEndingAt(txn, free, schedule, schedule === "yearly" ? WIDE_BAND : BAND);
      if (chain.length >= FEWEST[schedule]) return { schedule, txns: chain, status: "active" };
    }
    return undefined;
  },
};

// The twice-a-month schedules whose fixed dates `date` is within the margin of. A date on or near
// the last day of a month also fits the days that month lacks, up to 31.
function twiceAMonthSchedules(date: string): TwiceAMonth[] {
  const near = new Set<number>();
  for (let offset = -2; offset <= 2; offset += 1) {
    const each = addDays(date, offset);
    const day = Number(each.slice(8, 10));
    near.add(day);
    if (isLastDayOfMonth(each))
      for (let lacked = day + 1; lacked <= 31; lacked += 1) near.add(lacked);
  }
  const pairs = new Map<string, TwiceAMonth>();
  const [fewest, most] = FIXED_DAYS_APART;
  for (const day of near) {
    for (let apart = fewest; apart <= most; apart += 1) {
      for (const days of [
        [day, day + apart],
        [day - apart, day],
      ] as const) {
        if (days[0] >= 1 && days[1] <= 31) pairs.set(days.join(" "), { days });
      }
    }
  }
  // Later days first, so a tie keeps them: a chain from February or a 30-day month fits the 28th or
  // the 30th as well as the last day, and only the last day still fits in a 31-day month.
  return [...pairs.values()].sort((a, b) => b.days[1] - a.days[1] || b.days[0] - a.days[0]);
}

// The best twice-a-month chain that ends at `txn`: the one with the most Transactions, then the
// fewest days off its fixed dates.
function twiceAMonthEndingAt(
  txn: SeriesTxn,
  free: readonly SeriesTxn[],
): Series<TwiceAMonth> | undefined {
  // A quick first cut before trying each pair of fixed days: the chain needs an earlier free
  // Transaction about half a month before, within the band.
  const [fewestDays, mostDays] = DAYS_APART_TWICE_A_MONTH;
  const earliest = addDays(txn.date, -mostDays);
  const latest = addDays(txn.date, -fewestDays);
  let previous = false;
  for (let at = free.length - 1; at >= 0 && !previous; at -= 1) {
    const earlier = free[at];
    if (earlier === undefined || earlier.date < earliest) break;
    previous = earlier.date <= latest && withinPercent([txn.amount, earlier.amount], WIDE_BAND);
  }
  if (!previous) return undefined;

  let best: { series: Series<TwiceAMonth>; off: number } | undefined;
  for (const schedule of twiceAMonthSchedules(txn.date)) {
    const chain = chainEndingAt(txn, free, schedule, WIDE_BAND);
    if (chain.length < FEWEST_TWICE_A_MONTH) continue;
    const off = daysOff(schedule, chain);
    if (
      best === undefined ||
      chain.length > best.series.txns.length ||
      (chain.length === best.series.txns.length && off < best.off)
    ) {
      best = { series: { schedule, txns: chain, status: "active" }, off };
    }
  }
  return best?.series;
}

// An Income series (spec 05, Steady Income): the Recurring charge rule with amounts within 15% of
// each other, and a twice-a-month schedule. A series that fits both every 2 weeks and twice a month
// takes the schedule whose expected dates are fewer total days from the actual dates; on a tie,
// every 2 weeks, the one tried first.
export const INCOME_RULE: SeriesRule<SeriesSchedule> = {
  band: WIDE_BAND,
  newSeries(txn, free) {
    const weekly = chainEndingAt(txn, free, "weekly", WIDE_BAND);
    if (weekly.length >= FEWEST.weekly)
      return { schedule: "weekly", txns: weekly, status: "active" };
    const twoWeekly = chainEndingAt(txn, free, "every 2 weeks", WIDE_BAND);
    const twiceAMonth = twiceAMonthEndingAt(txn, free);
    if (twoWeekly.length >= FEWEST["every 2 weeks"]) {
      if (
        twiceAMonth === undefined ||
        daysOff("every 2 weeks", twoWeekly) <= daysOff(twiceAMonth.schedule, twiceAMonth.txns)
      ) {
        return { schedule: "every 2 weeks", txns: twoWeekly, status: "active" };
      }
    }
    if (twiceAMonth !== undefined) return twiceAMonth;
    for (const schedule of ["monthly", "yearly"] as const) {
      const chain = chainEndingAt(txn, free, schedule, WIDE_BAND);
      if (chain.length >= FEWEST[schedule]) return { schedule, txns: chain, status: "active" };
    }
    return undefined;
  },
};

// Replays one Merchant's posted Transactions, oldest first, and returns its series as of `today`.
// Transactions in `claimed` belong to a Recurring charge a Member marked ended: they are left out,
// so later Transactions start a new series.
//
// - An active series continues with a Transaction within the margin of its next expected date, at
//   any amount. When two fit, the one nearest the latest amount continues it.
// - It goes inactive once its last active day passes with no Transaction.
// - An inactive one revives with a later Transaction within the rule's band of the latest amount,
//   within the margin of the last date plus a whole number of intervals.
// - A Transaction that does none of these may end a new series. One Merchant may have more than one
//   series at different amounts, so no new series starts within the band of an active one's latest
//   amount.
export function replayMerchant<S extends SeriesSchedule>(
  txns: readonly SeriesTxn[],
  claimed: ReadonlySet<string>,
  today: string,
  rule: SeriesRule<S>,
): Series<S>[] {
  const ordered = txns
    .filter((txn) => !claimed.has(txn.id))
    .sort((a, b) => (isBefore(a, b) ? -1 : 1));
  const series: Series<S>[] = [];
  const taken = new Set<string>();
  const free: SeriesTxn[] = [];
  const goInactive = (date: string) => {
    for (const each of series) {
      if (each.status === "active" && date > lastActiveDay(each.schedule, last(each).date)) {
        each.status = "inactive";
      }
    }
  };

  for (const [index, txn] of ordered.entries()) {
    if (taken.has(txn.id)) continue;
    goInactive(txn.date);

    // Continuing: each active series whose window holds this Transaction takes the one in its
    // window nearest its latest amount, which may come later.
    const fitting = series
      .filter(
        (each) =>
          each.status === "active" && inWindow(window(each.schedule, last(each).date), txn.date),
      )
      .sort(
        (a, b) => Math.abs(last(a).amount - txn.amount) - Math.abs(last(b).amount - txn.amount),
      );
    let continued = false;
    for (const each of fitting) {
      const range = window(each.schedule, last(each).date);
      const candidates: SeriesTxn[] = [];
      for (const later of ordered.slice(index)) {
        if (later.date > range.to) break;
        if (!taken.has(later.id) && inWindow(range, later.date)) candidates.push(later);
      }
      const pick = nearest(candidates, last(each).amount);
      if (pick === undefined) continue;
      each.txns.push(pick);
      taken.add(pick.id);
      if (pick === txn) {
        continued = true;
        break;
      }
    }
    if (continued) continue;

    // Reviving.
    const revivable = series.filter(
      (each) =>
        each.status === "inactive" &&
        withinPercent([txn.amount, last(each).amount], rule.band) &&
        onSchedule(each.schedule, last(each).date, txn.date),
    );
    const revived = revivable.sort(
      (a, b) => Math.abs(last(a).amount - txn.amount) - Math.abs(last(b).amount - txn.amount),
    )[0];
    if (revived !== undefined) {
      revived.txns.push(txn);
      revived.status = "active";
      taken.add(txn.id);
      continue;
    }

    // Finding a new series.
    const nearActive = series.some(
      (each) =>
        each.status === "active" && withinPercent([txn.amount, last(each).amount], rule.band),
    );
    const found = nearActive ? undefined : rule.newSeries(txn, free);
    if (found !== undefined) {
      series.push(found);
      for (const each of found.txns) taken.add(each.id);
      free.splice(0, free.length, ...free.filter((each) => !taken.has(each.id)));
      continue;
    }
    free.push(txn);
  }
  goInactive(today);
  return series;
}

// A series' facts from its Transactions: the next expected date, the latest amount, and the
// Account and Category of its last Transaction.
export function factsOf(schedule: SeriesSchedule, txns: readonly SeriesTxn[]) {
  const latest = txns.at(-1);
  if (latest === undefined) throw new Error("A series has at least one Transaction.");
  return {
    nextExpectedDate: nextExpected(schedule, latest.date),
    latestAmount: latest.amount,
    accountId: latest.accountId,
    category: latest.category,
  };
}
