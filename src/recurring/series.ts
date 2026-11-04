import {
  addDays,
  inWindow,
  lastActiveDay,
  nextExpected,
  onSchedule,
  type Schedule,
  window,
} from "./schedules.ts";

// Finding, continuing, and reviving Recurring charges (spec 06, Recurring charges). The checks
// replay each Merchant's posted Spending in date order, so a history load and a later sync find
// the same Recurring charges.

// One posted Spending Transaction. The amount is the whole cents spent, so it is positive.
export type SpendingTxn = {
  id: string;
  date: string;
  amount: number;
  accountId: string;
  category: string | null;
};

export type Status = "active" | "inactive" | "ended";

// A series the replay found. Its Transactions are in date order.
export type Series = { schedule: Schedule; txns: SpendingTxn[]; status: Exclude<Status, "ended"> };

// Amounts within `percent` of each other: the largest is at most the smallest × (1 + percent).
// Finding a series uses 7.5%; a yearly one uses 15%.
function withinPercent(amounts: readonly number[], tenthsOfPercent: number): boolean {
  const largest = Math.max(...amounts);
  const smallest = Math.min(...amounts);
  return largest * 1000 <= smallest * (1000 + tenthsOfPercent);
}
const BAND = 75;
const YEARLY_BAND = 150;

// The fewest Transactions a new series needs.
const FEWEST = { weekly: 3, "every 2 weeks": 3, monthly: 3, yearly: 2 } as const;

// Days from the previous Transaction to the next, at least and at most, a little wider than each
// schedule's margin. Only a quick first cut: the window decides.
const DAYS_APART = {
  weekly: [5, 9],
  "every 2 weeks": [12, 16],
  monthly: [26, 34],
  yearly: [330, 400],
} as const;

const last = (series: Series): SpendingTxn => {
  const txn = series.txns.at(-1);
  if (txn === undefined) throw new Error("A Recurring charge has at least one Transaction.");
  return txn;
};

const isBefore = (a: SpendingTxn, b: SpendingTxn) =>
  a.date < b.date || (a.date === b.date && a.id < b.id);

// The Transaction whose amount is nearest `amount`; on a tie, the earlier one.
function nearest(txns: readonly SpendingTxn[], amount: number): SpendingTxn | undefined {
  let best: SpendingTxn | undefined;
  for (const txn of txns) {
    const gap = Math.abs(txn.amount - amount);
    const bestGap = best === undefined ? Number.POSITIVE_INFINITY : Math.abs(best.amount - amount);
    if (gap < bestGap || (gap === bestGap && best !== undefined && isBefore(txn, best))) best = txn;
  }
  return best;
}

// A new series that ends at `txn`, from the Transactions before it that belong to no series. Each
// Transaction lands within the schedule's margin from the previous one. Weekly, every 2 weeks, and
// monthly need 3 Transactions within 7.5% of each other; yearly needs 2, within 15%. Shorter
// schedules are tried first.
// `free` is in date order.
function newSeriesEndingAt(txn: SpendingTxn, free: readonly SpendingTxn[]): Series | undefined {
  for (const schedule of ["weekly", "every 2 weeks", "monthly", "yearly"] as const) {
    const band = schedule === "yearly" ? YEARLY_BAND : BAND;
    const [fewestDays, mostDays] = DAYS_APART[schedule];
    const chain = [txn];
    for (let current = txn; ; ) {
      const amounts = chain.map((each) => each.amount);
      const earliest = addDays(current.date, -mostDays);
      const latest = addDays(current.date, -fewestDays);
      const fits: SpendingTxn[] = [];
      for (let at = free.length - 1; at >= 0; at -= 1) {
        const earlier = free[at];
        if (earlier === undefined || earlier.date < earliest) break;
        if (
          earlier.date <= latest &&
          !chain.includes(earlier) &&
          inWindow(window(schedule, earlier.date), current.date) &&
          withinPercent([...amounts, earlier.amount], band)
        ) {
          fits.push(earlier);
        }
      }
      const previous = nearest(fits, current.amount);
      if (previous === undefined) break;
      chain.unshift(previous);
      current = previous;
    }
    if (chain.length >= FEWEST[schedule]) return { schedule, txns: chain, status: "active" };
  }
  return undefined;
}

// Replays one Merchant's posted Spending, oldest first, and returns its Recurring charges as of
// `today`. Transactions in `claimed` belong to a Recurring charge a Member marked ended: they are
// left out, so later Transactions start a new series.
//
// - An active Recurring charge continues with a Transaction within the margin of its next expected
//   date, at any amount. When two fit, the one nearest the latest amount continues it.
// - It goes inactive once its last active day passes with no Transaction.
// - An inactive one revives with a later Transaction within 7.5% of the latest amount, within the
//   margin of the last date plus a whole number of intervals.
// - A Transaction that does none of these may end a new series. One Merchant may have more than one
//   Recurring charge at different amounts, so no new series starts within 7.5% of an active one's
//   latest amount.
export function replayMerchant(
  txns: readonly SpendingTxn[],
  claimed: ReadonlySet<string>,
  today: string,
): Series[] {
  const ordered = txns
    .filter((txn) => !claimed.has(txn.id))
    .sort((a, b) => (isBefore(a, b) ? -1 : 1));
  const series: Series[] = [];
  const taken = new Set<string>();
  const free: SpendingTxn[] = [];
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
      const candidates: SpendingTxn[] = [];
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
        withinPercent([txn.amount, last(each).amount], BAND) &&
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
      (each) => each.status === "active" && withinPercent([txn.amount, last(each).amount], BAND),
    );
    const found = nearActive ? undefined : newSeriesEndingAt(txn, free);
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

// A Recurring charge's facts from its Transactions: the next expected date, the latest amount,
// and the Account and Category of its last Transaction.
export function factsOf(schedule: Schedule, txns: readonly SpendingTxn[]) {
  const latest = txns.at(-1);
  if (latest === undefined) throw new Error("A Recurring charge has at least one Transaction.");
  return {
    nextExpectedDate: nextExpected(schedule, latest.date),
    latestAmount: latest.amount,
    accountId: latest.accountId,
    category: latest.category,
  };
}
