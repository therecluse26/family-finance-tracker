import { calendarDateIn, dateLabel, percent, timeLabel, wholeDollars } from "../format.ts";
import type { ConnectionView, HistoryStatusView } from "../server/bank-views.ts";
import type { BudgetsView } from "../server/budgets-views.ts";
import type { HouseholdFactsView } from "../server/household-views.ts";
import type { NoticeView } from "../server/notice-views.ts";
import { api } from "./api.ts";
import { browserZone } from "./browser-zone.ts";

// The dashboard's numbers and words (spec 07, The dashboard): its header, its status lines, and
// Left to spend. The app draws every number from its own data.

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
  let projected: number | null = 0;
  for (const group of view.groups) {
    budget += group.monthly;
    if (group.spending === null) continue;
    spending += group.spending;
    projected = projected === null || group.projected === null ? null : projected + group.projected;
  }
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

// --- Requests ----------------------------------------------------------------------------------

export type DashboardData = {
  timeZone: string;
  month: DashboardMonth;
  connections: ConnectionView[];
  history: HistoryStatusView;
  notices: NoticeView[];
  budgets: BudgetsView;
};

async function read<T>(res: Promise<Response>): Promise<T> {
  const answer = await res;
  if (!answer.ok) throw new Error(`The dashboard's request answered ${answer.status}.`);
  return (await answer.json()) as T;
}

// Everything the dashboard shows, in the Household's month on `now`. Until the wizard sets the
// Household time zone, the browser's stands in.
export async function loadDashboard(now = new Date()): Promise<DashboardData> {
  const [household, connections, history, notices] = await Promise.all([
    read<{ facts: HouseholdFactsView | null }>(api.household.$get()),
    read<{ connections: ConnectionView[] }>(api.connections.$get()),
    read<HistoryStatusView>(api["history-status"].$get()),
    read<{ notices: NoticeView[] }>(api.notices.$get()),
  ]);
  const timeZone = household.facts?.timeZone ?? browserZone();
  const month = dashboardMonth(now, timeZone);
  const budgets = await read<BudgetsView>(api.budgets.$get({ query: { month: month.month } }));
  return {
    timeZone,
    month,
    connections: connections.connections,
    history,
    notices: notices.notices,
    budgets,
  };
}

// Closes an event notice for every Member.
export const closeNotice = (id: string) => api.notices[":id"].close.$post({ param: { id } });

// Retry on the notice of a stopped First run or bank-added-later job: starts it again.
export const retryHistoryJobs = () => api["history-jobs"].retry.$post();
