import {
  type HouseholdAi,
  type SummaryPart,
  typedAmount,
  typedCount,
  typedDate,
  typedMonth,
} from "../ai/index.ts";
import { type Alert, type AlertWriter, alertList, alertPieces } from "../anomalies/index.ts";
import { budgetSpending, budgetsForMonth } from "../budgets/index.ts";
import { CATEGORIES, type Category } from "../categories/index.ts";
import {
  type Database,
  listAccountBalances,
  listHabitSpending,
  readHouseholdSummary,
  readShownTransactions,
  storeHouseholdSummary,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { type Goal, readGoalsWithProgress } from "../goals/index.ts";
import { householdTimeZone } from "../household/index.ts";
import { type Logger, log } from "../log.ts";
import {
  addDays,
  addMonths,
  comingUp,
  householdToday,
  recurringCharges,
  steadyIncome,
} from "../recurring/index.ts";
import { habitCounts } from "./habits.ts";

// The Household summary (spec 08, Household summary): one text of 3,000 tokens or fewer that feeds
// every Writer use. It holds the month's numbers, history totals, balances, Coming up, Recurring
// charges, Goals, Alerts, and the app's Habit counts, and no raw Transactions.
//
// It is app-built, so the privacy filter reads it on each call, and its final check refuses a call
// that still holds a name or number the rules remove (spec 08, Privacy filter). So it names each
// Account by its label, such as "Ally checking", and each Member by their label, such as "Member
// A", never by name, and holds no Account number. Each number the app made, such as an amount, a
// date, a month, or a count, goes as a typed value (src/ai/typed.ts), which the filter keeps as it
// is: the AI reads 49.99 even when an Account's last 4 is 4999. Every text, such as a label, a
// Merchant, a Goal's words, or an Alert's text, goes through the full filter. Each text a Member
// or a bank wrote is made plain first: a space for each control character, and well-formed. The
// call sends the text as it is, with no encoding, so the filter reads the characters the AI reads.

// The most tokens a summary may hold.
export const SUMMARY_TOKENS = 3_000;

// How many complete months the history parts cover.
export const HISTORY_MONTHS = 12;

// How many months the Habit counts cover: the summary's month and the ones before it.
export const HABIT_MONTHS = 3;

// How many "Not a problem" marks the summary holds, the latest first.
export const NOT_A_PROBLEM_MARKS = 10;

// How many price changes a Recurring charge's price history holds, the latest.
const PRICE_CHANGES = 4;

// The days "the last 7 days" of Alerts covers, today among them.
const ALERT_DAYS = 7;

// A summary's tokens, as the app counts them: its characters ÷ 4.
export function summaryTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type SummaryOptions = {
  database: Database;
  ai: Pick<HouseholdAi, "accountLabels" | "memberLabels">;
  now?: () => Date;
  logger?: Logger;
};

// A built summary: its parts, as a Writer use sends them (src/ai/prompt.ts), and its text, as the
// AI reads it when the privacy filter removes nothing from its texts.
export type BuiltSummary = { parts: readonly SummaryPart[]; text: string };

export type HouseholdSummary = {
  // The summary every Writer use but the Monthly review reads today. The day's first Writer use
  // builds it, Household time, and the rest of the day reads the same parts, so Chat's cache mark
  // holds from call to call.
  today(): Promise<BuiltSummary>;
  // The Monthly review's summary: built anew on each call, for the month just ended.
  monthJustEnded(): Promise<BuiltSummary>;
};

export function householdSummary(options: SummaryOptions): HouseholdSummary {
  const { database, now = () => new Date() } = options;
  return {
    async today() {
      const at = now();
      const day = await householdToday(database, at);
      const stored = await readHouseholdSummary(database);
      const kept = stored?.day === day ? piecesOf(stored.text) : undefined;
      if (kept !== undefined) return built(kept);
      const pieces = await buildSummary(options, day.slice(0, 7), at);
      await storeHouseholdSummary(database, { day, text: JSON.stringify(pieces) }, at);
      return built(pieces);
    },
    async monthJustEnded() {
      const at = now();
      const day = await householdToday(database, at);
      const ended = addMonths(`${day.slice(0, 7)}-01`, -1).slice(0, 7);
      return built(await buildSummary(options, ended, at));
    },
  };
}

// One piece of the summary: text, or a number the app made, which goes as a typed value: an amount
// in whole cents, a date, a month, or a count. app.db stores the pieces as JSON, never a typed
// value, whose mark is new each time the app starts.
type Piece = string | { amount: number } | { date: string } | { month: string } | { count: number };

// One line of the summary, as its pieces.
type Line = readonly Piece[];

const money = (cents: number): Piece => ({ amount: Math.round(cents) || 0 });
const day = (date: string): Piece => ({ date });
const monthOf = (month: string): Piece => ({ month });
const count = (value: number): Piece => ({ count: value });
// A whole percent, such as a share of Spending, as a count with "%" after it.
const percent = (share: number): Line => [count(Math.round(share * 100)), "%"];
// A rate such as an APR of 28.49. With at most 2 decimals, it goes in an amount's form, 28.49, so
// the filter keeps it as it keeps an amount. Any other rate, which no bank sends, goes as text.
const rate = (value: number): Piece => {
  const hundredths = Math.round(value * 100);
  const exact = Math.abs(value * 100 - hundredths) < 1e-6 && Math.abs(hundredths) < 10 ** 11;
  return exact ? money(hundredths) : String(value);
};

// A line from a template, such as line`- ${category}: ${money(cents)}`. Each value is text, a
// piece, or a line of pieces.
function line(strings: TemplateStringsArray, ...values: (Piece | Line)[]): Line {
  return strings.flatMap((text, index): Piece[] => {
    const value = values[index];
    if (value === undefined) return [text];
    return [text, ...(Array.isArray(value) ? (value as Line) : [value as Piece])];
  });
}

// Lines of pieces joined by `separator`, such as ", ".
function joined(lines: readonly Line[], separator: string): Line {
  return lines.flatMap((each, index) => (index === 0 ? each : [separator, ...each]));
}

// A piece as a Writer use sends it: text, or a typed value. Each typed value checks its form.
function summaryPart(piece: Piece): SummaryPart {
  if (typeof piece === "string") return piece;
  if ("amount" in piece) return typedAmount(piece.amount);
  if ("date" in piece) return typedDate(piece.date);
  if ("month" in piece) return typedMonth(piece.month);
  return typedCount(piece.count);
}

// A piece as the AI reads it: the typed value's form, such as -1234.50.
function pieceText(piece: Piece): string {
  if (typeof piece === "string") return piece;
  if ("amount" in piece) {
    const size = Math.abs(piece.amount);
    const sign = piece.amount < 0 ? "-" : "";
    return `${sign}${Math.floor(size / 100)}.${String(size % 100).padStart(2, "0")}`;
  }
  if ("date" in piece) return piece.date;
  if ("month" in piece) return piece.month;
  return String(piece.count);
}

// The pieces of the stored JSON, or undefined when it holds anything else: the day's summary is
// then built again.
function piecesOf(json: string): Piece[] | undefined {
  try {
    const pieces: unknown = JSON.parse(json);
    if (!Array.isArray(pieces)) return undefined;
    for (const piece of pieces) {
      const known =
        typeof piece === "string" ||
        (typeof piece === "object" && piece !== null && Object.keys(piece).length === 1);
      if (!known) return undefined;
      summaryPart(piece as Piece);
    }
    return pieces as Piece[];
  } catch {
    return undefined;
  }
}

// The summary's parts, with text next to text joined into one, and its text.
function built(pieces: readonly Piece[]): BuiltSummary {
  const parts: SummaryPart[] = [];
  for (const piece of pieces) {
    const last = parts.at(-1);
    if (typeof piece === "string" && typeof last === "string")
      parts[parts.length - 1] = last + piece;
    else if (piece !== "") parts.push(summaryPart(piece));
  }
  return { parts, text: pieces.map(pieceText).join("") };
}

// Every control character, and the line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it replaces.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;

// Text a Member or a bank wrote, such as a Goal's words or a Merchant, as one plain line: well-
// formed, with a space for each control character, so it cannot start a line of its own.
const plain = (text: string) =>
  text.toWellFormed().replace(CONTROL, " ").replace(/ {2,}/g, " ").trim();

// An amount in whole dollars, as "$" and a count, such as $1234. A half rounds away from zero, as
// src/format.ts rounds it. An amount too large for a count goes in an amount's form.
function dollars(cents: number): Line {
  const whole = Math.floor((Math.abs(cents) + 50) / 100);
  const sign = cents < 0 && whole > 0 ? "-" : "";
  return [`${sign}$`, whole < 1_000_000_000 ? count(whole) : money(whole * 100)];
}

// An Alert's template (src/anomalies/templates.ts) as pieces: each amount as "$" and a typed
// value, each date and month typed, and its words and the names in it as text.
const ALERT_WRITER: AlertWriter<Line> = {
  text: (text) => [text.toWellFormed().replace(CONTROL, " ")],
  cents: (cents) => [cents < 0 ? "-$" : "$", money(Math.abs(cents))],
  dollars,
  percent: (ratio) => {
    const whole = Math.floor(Math.abs(ratio) * 100 + 0.5);
    const sign = ratio < 0 && whole > 0 ? "-" : "";
    return [sign, whole < 1_000_000_000 ? count(whole) : String(whole), "%"];
  },
  date: (date) => [day(date)],
  month: (month) => [monthOf(month)],
  year: (year) => [count(Number(year))],
};

// A Goal's progress detail (src/goals/progress.ts) as pieces, with each whole-dollar amount as "$"
// and a typed count, and each "; " as ", and ". Only a detail one of its templates wrote does
// this; any other text goes as text.
const AMOUNT = String.raw`\$\d{1,3}(?:,\d{3})*`;
const PROGRESS_DETAIL = new RegExp(
  `^(?:On pace for ${AMOUNT} this month; Goal is ${AMOUNT}|${AMOUNT} of ${AMOUNT}(?: paid)?(?:; ${AMOUNT} (?:ahead of|behind) pace)?)$`,
);
function progressDetail(detail: string): Line {
  if (!PROGRESS_DETAIL.test(detail)) return [plain(detail)];
  return detail
    .split(new RegExp(`(${AMOUNT})`))
    .flatMap((each, index) =>
      index % 2 === 1
        ? dollars(Number(each.slice(1).replaceAll(",", "")) * 100)
        : [each.replaceAll("; ", ", and ")],
    );
}

// The months before `month`, oldest first, written YYYY-MM.
function monthsBefore(month: string, months: number): string[] {
  return Array.from({ length: months }, (_, index) =>
    addMonths(`${month}-01`, index - months).slice(0, 7),
  );
}

const daysIn = (month: string) => Number(addDays(addMonths(`${month}-01`, 1), -1).slice(8, 10));

// Each part of the summary as lines. The per-Category history is built per count of months, so the
// summary can drop its oldest months until it fits.
type Parts = {
  head: Line[];
  history: (months: number) => Line[];
  rest: Line[];
};

// The summary of `month`, written YYYY-MM, on `now`: the current month on its day, or a month that
// has ended, as complete. Over SUMMARY_TOKENS, it drops the oldest months of per-Category history
// until it fits. Still over with none left, it goes as it is, and one log line says so.
async function buildSummary(options: SummaryOptions, month: string, now: Date): Promise<Piece[]> {
  const parts = await summaryParts(options, month, now);
  let pieces: Piece[] = [];
  let tokens = 0;
  for (let months = HISTORY_MONTHS; months >= 0; months -= 1) {
    pieces = joined([...parts.head, ...parts.history(months), ...parts.rest], "\n") as Piece[];
    tokens = summaryTokens(pieces.map(pieceText).join(""));
    if (tokens <= SUMMARY_TOKENS) return pieces;
  }
  // The size only: the line never holds the summary.
  (options.logger ?? log).warn(
    "The Household summary is over its limit with no per-Category history left",
    { size: tokens, limit: SUMMARY_TOKENS },
  );
  return pieces;
}

async function summaryParts(options: SummaryOptions, month: string, now: Date): Promise<Parts> {
  const { database, ai } = options;
  const today = await householdToday(database, now);
  const timeZone = (await householdTimeZone(database)) ?? "UTC";
  const accountLabels = await ai.accountLabels();
  const memberLabels = await ai.memberLabels();
  const label = (id: string | null) => (id === null ? undefined : accountLabels.get(id));
  const complete = monthsBefore(month, HISTORY_MONTHS);

  // The month.
  const days = daysIn(month);
  const current = month === today.slice(0, 7);
  const dayOfMonth = current ? Number(today.slice(8, 10)) : days;
  const head: Line[] = [
    ["Household summary. Amounts are dollars. The app counted every number; use them as they are."],
    [""],
    ["## The month"],
    current
      ? line`Today is ${day(today)}, day ${count(dayOfMonth)} of the ${count(days)} days of ${monthOf(month)}. Days left: ${count(days - dayOfMonth)}.`
      : line`Today is ${day(today)}. The month ${monthOf(month)} has ended, all ${count(days)} days of it.`,
  ];

  // Per Category, this month.
  const { budgets } = await budgetsForMonth(database, month);
  const spending = await budgetSpending(database, month, budgets, now);
  const named = new Set<Category>();
  const monthLines: Line[] = [];
  const yearLines: Line[] = [];
  for (const { name: category } of CATEGORIES) {
    const budget = budgets.find((each) => each.category === category);
    const found = spending.budgets.get(category);
    const unbudgeted = spending.unbudgeted.find((each) => each.category === category);
    const projected = found?.projected ?? unbudgeted?.projected ?? null;
    const projection: Line = projected === null ? [] : line`, projected ${money(projected)}`;
    if (budget?.period === "yearly") {
      named.add(category);
      yearLines.push(
        line`- ${category}: ${money(found?.spending ?? 0)} this year of a yearly Budget of ${money(budget.amount)}, ${found?.status ?? "on track"}`,
      );
    } else if (budget !== undefined) {
      named.add(category);
      monthLines.push(
        line`- ${category}: ${money(found?.spending ?? 0)} of a Budget of ${money(budget.amount)}, ${found?.status ?? "on track"}${projection}`,
      );
    } else if (unbudgeted !== undefined) {
      named.add(category);
      monthLines.push(line`- ${category}: ${money(unbudgeted.spending)}, no Budget${projection}`);
    }
  }

  // Per Category and money flow, the last 12 complete months.
  const totals = new Map(spending.totals.map((each) => [each.month, each]));
  const historyCategories = CATEGORIES.map(({ name }) => name).filter((category) =>
    complete.some((each) => (totals.get(each)?.byCategory[category] ?? 0) !== 0),
  );
  for (const category of historyCategories) named.add(category);
  const history = (months: number): Line[] => {
    const shown = complete.slice(-months);
    const first = shown[0];
    const last = shown.at(-1);
    if (months === 0 || historyCategories.length === 0 || first === undefined || !last) return [];
    return [
      [""],
      line`## Per Category, Spending in each complete month, ${monthOf(first)} to ${monthOf(last)}`,
      ...historyCategories.map(
        (category) =>
          line`- ${category}: ${joined(
            shown.map((each) => [money(totals.get(each)?.byCategory[category] ?? 0)]),
            ", ",
          )}`,
      ),
    ];
  };

  const categoryPart: Line[] = [
    [""],
    line`## Per Category, ${monthOf(month)}: Spending, Budget, status, and projected month-end Spending`,
    ...(monthLines.length === 0 ? [["- No Spending yet."]] : monthLines),
    ...(yearLines.length === 0
      ? []
      : [line`Yearly Budgets, through ${monthOf(month)}:`, ...yearLines]),
  ];
  // Spec 05, Context for Bills Budgets: the AI gets this fact with any Housing or Car comparison.
  if (named.has("Housing") || named.has("Car")) {
    categoryPart.push([
      "Note: the Benchmarks come from the BLS Consumer Expenditure Survey, which leaves mortgage principal out and counts a financed car at its full price in the year of purchase. Housing and Car Spending can sit above their Benchmarks for this reason alone.",
    ]);
  }

  const income = await steadyIncome(database, now);
  const flowPart: Line[] = [
    [""],
    ["## Money flow in each complete month"],
    ...complete.map((each) => {
      const found = totals.get(each);
      return line`- ${monthOf(each)}: Income ${money(found?.income ?? 0)}, Spending ${money(found?.spending ?? 0)}, Saving ${money(found?.saving ?? 0)}`;
    }),
    line`Steady Income: ${money(income.amount)} a month${income.typed === null ? "" : ", as a Member typed it"}.`,
  ];

  // Habit counts.
  const habitMonths = [...monthsBefore(month, HABIT_MONTHS - 1), month];
  const lastDay = `${month}-${String(days).padStart(2, "0")}`;
  const habits = habitCounts(
    await listHabitSpending(database, `${habitMonths[0]}-01`, lastDay),
    habitMonths,
  );
  const habitPart: Line[] = [
    [""],
    ["## Habit counts"],
    ...habits.flatMap((each) => [
      line`In ${monthOf(each.month)}${each.month === today.slice(0, 7) ? ", so far" : ""}: meals out (Restaurants Transactions) ${count(each.mealsOut)}, delivery orders ${count(each.deliveryOrders)}.`,
      line`- Share of Spending made Friday to Sunday: ${
        each.fridayToSunday.length === 0
          ? "none"
          : joined(
              each.fridayToSunday.map(({ category, share }) => line`${category} ${percent(share)}`),
              ", ",
            )
      }`,
      line`- Most frequent Merchants, with Transactions and Spending: ${
        each.frequentMerchants.length === 0
          ? "none"
          : joined(
              each.frequentMerchants.map(
                ({ name, count: txns, total }) =>
                  line`${plain(name)} ${count(txns)} for ${money(total)}`,
              ),
              "; ",
            )
      }`,
    ]),
  ];

  // Balances.
  const balanceLines = (await listAccountBalances(database))
    .filter((account) => account.closedAt === null && !account.excluded)
    .map((account) => {
      const facts: Line[] = [
        account.currentBalance === null ? ["no balance yet"] : [money(account.currentBalance)],
      ];
      const apr =
        account.kind === "credit"
          ? account.cardAprs?.find((each) => each.type === "purchase_apr")?.apr
          : (account.loanApr ?? account.memberApr);
      if (apr !== undefined && apr !== null) facts.push(line`APR ${rate(apr)}%`);
      if (account.statementBalance !== null) {
        facts.push(line`statement balance ${money(account.statementBalance)}`);
      }
      if (account.minimumPayment !== null) {
        facts.push(line`minimum payment ${money(account.minimumPayment)}`);
      }
      if (account.paymentDueDate !== null) facts.push(line`due ${day(account.paymentDueDate)}`);
      // A promo end date would go here: no bank adapter sends one yet.
      return line`- ${label(account.id) ?? "Account"}: ${joined(facts, ", ")}`;
    });
  const balancePart: Line[] = [
    [""],
    ["## Balances: money owed is negative"],
    ...(balanceLines.length === 0 ? [["- No Accounts."]] : balanceLines),
  ];

  // Coming up.
  const due = await comingUp(database, now);
  const comingUpPart: Line[] = [
    [""],
    line`## Coming up, ${day(due.from)} to ${day(due.to)}`,
    ...(due.rows.length === 0
      ? [["- Nothing."]]
      : due.rows.map((row) => {
          // A card or loan payment names its Account by label, never by its name.
          const what =
            row.accountId === null
              ? plain(row.what)
              : `${label(row.accountId) ?? "Account"} payment`;
          return line`- ${day(row.date)}: ${what}, ${money(row.amount)}, ${row.kind}${row.late ? ", late" : ""}`;
        })),
  ];
  if (due.checking !== null && due.lowest !== null) {
    comingUpPart.push(
      line`Checking now: ${money(due.checking)}. Lowest in the window: ${money(due.lowest.amount)} on ${day(due.lowest.date)}.`,
    );
  }

  // Recurring charges.
  const charges = (await recurringCharges(database, now))
    .filter((charge) => charge.status === "active")
    .sort(
      (a, b) =>
        a.nextExpectedDate.localeCompare(b.nextExpectedDate) ||
        a.merchant.name.localeCompare(b.merchant.name),
    );
  const chargePart: Line[] = [
    [""],
    ["## Recurring charges: amount, interval, next date, Category, and price history"],
    ...(charges.length === 0
      ? [["- None."]]
      : charges.map((charge) => {
          const changes = charge.priceHistory
            .filter((entry, index, all) => index === 0 || entry.amount !== all[index - 1]?.amount)
            .slice(-PRICE_CHANGES)
            .map((entry) => line`${money(entry.amount)} from ${day(entry.date)}`);
          return line`- ${plain(charge.merchant.name)}: ${money(charge.latestAmount)} ${charge.schedule}, next ${day(charge.nextExpectedDate)}, ${charge.category ?? "no Category"}; prices: ${joined(changes, ", ")}`;
        })),
  ];

  // Goals.
  const goals = (await readGoalsWithProgress(database, now)).filter(
    (goal) => goal.list === "active",
  );
  const goalPart: Line[] = [
    [""],
    ["## Goals"],
    ...(goals.length === 0
      ? [["- None."]]
      : goals.map((goal) => goalLine(goal, memberLabels, accountLabels))),
  ];

  // Alerts.
  const alerts = await alertList(database);
  const alertPart = await alertLines(options, alerts, {
    today,
    month,
    timeZone,
    memberLabels,
    accountLabels,
  });

  return {
    head: [...head, ...categoryPart],
    history,
    rest: [
      ...flowPart,
      ...habitPart,
      ...balancePart,
      ...comingUpPart,
      ...chargePart,
      ...goalPart,
      ...alertPart,
      [""],
      ["## Proposals"],
      // The app makes no Proposal yet (spec 05, Proposals), so none is open.
      ["- None open."],
    ],
  };
}

// One active Goal: its words, its author by label, the AI's reading, its progress, and its status.
function goalLine(
  goal: Goal,
  memberLabels: ReadonlyMap<string, string>,
  accountLabels: ReadonlyMap<string, string>,
): Line {
  const author =
    (goal.authorId === null ? undefined : memberLabels.get(goal.authorId)) ?? "a Member";
  const account = (id: string) => accountLabels.get(id) ?? "Account";
  const { target, change, deadline } = goal.reading;
  let aim = "none";
  if (target !== null) {
    switch (target.kind) {
      case "Category":
        aim = `Category ${target.category}`;
        break;
      case "Merchant":
        aim = `Merchant ${plain(target.merchant.name)}`;
        break;
      case "Saving":
        aim = "Saving";
        break;
      case "Accounts":
        aim = `Accounts ${target.accountIds.map(account).join(", ")}`;
        break;
      case "loan":
        aim = `loan ${account(target.accountId)}`;
        break;
    }
  }
  let changed: Line = ["none"];
  if (change !== null) {
    if ("amount" in change) changed = [money(change.amount)];
    else if (Number.isSafeInteger(change.percent) && change.percent >= 0) {
      changed = [count(change.percent), "%"];
    } else changed = [`${change.percent}%`];
  }
  const reading = line`reading: target ${aim}, change ${changed}, deadline ${deadline === null ? "none" : day(deadline)}`;
  const goalAmount: Line =
    goal.goalAmount === null ? [] : line`, Goal amount ${money(goal.goalAmount)}`;
  let progress: Line = ["no progress yet"];
  if (goal.progress !== null) {
    const facts: Line[] = [];
    if (goal.progress.percentage !== null) {
      facts.push(line`${count(goal.progress.percentage)}% done`);
    }
    if (goal.progress.state !== null) facts.push([goal.progress.state]);
    // The progress line, as the Goals page shows it, with its amounts typed.
    facts.push(progressDetail(goal.progress.detail));
    if (goal.progress.estimated) facts.push(["estimated"]);
    progress = joined(facts, ", ");
  }
  return line`- "${plain(goal.words)}", by ${author} on ${day(goal.date)}; ${reading}${goalAmount}; progress: ${progress}; status ${goal.status}`;
}

// The Alerts part: the Alerts of the last 7 days, those the weekly cap held back in `month`, and
// the latest "Not a problem" marks. Each is its template text, with each Account by its label.
async function alertLines(
  { database }: SummaryOptions,
  alerts: readonly Alert[],
  facts: {
    today: string;
    month: string;
    timeZone: string;
    memberLabels: ReadonlyMap<string, string>;
    accountLabels: ReadonlyMap<string, string>;
  },
): Promise<Line[]> {
  const { today, month, timeZone, memberLabels, accountLabels } = facts;
  const dayOf = (alert: Alert) => calendarDateIn(alert.createdAt, timeZone);
  const byId = new Map(alerts.map((alert) => [alert.id, alert]));
  // A later part of a merged Alert shares its first part's state.
  const stateOf = (alert: Alert) =>
    alert.state ?? (alert.mergedInto === null ? null : (byId.get(alert.mergedInto)?.state ?? null));
  // Newest first. Alerts made at the same time keep one order, by their text, so the summary
  // stays the same all day.
  const ordered = [...alerts].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.text.localeCompare(b.text),
  );
  const since = addDays(today, 1 - ALERT_DAYS);
  // Current Alerts (spec 08): an Alert found in a history load is about the past, not current.
  const recent = ordered.filter(
    (alert) =>
      dayOf(alert) >= since && dayOf(alert) <= today && stateOf(alert) !== "found in history",
  );
  const heldBack = ordered.filter(
    (alert) => stateOf(alert) === "held back (weekly cap)" && dayOf(alert).slice(0, 7) === month,
  );
  const listed = new Set([...recent, ...heldBack].map((alert) => alert.id));
  const marked = ordered
    .filter((alert) => alert.notAProblem.length > 0 && !listed.has(alert.id))
    .sort((a, b) => lastPress(b) - lastPress(a))
    .slice(0, NOT_A_PROBLEM_MARKS);

  // The Account of each Alert that names one, by its Transaction: the template's facts hold the
  // Account's name as it was, which may name a Member.
  const named = [...recent, ...heldBack, ...marked].filter(
    (alert) =>
      alert.facts.kind === "Duplicate charge" || alert.facts.kind === "Card interest or fee",
  );
  const accountOf = new Map(
    (
      await readShownTransactions(
        database,
        named.flatMap((alert) => alert.transactionIds),
      )
    ).map((txn) => [txn.id, txn.accountId]),
  );

  const alertLine = (alert: Alert): Line => {
    let alertFacts = alert.facts;
    if (alertFacts.kind === "Duplicate charge" || alertFacts.kind === "Card interest or fee") {
      const accountId = alert.transactionIds
        .map((id) => accountOf.get(id))
        .find((id) => id !== undefined);
      const account =
        (accountId === undefined ? undefined : accountLabels.get(accountId)) ?? "an Account";
      alertFacts = { ...alertFacts, account };
    }
    const presses = alert.notAProblem.map(
      (press) =>
        line`${(press.memberId === null ? undefined : memberLabels.get(press.memberId)) ?? "a Member"} on ${day(calendarDateIn(press.pressedAt, timeZone))}`,
    );
    const mark: Line =
      presses.length === 0 ? [] : line` Marked "Not a problem" by ${joined(presses, ", ")}.`;
    // The template's words and names are text, which the filter reads; its numbers are typed.
    return line`- ${day(dayOf(alert))}, ${alert.kind}: ${alertPieces(alertFacts, ALERT_WRITER).flat()}${mark}`;
  };

  return [
    [""],
    ["## Alerts in the last 7 days"],
    ...(recent.length === 0 ? [["- None."]] : recent.map(alertLine)),
    line`Alerts the weekly cap held back in ${monthOf(month)}:`,
    ...(heldBack.length === 0 ? [["- None."]] : heldBack.map(alertLine)),
    ['Earlier Alerts a Member marked "Not a problem", the latest first:'],
    ...(marked.length === 0 ? [["- None."]] : marked.map(alertLine)),
  ];
}

const lastPress = (alert: Alert) =>
  Math.max(...alert.notAProblem.map((press) => press.pressedAt.getTime()));
