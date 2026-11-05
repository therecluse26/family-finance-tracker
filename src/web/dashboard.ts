import {
  calendarDateIn,
  type Direction,
  dateLabel,
  directionAgainstUsual,
  dollarsAndCents,
  monthLabel,
  percent,
  type StatusWord,
  timeLabel,
  wholeDollars,
} from "../format.ts";
import type { AiBoxView } from "../server/ai-box-views.ts";
import type {
  ConnectionView,
  HistoryStatusView,
  NumberTilesView,
  NumberTileView,
} from "../server/bank-views.ts";
import type { BudgetsView, MonthBudgetView, UsualMonthView } from "../server/budgets-views.ts";
import type { ComingUpRowView, ComingUpView } from "../server/coming-up-views.ts";
import type { HouseholdFactsView } from "../server/household-views.ts";
import type { NoticeView } from "../server/notice-views.ts";
import { loadAiBox } from "./ai-box.ts";
import { api } from "./api.ts";
import { browserZone } from "./browser-zone.ts";
import { type GoalsAnswer, loadGoals } from "./goals.ts";
import { transactionsPath } from "./transactions.ts";

// The dashboard's numbers and words (spec 07, The dashboard): its header, its status lines, Left
// to spend, Goals, the number tiles, "A usual month", and "Coming up". The app draws every number
// from its own data.

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// The Household's month on `now`, so the dashboard switches to the new month on the 1st.
export type DashboardMonth = {
  // YYYY-MM.
  month: string;
  // "October".
  name: string;
  // The Household's date, YYYY-MM-DD.
  today: string;
  day: number;
  days: number;
};

export function dashboardMonth(now: Date, timeZone: string): DashboardMonth {
  const today = calendarDateIn(now, timeZone);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return {
    month: today.slice(0, 7),
    name: MONTH_NAMES[month - 1] ?? "",
    today,
    day: Number(today.slice(8, 10)),
    days: new Date(Date.UTC(year, month, 0)).getUTCDate(),
  };
}

// "Day 4 of 30 · synced 8:15 AM". The time is the latest finished sync of any Connection, with its
// date when that was before today.
export function headerLine(
  month: DashboardMonth,
  connections: readonly Pick<ConnectionView, "lastSyncedAt">[],
  timeZone: string,
): string {
  const day = `Day ${month.day} of ${month.days}`;
  const latest = connections
    .map((connection) => connection.lastSyncedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);
  if (latest === undefined) return `${day} · not synced yet`;
  const at = new Date(latest);
  const date = calendarDateIn(at, timeZone);
  const time = timeLabel(at, timeZone);
  return `${day} · synced ${date === month.today ? time : `${dateLabel(date, month.today)}, ${time}`}`;
}

// --- Status lines ------------------------------------------------------------------------------

// A broken Connection's banner: its System notice, with Repair for its Connection.
export type RepairBanner = { notice: NoticeView; connection: ConnectionView | undefined };

export type StatusLines = {
  repairs: RepairBanner[];
  // "Loading history for <bank>", with its progress, one per Connection.
  loading: { connectionId: string; text: string }[];
  // Every other open System notice.
  others: NoticeView[];
};

const count = (n: number) => n.toLocaleString("en-US");

export function loadingLine(loading: HistoryStatusView["loading"][number], today: string): string {
  const so = `${count(loading.transactions)} ${loading.transactions === 1 ? "Transaction" : "Transactions"} so far`;
  const back =
    loading.oldestDate === null ? "" : `, back to ${dateLabel(loading.oldestDate, today)}`;
  return `Loading history for ${loading.bankName}: ${so}${back}`;
}

// The lines above the boxes (spec 07, Header and status lines). A notice that asks for Repair is
// its Connection's banner, so it shows there and not again among the others.
export function statusLines(
  notices: readonly NoticeView[],
  connections: readonly ConnectionView[],
  history: Pick<HistoryStatusView, "loading">,
  today: string,
): StatusLines {
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  return {
    repairs: notices
      .filter((notice) => notice.repairConnectionId !== null)
      .map((notice) => ({ notice, connection: byId.get(notice.repairConnectionId ?? "") })),
    loading: history.loading.map((each) => ({
      connectionId: each.connectionId,
      text: loadingLine(each, today),
    })),
    others: notices.filter((notice) => notice.repairConnectionId === null),
  };
}

// --- Left to spend -----------------------------------------------------------------------------

// Travel's and Gifts and donations' yearly Budget row.
export type YearlyRow = {
  category: string;
  // Whole cents: the year's Spending, and the yearly Budget.
  spending: number;
  amount: number;
  shareOfYear: number;
  overBudget: boolean;
};

export type LeftToSpend =
  | { drafted: false }
  | {
      drafted: true;
      // Whole cents: the sum of the monthly Budgets, and the month's Spending in every Category
      // with a monthly Budget or with no Budget. Travel, and Gifts and donations, stay out.
      budget: number;
      spending: number;
      // The Budget left: below 0 once the month is over Budget.
      left: number;
      // The sum of each Category's projected month-end Spending, or null before the month starts.
      projected: number | null;
      yearly: YearlyRow[];
    };

// Left to spend from the month's Budgets (spec 07, 2. Left to spend). Each Category group's box
// already sums the Categories it counts: its monthly Budgets, and its monthly Categories with no
// Budget. A Category with no projection, Interest and fees, adds its Spending to the projection.
export function leftToSpend(
  view: Pick<BudgetsView, "drafted" | "budgets" | "groups">,
): LeftToSpend {
  if (!view.drafted) return { drafted: false };
  let budget = 0;
  let spending = 0;
  for (const group of view.groups) {
    budget += group.monthly;
    spending += group.spending ?? 0;
  }
  const projected = projectedSpending(view.groups);
  const yearly = view.budgets
    .filter((each) => each.period === "yearly")
    .map((each) => ({
      category: each.category,
      spending: each.spending,
      amount: each.amount,
      shareOfYear: each.shareOfYear ?? 0,
      overBudget: each.status === "Over Budget",
    }));
  return { drafted: true, budget, spending, left: budget - spending, projected, yearly };
}

// The sum of each Category's projected month-end Spending, in the Categories Left to spend counts,
// or null before the month starts. Each Category group's box already sums its own.
export function projectedSpending(
  groups: Pick<BudgetsView["groups"][number], "spending" | "projected">[],
): number | null {
  let projected: number | null = 0;
  for (const group of groups) {
    if (group.spending === null) continue;
    projected = projected === null || group.projected === null ? null : projected + group.projected;
  }
  return projected;
}

// True when `cents` is at least $1 once rounded to whole dollars. A gap that rounds to $0 is not
// over Budget, so the page never says "$0 over".
const overInWholeDollars = (cents: number) => cents > 0 && wholeDollars(cents) !== "$0";

// The big number: "$1,240", or "$310 over" below $0. Less than 50 cents over shows as "$0".
export function leftText(left: number): { text: string; over: boolean } {
  return overInWholeDollars(-left)
    ? { text: `${wholeDollars(-left)} over`, over: true }
    : { text: wholeDollars(Math.max(0, left)), over: false };
}

// The pace line: "◆ On pace to end $X over Budget" or "✓ On pace to end $X under Budget". A
// projection less than 50 cents over the Budget ends "$0 under Budget".
export function paceLine(
  budget: number,
  projected: number,
): { tone: "serious" | "good"; text: string } {
  return overInWholeDollars(projected - budget)
    ? { tone: "serious", text: `On pace to end ${wholeDollars(projected - budget)} over Budget` }
    : {
        tone: "good",
        text: `On pace to end ${wholeDollars(Math.max(0, budget - projected))} under Budget`,
      };
}

// Under the month meter: "$1,860 of $3,100 · 12 days to go".
export function meterLine(spending: number, budget: number, month: DashboardMonth): string {
  const toGo = month.days - month.day;
  return `${wholeDollars(spending)} of ${wholeDollars(budget)} · ${toGo} ${toGo === 1 ? "day" : "days"} to go`;
}

// A yearly row: "$1,240 of $3,000 · 83% of the year gone".
export function yearlyLine(row: YearlyRow): string {
  return `${wholeDollars(row.spending)} of ${wholeDollars(row.amount)} · ${percent(row.shareOfYear)} of the year gone`;
}

// A share for a bar, from 0 to 1.
export const barShare = (part: number, whole: number) =>
  whole <= 0 ? (part > 0 ? 1 : 0) : Math.min(1, Math.max(0, part / whole));

// --- The 12-month usual ------------------------------------------------------------------------

// The change against the usual, in whole cents, or 0 within 2% of the usual (spec 07, 4. Number
// tiles): the page then says "about usual".
export function changeAgainstUsual(amount: number, usual: number): number {
  const change = amount - usual;
  return Math.abs(change) <= Math.abs(usual) * 0.02 ? 0 : change;
}

// "▲ $40 above usual", "▼ $40 below usual", or "● about usual". No usual, no direction.
export function directionOf(amount: number, usual: number | null, moreIs: "good" | "bad") {
  return usual === null
    ? undefined
    : directionAgainstUsual(changeAgainstUsual(amount, usual), moreIs);
}

// "September", from "2026-09".
export const monthName = (month: string) => MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? "";

// --- Number tiles ------------------------------------------------------------------------------

export type NumberTile = {
  key: "spending" | "income" | "cashOnHand" | "debt";
  label: string;
  tile: NumberTileView;
  // A rise is bad for Spending and Debt, and good for Income and Cash on hand.
  moreIs: "good" | "bad";
  // Where tapping the tile goes.
  to: string;
  // "Debt includes 2 estimated loans", while any Manual loan counts in the Debt.
  note?: string;
};

// The four tiles in their order (spec 07, 4. Number tiles). Spending opens Top Merchants; Income
// opens the Transactions page for last month's Income; Cash on hand and Debt open the Account list.
export function numberTiles(view: NumberTilesView): NumberTile[] {
  const last = monthName(view.lastMonth);
  const loans = view.debt.estimatedLoans;
  return [
    {
      key: "spending",
      label: `Spending in ${last}`,
      tile: view.spending,
      moreIs: "bad",
      to: "/top-merchants",
    },
    {
      key: "income",
      label: `Income in ${last}`,
      tile: view.income,
      moreIs: "good",
      to: transactionsPath({ type: "Income", month: view.lastMonth }),
    },
    {
      key: "cashOnHand",
      label: "Cash on hand",
      tile: view.cashOnHand,
      moreIs: "good",
      to: "/accounts",
    },
    {
      key: "debt",
      label: "Debt",
      tile: view.debt,
      moreIs: "bad",
      to: "/accounts",
      ...(loans === 0
        ? {}
        : { note: `Debt includes ${loans} estimated ${loans === 1 ? "loan" : "loans"}` }),
    },
  ];
}

// --- "A usual month" ---------------------------------------------------------------------------

// The line under the usual: "October is on pace for $3,400, $200 above usual", or ", about usual"
// within 2%. More Spending is bad.
export function usualMonthLine(
  month: DashboardMonth,
  projected: number,
  usual: number | null,
): { tone: Direction["tone"]; text: string } {
  const pace = `${month.name} is on pace for ${wholeDollars(projected)}`;
  if (usual === null) return { tone: "muted", text: pace };
  const change = changeAgainstUsual(projected, usual);
  const { tone } = directionAgainstUsual(change, "bad");
  if (tone === "muted") return { tone, text: `${pace}, about usual` };
  const where = change > 0 ? "above" : "below";
  return { tone, text: `${pace}, ${wholeDollars(Math.abs(change))} ${where} usual` };
}

export type UsualGroup = UsualMonthView["groups"][number];

// A status as its icon's tone and its word (spec 07, Status: color, icon, and word together).
export type BudgetStatusShown =
  | { tone: "critical"; word: StatusWord<"critical"> }
  | { tone: "serious"; word: StatusWord<"serious"> }
  | { tone: "good"; word: StatusWord<"good"> };

// A group's status (spec 07, 5. "A usual month"): "▲ N over", "◆ N on pace to go over", or "✓ on
// track". N counts its Categories in that state; Over Budget wins over On pace. A group with no
// monthly Budget has none.
export function groupStatus(
  group: BudgetsView["groups"][number] | undefined,
): BudgetStatusShown | undefined {
  if (group === undefined || group.monthly === 0) return undefined;
  const over = group.overBudget ?? 0;
  const onPace = group.onPace ?? 0;
  if (over > 0) return { tone: "critical", word: `${over} over` };
  if (onPace > 0) return { tone: "serious", word: `${onPace} on pace to go over` };
  return { tone: "good", word: "on track" };
}

// A group's 13 bars: the 12 complete months, muted, then this month in full color. The dashed
// line is at each month's Budget, with none before the first draft.
export type GroupBar = {
  month: string;
  // "Oct 2026".
  label: string;
  spending: number;
  budget: number | null;
  current: boolean;
};

export function groupBars(group: UsualGroup, month: DashboardMonth): GroupBar[] {
  return group.bars.map((bar) => ({
    ...bar,
    label: monthLabel(`${bar.month}-01`),
    current: bar.month === month.month,
  }));
}

// One row of "<Group> Budgets": a Category's Spending this month and its monthly Budget, or
// undefined with none.
export type GroupBudgetRow = {
  category: string;
  spending: number;
  budget: MonthBudgetView | undefined;
  // A flexible Category is any one outside the Bills group; only it gets a "today" tick.
  flexible: boolean;
};

const rankOf = (row: GroupBudgetRow) => {
  if (row.budget?.status === "Over Budget") return 0;
  if (row.budget?.status === "On pace") return 1;
  return row.flexible ? 2 : 3;
};

// "<Group> Budgets", worst first: Over Budget, then On pace, then other flexible Categories, then
// Bills. Within each, Category list order.
export function groupBudgetRows(
  group: Pick<UsualGroup, "categoryGroup" | "categories">,
  view: Pick<BudgetsView, "budgets" | "unbudgeted">,
): GroupBudgetRow[] {
  const budgets = new Map(
    view.budgets.filter((each) => each.period === "monthly").map((each) => [each.category, each]),
  );
  const unbudgeted = new Map(view.unbudgeted.map((each) => [each.category, each.spending]));
  const rows = group.categories.map((category) => {
    const budget = budgets.get(category);
    return {
      category,
      spending: budget?.spending ?? unbudgeted.get(category) ?? 0,
      budget,
      flexible: group.categoryGroup !== "Bills",
    };
  });
  return rows.sort((a, b) => rankOf(a) - rankOf(b));
}

// The note of a row that is not on track: "▲ $X over" or "◆ on pace for $X".
export function rowNote(row: GroupBudgetRow): BudgetStatusShown | undefined {
  const { budget } = row;
  if (budget?.status === "Over Budget") {
    return { tone: "critical", word: `${wholeDollars(row.spending - budget.amount)} over` };
  }
  if (budget?.status === "On pace" && budget.projected !== null) {
    return { tone: "serious", word: `on pace for ${wholeDollars(budget.projected)}` };
  }
  return undefined;
}

// --- Coming up -------------------------------------------------------------------------------

// One row of the table (spec 07, 6. Coming up), in cents. A payday shows "+"; money out shows "−".
// A Recurring charge on a card says "on card" in place of the checking balance. A late Recurring
// charge says "late" in place of its date.
export type ComingUpRow = {
  date: string;
  what: string;
  amount: string;
  checkingAfter: string;
  payday: boolean;
};

export function comingUpRow(row: ComingUpRowView, today: string): ComingUpRow {
  return {
    date: row.late ? "late" : dateLabel(row.date, today),
    what: row.kind === "payday" ? `${row.what} payday` : row.what,
    amount: dollarsAndCents(row.amount, { signed: true }),
    checkingAfter: row.onCard
      ? "on card"
      : row.checkingAfter === null
        ? ""
        : dollarsAndCents(row.checkingAfter),
    payday: row.kind === "payday",
  };
}

// "Lowest checking balance: $1,240 on Nov 12". None with no connected checking Account.
export function lowestLine(view: Pick<ComingUpView, "lowest">, today: string): string | undefined {
  if (view.lowest === null) return undefined;
  return `Lowest checking balance: ${wholeDollars(view.lowest.amount)} on ${dateLabel(view.lowest.date, today)}`;
}

// --- Requests ----------------------------------------------------------------------------------

export type DashboardData = {
  timeZone: string;
  month: DashboardMonth;
  connections: ConnectionView[];
  history: HistoryStatusView;
  notices: NoticeView[];
  budgets: BudgetsView;
  numberTiles: NumberTilesView;
  usualMonth: UsualMonthView;
  comingUp: ComingUpView;
  goals: GoalsAnswer;
  aiBox: AiBoxView;
};

async function read<T>(res: Promise<Response>): Promise<T> {
  const answer = await res;
  if (!answer.ok) throw new Error(`The dashboard's request answered ${answer.status}.`);
  return (await answer.json()) as T;
}

// Everything the dashboard shows, in the Household's month on `now`. Until the wizard sets the
// Household time zone, the browser's stands in.
export async function loadDashboard(now = new Date()): Promise<DashboardData> {
  const [household, connections, history, notices, comingUp, goals, aiBox] = await Promise.all([
    read<{ facts: HouseholdFactsView | null }>(api.household.$get()),
    read<{ connections: ConnectionView[] }>(api.connections.$get()),
    read<HistoryStatusView>(api["history-status"].$get()),
    read<{ notices: NoticeView[] }>(api.notices.$get()),
    read<ComingUpView>(api["coming-up"].$get()),
    loadGoals(),
    loadAiBox(),
  ]);
  const timeZone = household.facts?.timeZone ?? browserZone();
  const month = dashboardMonth(now, timeZone);
  const [budgets, numberTiles, usualMonth] = await Promise.all([
    read<BudgetsView>(api.budgets.$get({ query: { month: month.month } })),
    read<NumberTilesView>(api["number-tiles"].$get()),
    read<UsualMonthView>(api["usual-month"].$get({ query: { month: month.month } })),
  ]);
  return {
    timeZone,
    month,
    connections: connections.connections,
    history,
    notices: notices.notices,
    budgets,
    numberTiles,
    usualMonth,
    comingUp,
    goals,
    aiBox,
  };
}

// Closes an event notice for every Member.
export const closeNotice = (id: string) => api.notices[":id"].close.$post({ param: { id } });

// Retry on the notice of a stopped First run or bank-added-later job: starts it again.
export const retryHistoryJobs = () => api["history-jobs"].retry.$post();
