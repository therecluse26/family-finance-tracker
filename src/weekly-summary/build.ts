import { mergedAlertList } from "../anomalies/index.ts";
import { budgetSpending, budgetsForMonth } from "../budgets/index.ts";
import { countOpenReviewItems, type Database, listPostedParts } from "../db/index.ts";
import {
  calendarDateIn,
  dateLabel,
  directionAgainstUsual,
  dollarsAndCents,
  statusText,
  wholeDollars,
} from "../format.ts";
import { addDays, recurringCharges } from "../recurring/index.ts";
import { plainLine } from "../summary/index.ts";
import type { SummaryWeek } from "./week.ts";

// The weekly summary email's text (spec 06, Weekly summary email, What it holds). Every number is
// one the app counts: no AI call makes or changes any of it. The text names Categories and
// Merchants, as Alerts do, and never an Account, a Member, or an account or card number. Each
// Merchant name is made plain first, so a name cannot start a line of its own.
//
// It reads each kind of data once, never once per Transaction: the posted parts, the month's
// Budgets and their Spending, the Alerts, the Review list count, and the Recurring charges.

// How many weeks before the summary's 7 days the usual takes the median of.
export const USUAL_WEEKS = 12;

// The most Recurring charges the "Coming up" part lists by name.
export const COMING_UP_SHOWN = 10;

const WEEK_DAYS = 7;

export type WeeklySummaryEmail = { subject: string; text: string };

// The median of whole-cent amounts, rounded to the cent; null with none.
function median(amounts: readonly number[]): number | null {
  if (amounts.length === 0) return null;
  const sorted = [...amounts].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return high;
  return Math.round(((sorted[middle - 1] ?? 0) + high) / 2);
}

// The Spending posted in each 7-day window, net of Refunds and Reimbursements, never below $0: the
// summary's own 7 days, and the USUAL_WEEKS weeks before them, those before the history starts
// left out. One read of the posted parts.
async function weekSpending(
  database: Database,
  from: string,
): Promise<{ spent: number; usual: number | null }> {
  const parts = await listPostedParts(database);
  const firstPosted = parts.reduce<string | undefined>(
    (first, part) => (first === undefined || part.postedDate < first ? part.postedDate : first),
    undefined,
  );
  const earliest = addDays(from, -USUAL_WEEKS * WEEK_DAYS);
  const to = addDays(from, WEEK_DAYS - 1);
  // Each window's net, by its index: 0 for the summary's own week, 1 for the week before, and on.
  const nets = new Array<number>(USUAL_WEEKS + 1).fill(0);
  const fromDay = Date.parse(`${from}T00:00:00Z`);
  for (const part of parts) {
    if (part.postedDate < earliest || part.postedDate > to) continue;
    if (part.type !== "Spending" && part.type !== "Refund" && part.type !== "Reimbursement") {
      continue;
    }
    const days = (Date.parse(`${part.postedDate}T00:00:00Z`) - fromDay) / 86_400_000;
    const index = days >= 0 ? 0 : Math.ceil(-days / WEEK_DAYS);
    // Spending is money out, so its amount is negative; a Refund's is positive.
    nets[index] = (nets[index] ?? 0) - part.amount;
  }
  const weeks = nets.map((net) => Math.max(0, net));
  const before = weeks
    .slice(1)
    .filter(
      (_, index) =>
        firstPosted !== undefined && addDays(from, -(index + 1) * WEEK_DAYS) >= firstPosted,
    );
  return { spent: weeks[0] ?? 0, usual: median(before) };
}

// Each Budget that is Over Budget or On pace in `month`: one line each.
async function budgetLines(database: Database, month: string, now: Date): Promise<string[]> {
  const { budgets } = await budgetsForMonth(database, month);
  if (budgets.length === 0) return ["No Budgets yet."];
  const spending = await budgetSpending(database, month, budgets, now);
  const lines: string[] = [];
  for (const budget of budgets) {
    const found = spending.budgets.get(budget.category);
    if (found === undefined || found.status === "on track") continue;
    const of = `${wholeDollars(found.spending)} of ${budget.period === "yearly" ? "its yearly " : ""}${wholeDollars(budget.amount)}`;
    if (found.status === "Over Budget") {
      lines.push(`- ${budget.category}: ${statusText("critical", "Over Budget")}, ${of}.`);
    } else {
      const pace =
        found.projected === null
          ? statusText("serious", "On pace to go over")
          : statusText("serious", `on pace for ${wholeDollars(found.projected)}`);
      lines.push(`- ${budget.category}: ${pace}, ${of} so far.`);
    }
  }
  return lines.length === 0 ? ["Every Budget is on track."] : lines;
}

// Builds the summary of `week` as it reads at `now`. `address` gives each link, from APP_URL.
export async function buildWeeklySummary(options: {
  database: Database;
  week: SummaryWeek;
  timeZone: string;
  address: (path: string) => string;
  now: Date;
}): Promise<WeeklySummaryEmail> {
  const { database, week, timeZone, address, now } = options;
  const today = calendarDateIn(now, timeZone);
  const label = (date: string) => dateLabel(date, today);
  const month = week.to.slice(0, 7);
  const paragraphs: string[] = [
    `Your weekly summary for Sunday, ${label(week.from)} to Saturday, ${label(week.to)}.`,
  ];

  // Spending.
  const { spent, usual } = await weekSpending(database, week.from);
  const against = usual === null ? "" : `, ${directionAgainstUsual(spent - usual, "bad").text}`;
  paragraphs.push(
    [
      `Spending: ${wholeDollars(spent)}${against}.`,
      `See it: ${address(`/transactions?type=Spending&from=${week.from}&to=${week.to}`)}`,
    ].join("\n"),
  );

  // Budgets.
  paragraphs.push(
    [
      `Budgets in ${monthName(month)}:`,
      ...(await budgetLines(database, month, now)),
      `See them: ${address("/budgets")}`,
    ].join("\n"),
  );

  // Alerts created in the 7 days. A merged Alert counts once; one found in history not at all.
  let sent = 0;
  let heldBack = 0;
  for (const alert of await mergedAlertList(database)) {
    const day = calendarDateIn(alert.createdAt, timeZone);
    if (day < week.from || day > week.to) continue;
    if (alert.state === "sent") sent += 1;
    if (alert.state === "held back (weekly cap)") heldBack += 1;
  }
  paragraphs.push(
    [
      `Alerts: ${count(sent, "Alert")} sent, ${heldBack} held back (weekly cap).`,
      `See them: ${address("/alert-list")}`,
    ].join("\n"),
  );

  // The Review list.
  const open = await countOpenReviewItems(database);
  paragraphs.push(
    [`Review list: ${count(open, "item")} open.`, `See it: ${address("/review-list")}`].join("\n"),
  );

  // Recurring charges due in the next 7 days.
  const due = (await recurringCharges(database, now))
    .filter(
      (charge) =>
        charge.status === "active" &&
        charge.nextExpectedDate >= week.nextFrom &&
        charge.nextExpectedDate <= week.nextTo,
    )
    .sort(
      (a, b) =>
        a.nextExpectedDate.localeCompare(b.nextExpectedDate) ||
        a.merchant.name.localeCompare(b.merchant.name),
    );
  const shown = due
    .slice(0, COMING_UP_SHOWN)
    .map(
      (charge) =>
        `- ${label(charge.nextExpectedDate)}: ${plainLine(charge.merchant.name)}, ${dollarsAndCents(charge.latestAmount)}`,
    );
  if (due.length > COMING_UP_SHOWN) shown.push(`- and ${due.length - COMING_UP_SHOWN} more`);
  paragraphs.push(
    [
      `Coming up, ${label(week.nextFrom)} to ${label(week.nextTo)}:`,
      ...(shown.length === 0 ? ["No Recurring charges are due."] : shown),
      `See them: ${address("/recurring-charges")}`,
    ].join("\n"),
  );

  paragraphs.push(`Turn this email off in Settings, Alerts: ${address("/settings/alerts")}`);
  return {
    subject: `Weekly summary: ${label(week.from)} to ${label(week.to)}`,
    text: paragraphs.join("\n\n"),
  };
}

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

// "November 2026" for "2026-11".
function monthName(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

// "1 Alert", "2 Alerts".
const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;
