import {
  addDays,
  addMonths,
  type ChargeSchedule,
  daysBetween,
  daysOffFixedDay,
  fitsSchedule,
  fixedDayOf,
  inWindow,
  isMonthly,
  type Monthly,
  nextExpected,
  onSchedule,
  type Schedule,
  type SeriesSchedule,
  type TwiceAMonth,
  twiceAMonthDaysOf,
  twiceAMonthSchedulesOf,
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
export type Series<S extends SeriesSchedule = ChargeSchedule> = {
  schedule: S;
  // A twice-a-month series' other pairs of fixed days that its Transactions give as few total days
  // off as its own (twiceAMonthDaysOf). Its next Transaction may land on any of them.
  ties?: readonly TwiceAMonth[];
  txns: SeriesTxn[];
  status: Exclude<Status, "ended">;
};

// How a series is found: the band its amounts stay within, in tenths of a percent, the new series
// that ends at a Transaction, from the earlier ones that belong to no series, and whether a
// frequent shop finds none. With `priceBand`, also in tenths of a percent, a Transaction continues
// a series only within that band of its latest amount, or as a price change (continuedBy). Without
// it, any amount continues a series.
export type SeriesRule<S extends SeriesSchedule> = {
  band: number;
  priceBand?: number;
  newSeries(txn: SeriesTxn, free: readonly SeriesTxn[]): Series<S> | undefined;
  skipsFrequentShops: boolean;
};

// Amounts within `percent` of each other: the largest is at most the smallest × (1 + percent).
// Finding a Recurring charge uses 7.5%; a yearly one, and every Income series, uses 15%. A masked
// Merchant's uses 0%: the same amount to the cent.
function withinPercent(amounts: readonly number[], tenthsOfPercent: number): boolean {
  const largest = Math.max(...amounts);
  const smallest = Math.min(...amounts);
  return largest * 1000 <= smallest * (1000 + tenthsOfPercent);
}
const BAND = 75;
const WIDE_BAND = 150;
const EXACT = 0;

// A frequent shop (spec 06, Finding a series): 3 or more other Transactions at the Merchant from 60
// days before to 60 days after a new series' first Transaction, at any amount.
const FREQUENT_COUNT = 3;
const FREQUENT_DAYS = 60;

// The fewest Transactions a new series needs.
const FEWEST = { weekly: 3, "every 2 weeks": 3, monthly: 3, yearly: 2 } as const;

// The fewest Transactions a Recurring charge on `schedule` is found with. Each later one continues
// it, or revives it.
export const fewestToFind = (schedule: Schedule): number => FEWEST[schedule];
const FEWEST_TWICE_A_MONTH = 3;

// Days from the previous Transaction to the next, at least and at most, a little wider than each
// schedule's margin. Only a quick first cut: the window decides. Monthly expected dates are 28 to
// 31 days apart. Twice a month takes any earlier Transaction in the month before: its expected
// dates are 10 to 19 days apart, the margin with the business-day shift reaches up to 5 days each
// way, and while pairs tie the next Transaction may fit any of them.
const DAYS_APART = {
  weekly: [5, 9],
  "every 2 weeks": [12, 16],
  monthly: [18, 41],
  yearly: [330, 400],
} as const;
const DAYS_APART_TWICE_A_MONTH = [1, 29] as const;

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
  const [fewestDays, mostDays] = isMonthly(schedule)
    ? DAYS_APART.monthly
    : typeof schedule === "object"
      ? DAYS_APART_TWICE_A_MONTH
      : DAYS_APART[schedule];
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

// Whether a free Transaction from `days[1]` to `days[0]` days before `txn` is within `band` of its
// amount: a quick first cut before trying each fixed day. `free` is in date order.
function earlierNear(
  txn: SeriesTxn,
  free: readonly SeriesTxn[],
  [fewestDays, mostDays]: readonly [number, number],
  band: number,
): boolean {
  const earliest = addDays(txn.date, -mostDays);
  const latest = addDays(txn.date, -fewestDays);
  for (let at = free.length - 1; at >= 0; at -= 1) {
    const earlier = free[at];
    if (earlier === undefined || earlier.date < earliest) return false;
    if (earlier.date <= latest && withinPercent([txn.amount, earlier.amount], band)) return true;
  }
  return false;
}

const datesOf = (txns: readonly SeriesTxn[]) => txns.map((txn) => txn.date);

// The fixed day a monthly series' Transactions give it (spec 06, Monthly series).
const monthlyOf = (txns: readonly SeriesTxn[]): Monthly => ({
  fixedDay: fixedDayOf(datesOf(txns)),
});

// The best monthly series that ends at `txn` (spec 06, Monthly series): on each fixed day `txn`
// lands on, the chain of Transactions in the months before it, each within the margin of its
// month's expected date. It takes the chain with the most Transactions, then the fewest days off
// its fixed day, then the earlier day. Undefined under 3 Transactions.
function monthlyEndingAt(
  txn: SeriesTxn,
  free: readonly SeriesTxn[],
  band: number,
): Series<Monthly> | undefined {
  if (!earlierNear(txn, free, DAYS_APART.monthly, band)) return undefined;
  let best: { chain: SeriesTxn[]; off: number } | undefined;
  for (let fixedDay = 1; fixedDay <= 31; fixedDay += 1) {
    const schedule = { fixedDay };
    if (!fitsSchedule(schedule, txn.date)) continue;
    const chain = chainEndingAt(txn, free, schedule, band);
    if (chain.length < FEWEST.monthly) continue;
    const off = daysOffFixedDay(fixedDay, datesOf(chain));
    if (
      best === undefined ||
      chain.length > best.chain.length ||
      (chain.length === best.chain.length && off < best.off)
    ) {
      best = { chain, off };
    }
  }
  if (best === undefined) return undefined;
  return { schedule: monthlyOf(best.chain), txns: best.chain, status: "active" };
}

// A series' fixed days after a Transaction joins it: the ones all its Transactions give. A
// twice-a-month series keeps the pairs that tie with its own.
function refitFixedDays<S extends SeriesSchedule>(series: Series<S>): void {
  if (typeof series.schedule !== "object") return;
  if (isMonthly(series.schedule)) {
    series.schedule = monthlyOf(series.txns) as S;
    return;
  }
  const [pair, ...ties] = twiceAMonthDaysOf(datesOf(series.txns));
  if (pair === undefined) return;
  series.schedule = pair as S;
  series.ties = ties;
}

// The windows of a series' next Transaction: one on its own schedule, and on a twice-a-month
// series' ties.
const nextWindows = <S extends SeriesSchedule>(series: Series<S>) =>
  [series.schedule, ...(series.ties ?? [])].map((schedule) => window(schedule, last(series).date));

type Range = { from: string; to: string };

const inAnyWindow = (ranges: readonly Range[], date: string) =>
  ranges.some((range) => inWindow(range, date));

// From the first date of any of `ranges` to the last date of any.
function spanOf(ranges: readonly Range[]): Range {
  const [first, ...rest] = ranges;
  if (first === undefined) throw new Error("A series has at least one window.");
  let { from, to } = first;
  for (const range of rest) {
    if (range.from < from) from = range.from;
    if (range.to > to) to = range.to;
  }
  return { from, to };
}

// The Transactions in `ordered`, from index `start` on, that land in the windows of a series' next
// Transaction and that `isFree` takes. `ordered` is in date order.
function inNextWindows<S extends SeriesSchedule>(
  series: Series<S>,
  ordered: readonly SeriesTxn[],
  start: number,
  isFree: (txn: SeriesTxn) => boolean,
): SeriesTxn[] {
  const ranges = nextWindows(series);
  const { to } = spanOf(ranges);
  const found: SeriesTxn[] = [];
  for (let at = start; at < ordered.length; at += 1) {
    const later = ordered[at];
    if (later === undefined || later.date > to) break;
    if (isFree(later) && inAnyWindow(ranges, later.date)) found.push(later);
  }
  return found;
}

// The Transactions among `candidates`, those in a series' next windows, that continue it (spec 06,
// Continuing a series): the one nearest its latest amount, at any amount. With a price band, as a
// masked Merchant's series has, only one within the band of the latest amount continues it. Else a
// price change may: one outside the band joins when the series' next expected date after it has a
// Transaction within the band of its own amount, and that one joins too. So a price change needs 2
// charges in a row on expected dates, and one in the series' last charge waits for the next.
// `nextAfter` gives the Transactions in a series' next windows after one of its own. Neither charge of
// a price change may be one that `ownedByOther` says another active series takes at its own amount.
// `latest` is the amount a Transaction is judged against: the latest amount, or a Member's price
// change after it.
function continuedBy<S extends SeriesSchedule>(
  series: Series<S>,
  candidates: readonly SeriesTxn[],
  priceBand: number | undefined,
  nextAfter: (series: Series<S>, txn: SeriesTxn) => readonly SeriesTxn[],
  ownedByOther: (txn: SeriesTxn) => boolean,
  latest = last(series).amount,
): SeriesTxn[] {
  const withinOf = (amount: number) => (txn: SeriesTxn) =>
    priceBand === undefined || withinPercent([txn.amount, amount], priceBand);
  const pick = nearest(candidates.filter(withinOf(latest)), latest);
  if (pick !== undefined || priceBand === undefined) return pick === undefined ? [] : [pick];
  const free = (txn: SeriesTxn) => !ownedByOther(txn);
  const confirmed = new Map<SeriesTxn, SeriesTxn>();
  for (const changed of candidates.filter(free)) {
    const trial = { ...series, txns: [...series.txns, changed] };
    refitFixedDays(trial);
    const next = nearest(
      nextAfter(trial, changed).filter(withinOf(changed.amount)).filter(free),
      changed.amount,
    );
    if (next !== undefined) confirmed.set(changed, next);
  }
  const changed = nearest([...confirmed.keys()], latest);
  const next = changed === undefined ? undefined : confirmed.get(changed);
  return changed === undefined || next === undefined ? [] : [changed, next];
}

// The Transactions that the active series in `all` other than `series` take at their own amounts,
// within `priceBand`: each one's next charge and the one after it. A price change in `series` never
// takes these, so 2 series of a masked Merchant on the same days keep their own charges (spec 06,
// A masked Merchant's series). Read once, on the first call.
function chargesOfOthers<S extends SeriesSchedule>(
  series: Series<S>,
  all: readonly Series<S>[],
  ordered: readonly SeriesTxn[],
  isFree: (txn: SeriesTxn) => boolean,
  priceBand: number,
): (txn: SeriesTxn) => boolean {
  let owned: Set<SeriesTxn> | undefined;
  const windowFrom = (each: Series<S>) => firstOnOrAfter(ordered, spanOf(nextWindows(each)).from);
  return (txn) => {
    if (owned === undefined) {
      owned = new Set();
      for (const other of all) {
        if (other === series || other.status !== "active") continue;
        const amount = last(other).amount;
        const atAmount = (later: SeriesTxn) => withinPercent([later.amount, amount], priceBand);
        const pick = nearest(
          inNextWindows(other, ordered, windowFrom(other), isFree).filter(atAmount),
          amount,
        );
        if (pick === undefined) continue;
        owned.add(pick);
        const trial = { ...other, txns: [...other.txns, pick] };
        refitFixedDays(trial);
        const then = nearest(
          inNextWindows(
            trial,
            ordered,
            windowFrom(trial),
            (later) => isFree(later) && isBefore(pick, later),
          ).filter(atAmount),
          amount,
        );
        if (then !== undefined) owned.add(then);
      }
    }
    return owned.has(txn);
  };
}

// A Recurring charge (spec 06, Finding a series): weekly, every 2 weeks, and monthly need 3
// Transactions within 7.5% of each other; yearly needs 2, within 15%. Shorter schedules are tried
// first. A frequent shop never forms one.
export const RECURRING_CHARGE_RULE: SeriesRule<ChargeSchedule> = {
  band: BAND,
  skipsFrequentShops: true,
  newSeries(txn, free) {
    for (const schedule of ["weekly", "every 2 weeks"] as const) {
      const chain = chainEndingAt(txn, free, schedule, BAND);
      if (chain.length >= FEWEST[schedule]) return { schedule, txns: chain, status: "active" };
    }
    const monthly = monthlyEndingAt(txn, free, BAND);
    if (monthly !== undefined) return monthly;
    const yearly = chainEndingAt(txn, free, "yearly", WIDE_BAND);
    if (yearly.length >= FEWEST.yearly)
      return { schedule: "yearly", txns: yearly, status: "active" };
    return undefined;
  },
};

// A masked Merchant's Recurring charge, such as one at Privacy.com (spec 06, A masked Merchant's
// series): the Merchant hides many shops, so it ignores the frequent-shop rule and matches only
// exact cents. A new series needs its first 3 Transactions at the same amount to the cent, on any
// schedule, the yearly one too. A Transaction then continues or revives it only at its latest
// amount to the cent, or as a price change: 2 charges in a row at one new amount.
export const MASKED_CHARGE_RULE: SeriesRule<ChargeSchedule> = {
  band: EXACT,
  priceBand: EXACT,
  skipsFrequentShops: false,
  newSeries(txn, free) {
    for (const schedule of ["weekly", "every 2 weeks"] as const) {
      const chain = chainEndingAt(txn, free, schedule, EXACT);
      if (chain.length >= FEWEST[schedule]) return { schedule, txns: chain, status: "active" };
    }
    const monthly = monthlyEndingAt(txn, free, EXACT);
    if (monthly !== undefined) return monthly;
    const yearly = chainEndingAt(txn, free, "yearly", EXACT);
    if (yearly.length >= MASKED_FEWEST_YEARLY) {
      return { schedule: "yearly", txns: yearly, status: "active" };
    }
    return undefined;
  },
};
const MASKED_FEWEST_YEARLY = 3;

// Amounts within 7.5% of each other, the band a new Recurring charge's amounts stay within.
export const withinChargeBand = (amounts: readonly number[]) => withinPercent(amounts, BAND);

// The earlier Transactions that make a weekly, 2-week, or monthly schedule with `txn`: each lands
// one interval before it, within the margin, and within 7.5% of its amount. The yearly schedule
// never counts here (spec 06, New Recurring charge). `earlier` is in date order. Each one comes
// once, with the shortest schedule it fits. A monthly pair lands on one fixed day in two months in
// a row, and takes the fixed day the two give. A masked Merchant's pair is at the same amount to the
// cent, as its new series are (MASKED_CHARGE_RULE).
export function earlierOnSchedule(
  txn: SeriesTxn,
  earlier: readonly SeriesTxn[],
  options: { masked: boolean } = { masked: false },
): { txn: SeriesTxn; schedule: ChargeSchedule }[] {
  const band = options.masked ? EXACT : BAND;
  const found: { txn: SeriesTxn; schedule: ChargeSchedule }[] = [];
  const earliest = addDays(txn.date, -DAYS_APART.monthly[1]);
  for (let at = earlier.length - 1; at >= 0; at -= 1) {
    const each = earlier[at];
    if (each === undefined || each.date < earliest) break;
    if (!isBefore(each, txn) || each.date === txn.date) continue;
    if (!withinPercent([txn.amount, each.amount], band)) continue;
    const schedule =
      (["weekly", "every 2 weeks"] as const).find((one) =>
        inWindow(window(one, each.date), txn.date),
      ) ?? monthlyPair(each, txn);
    if (schedule !== undefined) found.push({ txn: each, schedule });
  }
  return found.reverse();
}

// The monthly schedule of `earlier` and `later` when they land on one fixed day in two months in a
// row.
function monthlyPair(earlier: SeriesTxn, later: SeriesTxn): Monthly | undefined {
  for (let fixedDay = 1; fixedDay <= 31; fixedDay += 1) {
    const schedule = { fixedDay };
    if (
      fitsSchedule(schedule, earlier.date) &&
      inWindow(window(schedule, earlier.date), later.date)
    ) {
      return monthlyOf([earlier, later]);
    }
  }
  return undefined;
}

// The best twice-a-month chain that ends at `txn`: the one with the most Transactions, then the
// fewest days off its fixed dates.
function twiceAMonthEndingAt(
  txn: SeriesTxn,
  free: readonly SeriesTxn[],
): Series<TwiceAMonth> | undefined {
  // A quick first cut before trying each pair of fixed days: the chain needs an earlier free
  // Transaction about half a month before, within the band.
  if (!earlierNear(txn, free, DAYS_APART_TWICE_A_MONTH, WIDE_BAND)) return undefined;

  let best: { series: Series<TwiceAMonth>; off: number } | undefined;
  for (const schedule of twiceAMonthSchedulesOf(txn.date)) {
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
  if (best !== undefined) refitFixedDays(best.series);
  return best?.series;
}

// The days off a twice-a-month series' Transactions are from its fixed dates: the fewest of its
// own pair and the pairs that tie with it.
const twiceAMonthOff = (series: Series<TwiceAMonth>): number =>
  Math.min(...[series.schedule, ...(series.ties ?? [])].map((pair) => daysOff(pair, series.txns)));

// An Income series (spec 05, Steady Income): the Recurring charge rule with amounts within 15% of
// each other, and a twice-a-month schedule. A series that fits both every 2 weeks and twice a month
// takes the schedule whose expected dates are fewer total days from the actual dates; on a tie,
// every 2 weeks, the one tried first. Twice a month counts its best pair among those that tie.
export const INCOME_RULE: SeriesRule<SeriesSchedule> = {
  band: WIDE_BAND,
  skipsFrequentShops: false,
  newSeries(txn, free) {
    const weekly = chainEndingAt(txn, free, "weekly", WIDE_BAND);
    if (weekly.length >= FEWEST.weekly)
      return { schedule: "weekly", txns: weekly, status: "active" };
    const twoWeekly = chainEndingAt(txn, free, "every 2 weeks", WIDE_BAND);
    const twiceAMonth = twiceAMonthEndingAt(txn, free);
    if (twoWeekly.length >= FEWEST["every 2 weeks"]) {
      if (
        twiceAMonth === undefined ||
        daysOff("every 2 weeks", twoWeekly) <= twiceAMonthOff(twiceAMonth)
      ) {
        return { schedule: "every 2 weeks", txns: twoWeekly, status: "active" };
      }
    }
    if (twiceAMonth !== undefined) return twiceAMonth;
    const monthly = monthlyEndingAt(txn, free, WIDE_BAND);
    if (monthly !== undefined) return monthly;
    const yearly = chainEndingAt(txn, free, "yearly", WIDE_BAND);
    if (yearly.length >= FEWEST.yearly)
      return { schedule: "yearly", txns: yearly, status: "active" };
    return undefined;
  },
};

// The first index in `ordered`, which is in date order, dated on or after `date`.
function firstOnOrAfter(ordered: readonly SeriesTxn[], date: string): number {
  let low = 0;
  let high = ordered.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((ordered[middle]?.date ?? "") < date) low = middle + 1;
    else high = middle;
  }
  return low;
}

// The later Transactions in `ordered` that `found` would continue with, through `through`, as the
// replay continues a series: each lands in the window of the one before, as continuedBy picks it
// under `priceBand`. Those in `taken` belong to another series.
function continuing(
  found: Series<SeriesSchedule>,
  ordered: readonly SeriesTxn[],
  taken: ReadonlySet<string>,
  through: string,
  priceBand: number | undefined,
): Set<SeriesTxn> {
  const joined = new Set<SeriesTxn>();
  const series = { ...found, txns: [...found.txns] };
  const after = (earlier: SeriesTxn) => (later: SeriesTxn) =>
    isBefore(earlier, later) && !taken.has(later.id) && !found.txns.includes(later);
  const windowFrom = (each: Series<SeriesSchedule>) =>
    firstOnOrAfter(ordered, spanOf(nextWindows(each)).from);
  for (;;) {
    if (spanOf(nextWindows(series)).from > through) return joined;
    const candidates = inNextWindows(series, ordered, windowFrom(series), after(last(series)));
    const picks = continuedBy(
      series,
      candidates,
      priceBand,
      (trial, changed) => inNextWindows(trial, ordered, windowFrom(trial), after(changed)),
      () => false,
    );
    const [pick] = picks;
    if (pick === undefined || pick.date > through) return joined;
    for (const each of picks) joined.add(each);
    series.txns.push(...picks);
    refitFixedDays(series);
  }
}

// Days on each side of the frequent-shop window that the check for another subscription also
// reads: enough for a monthly chain of 3 that has a Transaction in the window.
const CHAIN_DAYS = 70;

// Each Transaction's series when the Merchant is replayed without the frequent-shop check.
type ChainOf = ReadonlyMap<SeriesTxn, readonly SeriesTxn[]>;

// Whether `found` is at a frequent shop: 3 or more of the Merchant's Transactions fall from 60 days
// before to 60 days after its first Transaction, outside the series. The series is its Transactions
// and the later ones it would continue with. Looking after the first Transaction too means a
// shop's series cannot form at the start of a history, where nothing comes before.
//
// Another subscription at the Merchant is not a visit, so one Merchant can still have two Recurring
// charges: the Transactions of another series the replay found are left out, and so are those of a
// series the rule finds without this check (`chains`) that has 2 or more Transactions from 70 days
// before the window to 70 days after it, at a steady amount. A shop's chance chains continue at any
// amount, or show one Transaction there (a yearly chain), so they still count. Two series at one amount never run at once (replayMerchant), so a daily coffee at one price
// still counts. `ordered` is in date order.
function atFrequentShop<S extends SeriesSchedule>(
  ordered: readonly SeriesTxn[],
  found: Series<S>,
  taken: ReadonlySet<string>,
  rule: SeriesRule<S>,
  chains: () => ChainOf,
): boolean {
  const first = found.txns[0];
  if (first === undefined) return false;
  const from = addDays(first.date, -FREQUENT_DAYS);
  const to = addDays(first.date, FREQUENT_DAYS);
  const inSeries = new Set([
    ...found.txns,
    ...continuing(found, ordered, taken, to, rule.priceBand),
  ]);
  const visits: SeriesTxn[] = [];
  for (let at = firstOnOrAfter(ordered, from); at < ordered.length; at += 1) {
    const each = ordered[at];
    if (each === undefined || each.date > to) break;
    if (!inSeries.has(each) && !taken.has(each.id)) visits.push(each);
  }
  if (visits.length < FREQUENT_COUNT) return false;

  const chainOf = chains();
  const earliest = addDays(from, -CHAIN_DAYS);
  const latest = addDays(to, CHAIN_DAYS);
  const steady = new Map<readonly SeriesTxn[], boolean>();
  const isSteady = (chain: readonly SeriesTxn[]) => {
    const known = steady.get(chain);
    if (known !== undefined) return known;
    const amounts: number[] = [];
    for (let at = firstOnOrAfter(chain, earliest); at < chain.length; at += 1) {
      const each = chain[at];
      if (each === undefined || each.date > latest) break;
      amounts.push(each.amount);
    }
    const result = amounts.length >= 2 && withinPercent(amounts, rule.band);
    steady.set(chain, result);
    return result;
  };
  let others = 0;
  for (const each of visits) {
    const chain = chainOf.get(each);
    if (chain === undefined || !isSteady(chain)) others += 1;
    if (others >= FREQUENT_COUNT) return true;
  }
  return false;
}

// Whether `txn` is in a yearly chain whose price is its own at the Merchant: another Transaction
// 11 to 13 months before or after it, within 15% of its amount, and no other Transaction in the
// year from one to the other within 15% of it. A yearly plan's price shows up once a year; a
// monthly bill whose amount moves repeats amounts within 15% across its months. Whether a chain is
// price-unique does not depend on which series the rule finds. Those in `taken` belong to another
// series and pair with nothing here. `ordered` is in date order and `txn` is `ordered[index]`.
//
// Only the nearest Transaction within 15% on each side can be its mate: any other has that one
// between them.
function inPriceUniqueYear(
  ordered: readonly SeriesTxn[],
  index: number,
  taken: ReadonlySet<string>,
): boolean {
  const txn = ordered[index];
  if (txn === undefined) return false;
  const near = (each: SeriesTxn) => withinPercent([each.amount, txn.amount], WIDE_BAND);
  const unique = (earlier: SeriesTxn, later: SeriesTxn) => {
    for (let at = firstOnOrAfter(ordered, earlier.date); at < ordered.length; at += 1) {
      const each = ordered[at];
      if (each === undefined || each.date > later.date) break;
      if (each !== earlier && each !== later && near(each)) return false;
    }
    return true;
  };
  const pairs = (mate: SeriesTxn) => {
    if (taken.has(mate.id)) return false;
    const [earlier, later] = isBefore(mate, txn) ? [mate, txn] : [txn, mate];
    return inWindow(window("yearly", earlier.date), later.date) && unique(earlier, later);
  };
  const from = addMonths(txn.date, -13);
  for (let at = index - 1; at >= 0; at -= 1) {
    const mate = ordered[at];
    if (mate === undefined || mate.date < from) break;
    if (near(mate)) {
      if (pairs(mate)) return true;
      break;
    }
  }
  const to = window("yearly", txn.date).to;
  for (let at = index + 1; at < ordered.length; at += 1) {
    const mate = ordered[at];
    if (mate === undefined || mate.date > to) break;
    if (near(mate)) return pairs(mate);
  }
  return false;
}

// Whether a yearly `found` has 3 or more of the Merchant's other Transactions between its two, at
// any amount (spec 06, Finding a series). The Transactions of another series do not count: those
// in `taken`, and those in a price-unique yearly chain (inPriceUniqueYear). A frequent shop or a
// monthly bill whose amount moves visits often in a year; yearly subscriptions do not. `ordered` is
// in date order.
function crowdedYear(
  ordered: readonly SeriesTxn[],
  found: Series<SeriesSchedule>,
  taken: ReadonlySet<string>,
): boolean {
  const first = found.txns[0];
  const end = found.txns.at(-1);
  if (found.schedule !== "yearly" || first === undefined || end === undefined) return false;
  const inSeries = new Set(found.txns);
  let others = 0;
  for (let at = firstOnOrAfter(ordered, addDays(first.date, 1)); at < ordered.length; at += 1) {
    const each = ordered[at];
    if (each === undefined || each.date >= end.date) break;
    if (inSeries.has(each) || taken.has(each.id)) continue;
    if (!inPriceUniqueYear(ordered, at, taken)) others += 1;
    if (others >= FREQUENT_COUNT) return true;
  }
  return false;
}

// Replays one Merchant's posted Transactions, oldest first, and returns its series as of `today`.
// Transactions in `claimed` belong to a Recurring charge a Member marked ended: they are left out,
// so later Transactions start a new series.
//
// - An active series continues with a Transaction within the margin of its next expected date, at
//   any amount. When two fit, the one nearest the latest amount continues it. Under a rule with a
//   price band, as a masked Merchant's, only within the band, or with a price change (continuedBy).
// - It goes inactive once its last active day passes with no Transaction.
// - An inactive one revives with a later Transaction within the rule's band of the latest amount,
//   within the margin of the last date plus a whole number of intervals.
// - A monthly series' fixed day is worked out again from all its Transactions each time one joins,
//   so it stays the one its stored price history gives. So are a twice-a-month series' two fixed
//   days: while other pairs tie with its own, a Transaction within the margin of any of them
//   continues or revives it, and then the pair is picked again (spec 05, Steady Income).
// - A Transaction that does none of these may end a new series. One Merchant may have more than one
//   series at different amounts, so no new series starts within the band of an active one's latest
//   amount. Under the Recurring charge rule, no new series starts at a frequent shop: 3 or more
//   other Transactions at the Merchant from 60 days before to 60 days after its first Transaction,
//   at any amount (atFrequentShop). Nor does a yearly one with 3 or more other Transactions between
//   its two (crowdedYear).
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
  // Replayed once, and only when a frequent-shop check needs it.
  let chainOf: Map<SeriesTxn, readonly SeriesTxn[]> | undefined;
  const chains = () => {
    if (chainOf === undefined) {
      chainOf = new Map();
      const plain = { ...rule, skipsFrequentShops: false };
      for (const each of replayMerchant(ordered, new Set(), today, plain)) {
        for (const txn of each.txns) chainOf.set(txn, each.txns);
      }
    }
    return chainOf;
  };
  const goInactive = (date: string) => {
    for (const each of series) {
      if (each.status === "active" && date > spanOf(nextWindows(each)).to) {
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
      .filter((each) => each.status === "active" && inAnyWindow(nextWindows(each), txn.date))
      .sort(
        (a, b) => Math.abs(last(a).amount - txn.amount) - Math.abs(last(b).amount - txn.amount),
      );
    let continued = false;
    for (const each of fitting) {
      const isFree = (later: SeriesTxn) => !taken.has(later.id);
      const candidates = inNextWindows(each, ordered, index, isFree);
      const picks = continuedBy(
        each,
        candidates,
        rule.priceBand,
        (trial, changed) =>
          inNextWindows(
            trial,
            ordered,
            firstOnOrAfter(ordered, spanOf(nextWindows(trial)).from),
            (later) => isFree(later) && isBefore(changed, later),
          ),
        rule.priceBand === undefined
          ? () => false
          : chargesOfOthers(each, series, ordered, isFree, rule.priceBand),
      );
      if (picks.length === 0) continue;
      each.txns.push(...picks);
      refitFixedDays(each);
      for (const pick of picks) taken.add(pick.id);
      if (picks.includes(txn)) {
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
        [each.schedule, ...(each.ties ?? [])].some((schedule) =>
          onSchedule(schedule, last(each).date, txn.date),
        ),
    );
    const revived = revivable.sort(
      (a, b) => Math.abs(last(a).amount - txn.amount) - Math.abs(last(b).amount - txn.amount),
    )[0];
    if (revived !== undefined) {
      revived.txns.push(txn);
      refitFixedDays(revived);
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
    if (
      found !== undefined &&
      !(
        rule.skipsFrequentShops &&
        (crowdedYear(ordered, found, taken) || atFrequentShop(ordered, found, taken, rule, chains))
      )
    ) {
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

// A Member's price change (spec 06, Member edits): a new amount, in whole cents, from a date.
export type PriceChange = { fromDate: string; amount: number };

// The amount a Transaction on `date` is judged against: a Member's price change in force on that
// date that starts on or after the series' last Transaction, else the last Transaction's amount. So
// a price change counts as a charge at its amount on its start date. `changes` is by start date.
export function amountOn(
  txns: readonly SeriesTxn[],
  changes: readonly PriceChange[],
  date: string,
): number {
  const latest = txns.at(-1);
  if (latest === undefined) throw new Error("A series has at least one Transaction.");
  const change = changes.findLast((each) => each.fromDate <= date);
  return change !== undefined && change.fromDate >= latest.date ? change.amount : latest.amount;
}

// The price changes in a series' Transactions, as the page marks them: each one outside `band`, in
// tenths of a percent, of the amount it was judged against. `changes` are a Member's, by start date.
export function priceChangesIn(
  txns: readonly SeriesTxn[],
  band: number,
  changes: readonly PriceChange[] = [],
): PriceChange[] {
  const found: PriceChange[] = [];
  for (const [index, txn] of txns.entries()) {
    if (index === 0) continue;
    const judged = amountOn(txns.slice(0, index), changes, txn.date);
    if (!withinPercent([txn.amount, judged], band)) {
      found.push({ fromDate: txn.date, amount: txn.amount });
    }
  }
  return found;
}

// A Recurring charge a Member edited (spec 06, Member edits): its schedule, the Transactions that
// stay in it, the Member's price changes by start date, and the Member's price band in tenths of a
// percent, if any.
export type KeptCharge = {
  schedule: ChargeSchedule;
  members: readonly SeriesTxn[];
  priceChanges: readonly PriceChange[];
  band: number | undefined;
};

// Continues a Recurring charge a Member edited, through `today`, as the replay continues a series
// (replayMerchant), with these differences. Its Transactions stay, in date order, and an expected
// date that has one of them takes no other. Each other Transaction in `candidates` may fill an
// expected date with none, or revive it, judged against the amount in force on its date
// (amountOn): within the Member's band; else, once it has a Member's price change, within the
// rule's band; else as the rule continues. A price change of 2 in a row still joins outside the
// band. `candidates` are the Merchant's Transactions in no other Recurring charge, and none a
// Member removed from this one.
export function continueKept(
  kept: KeptCharge,
  candidates: readonly SeriesTxn[],
  today: string,
  rule: SeriesRule<ChargeSchedule>,
): Series<ChargeSchedule> {
  const members = [...kept.members].sort((a, b) => (isBefore(a, b) ? -1 : 1));
  const [first] = members;
  if (first === undefined) throw new Error("A Recurring charge has at least one Transaction.");
  const isMember = new Set(members);
  const ordered = [...members, ...candidates].sort((a, b) => (isBefore(a, b) ? -1 : 1));
  const continueBand =
    kept.band ?? (kept.priceChanges.length > 0 ? (rule.priceBand ?? rule.band) : rule.priceBand);
  const reviveBand = kept.band ?? rule.band;
  const series: Series<ChargeSchedule> = {
    schedule: kept.schedule,
    txns: [first],
    status: "active",
  };
  refitFixedDays(series);
  const taken = new Set<SeriesTxn>([first]);
  const free = (txn: SeriesTxn) => !taken.has(txn) && !isMember.has(txn);
  const goInactive = (date: string) => {
    if (series.status === "active" && date > spanOf(nextWindows(series)).to) {
      series.status = "inactive";
    }
  };
  const join = (txns: readonly SeriesTxn[]) => {
    series.txns.push(...txns);
    series.txns.sort((a, b) => (isBefore(a, b) ? -1 : 1));
    for (const txn of txns) taken.add(txn);
    refitFixedDays(series);
    series.status = "active";
  };

  for (const [index, txn] of ordered.entries()) {
    if (taken.has(txn) || isBefore(txn, first)) continue;
    goInactive(txn.date);
    if (isMember.has(txn)) {
      join([txn]);
      continue;
    }
    const judged = amountOn(series.txns, kept.priceChanges, txn.date);
    if (series.status === "active") {
      if (!inAnyWindow(nextWindows(series), txn.date)) continue;
      const own = (later: SeriesTxn) => isMember.has(later) && !taken.has(later);
      if (inNextWindows(series, ordered, index, own).length > 0) continue;
      const picks = continuedBy(
        series,
        inNextWindows(series, ordered, index, free),
        continueBand,
        (trial, changed) =>
          inNextWindows(
            trial,
            ordered,
            firstOnOrAfter(ordered, spanOf(nextWindows(trial)).from),
            (later) => free(later) && isBefore(changed, later),
          ),
        () => false,
        judged,
      );
      if (picks.length > 0) join(picks);
      continue;
    }
    const latest = last(series);
    if (
      withinPercent([txn.amount, judged], reviveBand) &&
      onSchedule(series.schedule, latest.date, txn.date)
    ) {
      join([txn]);
    }
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
