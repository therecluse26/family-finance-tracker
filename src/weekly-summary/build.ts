import { mergedAlertList } from "../anomalies/index.ts";
import { budgetSpending, budgetsForMonth } from "../budgets/index.ts";
import {
  countOpenReviewItems,
  type Database,
  listLinkedMoneyPostedDates,
  listPostedParts,
} from "../db/index.ts";
import {
  calendarDateIn,
  dateLabel,
  directionAgainstUsual,
  dollarsAndCents,
  statusText,
  wholeDollars,
} from "../format.ts";
import { type PostedPart, totalsByPeriod } from "../money-movement/index.ts";
import { addDays, recurringCharges } from "../recurring/index.ts";
import { median } from "../server/usual.ts";
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

// The Spending in each 7-day window, by the app's Spending rule (totalsByPeriod): net of Refunds
// and Reimbursements, and no Category below $0. Unlike a month's total, each part counts on the
// day it posted, a linked Refund or Reimbursement on its own: a purchase still pending at the send
// counts in the next week's summary, so each part counts in exactly one summary, and each usual
// week reads as its own summary did. The windows are the summary's own 7 days, and the
// USUAL_WEEKS weeks before them. As the Dashboard's usual leaves out each month before the
// history's first, the usual leaves out each week that ends before it: a first week the history
// starts in counts. One read of the posted parts, and one of the links.
async function weekSpending(
  database: Database,
  from: string,
): Promise<{ spent: number; usual: number | null }> {
  const parts = await listPostedParts(database);
  // A linked part has its Spending's dates (spec 03, Which month a link changes): it counts on
  // the day its own money in posted instead.
  const ownDates = parts.some((part) => part.spendingTransactionId !== null)
    ? await listLinkedMoneyPostedDates(database)
    : new Map<string, string>();
  const postedOn = (part: PostedPart) =>
    part.spendingTransactionId === null
      ? part.postedDate
      : (ownDates.get(part.transactionId) ?? part.postedDate);
  const first = parts.reduce<string | undefined>((earliest, part) => {
    const date = postedOn(part);
    return earliest === undefined || date < earliest ? date : earliest;
  }, undefined);
  const earliest = addDays(from, -USUAL_WEEKS * WEEK_DAYS);
  const to = addDays(from, WEEK_DAYS - 1);
  const fromDay = Date.parse(`${from}T00:00:00Z`);
  // Each window by its index: 0 for the summary's own week, 1 for the week before, and on.
  const totals = totalsByPeriod(parts, (part) => {
    const date = postedOn(part);
    if (date < earliest || date > to) return null;
    const days = (Date.parse(`${date}T00:00:00Z`) - fromDay) / 86_400_000;
    return String(days >= 0 ? 0 : Math.ceil(-days / WEEK_DAYS));
  });
  const spentIn = (index: number) =>
    totals.find((each) => each.period === String(index))?.spending ?? 0;
  const before: number[] = [];
  for (let index = 1; index <= USUAL_WEEKS; index += 1) {
    const lastDay = addDays(from, -(index - 1) * WEEK_DAYS - 1);
    if (first !== undefined && lastDay >= first) before.push(spentIn(index));
  }
  return { spent: spentIn(0), usual: median(before) };
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
