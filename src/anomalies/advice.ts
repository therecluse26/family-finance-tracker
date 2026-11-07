import * as z from "zod";
import {
  batchReply,
  type HouseholdAi,
  type SummaryPart,
  typedAmount,
  typedCount,
  typedDate,
  typedMonth,
} from "../ai/index.ts";
import { budgetSpending, budgetsForMonth } from "../budgets/index.ts";
import { isCategory } from "../categories/index.ts";
import {
  type AlertForAdvice,
  type Database,
  listAlertsToAdvise,
  listNotAProblemAlerts,
  storeAlertAdvice,
} from "../db/index.ts";
import { type Goal, readGoalsWithProgress } from "../goals/index.ts";
import { type Logger, log } from "../log.ts";
import { householdToday } from "../recurring/index.ts";
import { type AlertFacts, type AlertWriter, alertPieces } from "./templates.ts";

// The AI's advice on Alerts (spec 06, The AI's advice; spec 08, Every AI use, Alert advice). One
// Quick-tier call covers every Alert the Alerts step has not decided yet: the Alerts one sync
// created. It advises on the newest 4 of them, so its reply fits its limit. It runs in the Alerts
// step, before the step decides them, so the Alerts go out when the call ends. The AI reads each
// Alert's kind and template facts, that Category's Budget and Spending this month, every active
// Goal, and the latest "Not a problem" marks, and writes one or two sentences for each. The advice is stored beside the template's text, never in it: the
// template states the facts, and no number comes from the AI.
//
// With no AI provider, at the AI cost cap, after the last retry fails, or when the privacy filter
// refuses the call, the Alerts go with their template only. While the call waits for a retry, the
// Alerts wait with it. An Alert the call is done with never gets advice later.

// How many "Not a problem" marks the call holds, the latest first.
export const NOT_A_PROBLEM_MARKS = 10;

// At most 300 tokens of advice for each Alert (spec 08, Limits on each call), at about 4
// characters a token. The call's reply limit sets the rest.
const ADVICE_CHARACTERS = 1_200;

// The most Alerts one call advises on: 300 tokens each fill the call's 1,200, so a longer reply is
// never cut off. With more new Alerts, the newest get advice and the rest go with their template
// only, in the same call's end: the app makes no second call.
export const ADVICE_ALERTS_CAP = 4;

export const ALERT_ADVICE_TASK = [
  "Task: advice on new Alerts. The app sends each Alert below to the Household with its template text, which states the facts.",
  "For each Alert, write 1 or 2 short sentences.",
  "When an active Goal fits the Alert, tie the Alert to that Goal. Then give one practical step. With no active Goal that fits, give the step only.",
  "Never restate or change a number the Alert states: the template already says it.",
  'The Household pressed "Not a problem" on the earlier Alerts listed: it does not care about Alerts like those, so do not press the point.',
  "Answer each Alert once, by its row number.",
].join("\n");

const ADVICE_ANSWER = z.object({ advice: z.string().trim().min(1).max(ADVICE_CHARACTERS) });

// Every control character, and the line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it replaces.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;

// Text a Member or a bank wrote, such as a Goal's words or a Merchant, as one plain line: well-
// formed, with a space for each control character, so the privacy filter reads the characters the
// AI reads and the text cannot start a line of its own.
const plain = (text: string) =>
  text.toWellFormed().replace(CONTROL, " ").replace(/ {2,}/g, " ").trim();

// An amount in whole dollars, as "$" and a count, such as $1234. A half rounds away from zero, as
// src/format.ts rounds it.
function dollars(cents: number): SummaryPart[] {
  const whole = Math.floor((Math.abs(cents) + 50) / 100);
  const sign = cents < 0 && whole > 0 ? "-" : "";
  return [`${sign}$`, whole < 1_000_000_000 ? typedCount(whole) : typedAmount(whole * 100)];
}

// An amount in dollars and cents, as "$" and a typed amount, such as $70.37.
const money = (cents: number): SummaryPart[] => [
  cents < 0 ? "-$" : "$",
  typedAmount(Math.abs(Math.round(cents))),
];

// An Alert's template as parts: each number the app made as a typed value, and its words and the
// names in it as text, which the privacy filter reads.
const ADVICE_WRITER: AlertWriter<SummaryPart[]> = {
  text: (text) => [text.toWellFormed().replace(CONTROL, " ")],
  cents: money,
  dollars,
  percent: (ratio) => {
    const whole = Math.floor(Math.abs(ratio) * 100 + 0.5);
    const sign = ratio < 0 && whole > 0 ? "-" : "";
    return [sign, whole < 1_000_000_000 ? typedCount(whole) : String(whole), "%"];
  },
  date: (date) => [typedDate(date)],
  month: (month) => [typedMonth(month)],
  year: (year) => [typedCount(Number(year))],
};

// The facts an Alert's template states, with the Account it names by its label, such as "Ally
// checking": the stored facts hold the Account's name as it was, which may name a Member.
function factsOf(alert: AlertForAdvice, accountLabels: ReadonlyMap<string, string>): AlertFacts {
  const facts = alert.facts as AlertFacts;
  if (facts.kind !== "Duplicate charge" && facts.kind !== "Card interest or fee") return facts;
  const label = alert.accountId === null ? undefined : accountLabels.get(alert.accountId);
  return { ...facts, account: label ?? "an Account" };
}

// The Category an Alert is about: its own, its Budget's, or that of a Transaction it is about.
function categoryOf(alert: AlertForAdvice): string | null {
  const facts = alert.facts as Partial<{ budget: { category?: unknown } | null }>;
  const budgetCategory = facts.budget?.category;
  return (
    alert.category ??
    (typeof budgetCategory === "string" ? budgetCategory : null) ??
    alert.transactionCategory
  );
}

// One active Goal: its words, what the AI read it to be about, and its status.
function goalLine(goal: Goal, accountLabels: ReadonlyMap<string, string>): SummaryPart[] {
  const account = (id: string) => accountLabels.get(id) ?? "an Account";
  const { target } = goal.reading;
  let about = "";
  switch (target?.kind) {
    case "Category":
      about = `; about Category ${target.category}`;
      break;
    case "Merchant":
      about = `; about Merchant ${plain(target.merchant.name)}`;
      break;
    case "Saving":
      about = "; about Saving";
      break;
    case "Accounts":
      about = `; about saving in ${target.accountIds.map(account).join(", ")}`;
      break;
    case "loan":
      about = `; about paying down ${account(target.accountId)}`;
      break;
    case undefined:
      break;
  }
  return [`- "${plain(goal.words)}"${about}; status ${goal.status}`];
}

// The call's one message: the Alerts by row, each with its Category's Budget and Spending this
// month, then the active Goals, then the latest "Not a problem" marks.
async function adviceParts(
  database: Database,
  ai: HouseholdAi,
  alerts: readonly AlertForAdvice[],
  now: Date,
): Promise<SummaryPart[]> {
  const accountLabels = await ai.accountLabels();
  const month = (await householdToday(database, now)).slice(0, 7);
  const { budgets } = await budgetsForMonth(database, month);
  const spending = await budgetSpending(database, month, budgets, now);
  const template = (alert: AlertForAdvice) =>
    alertPieces(factsOf(alert, accountLabels), ADVICE_WRITER).flat();

  const categoryLine = (category: string | null): SummaryPart[] => {
    if (category === null || !isCategory(category)) return [];
    const budget = budgets.find((each) => each.category === category);
    const found = spending.budgets.get(category);
    if (budget?.period === "yearly") {
      return [
        `\n   ${category} this year: `,
        ...dollars(found?.spending ?? 0),
        " of a yearly Budget of ",
        ...dollars(budget.amount),
        ".",
      ];
    }
    if (budget !== undefined) {
      return [
        `\n   ${category} this month: `,
        ...dollars(found?.spending ?? 0),
        " of a Budget of ",
        ...dollars(budget.amount),
        ".",
      ];
    }
    const unbudgeted = spending.unbudgeted.find((each) => each.category === category);
    return [`\n   ${category} this month: `, ...dollars(unbudgeted?.spending ?? 0), ", no Budget."];
  };

  // A done Goal leaves the AI's context at once (spec 05, Rules).
  const goals = (await readGoalsWithProgress(database, now)).filter(
    (goal) => goal.status === "active",
  );
  const marks = await listNotAProblemAlerts(database, NOT_A_PROBLEM_MARKS);
  const lines: SummaryPart[][] = [
    ["Alerts:"],
    ...alerts.map((alert, index) => [
      `${index + 1}. ${alert.kind}: `,
      ...template(alert),
      ...categoryLine(categoryOf(alert)),
    ]),
    [""],
    ["Active Goals:"],
    ...(goals.length === 0 ? [["- None."]] : goals.map((goal) => goalLine(goal, accountLabels))),
    [""],
    ['Earlier Alerts the Household marked "Not a problem", the latest first:'],
    ...(marks.length === 0
      ? [["- None."]]
      : marks.map((alert) => [`- ${alert.kind}: `, ...template(alert)])),
  ];
  return lines.flatMap((line, index) => (index === 0 ? line : ["\n", ...line]));
}

// Asks the AI for advice on the Alerts the Alerts step has not decided yet, once, and stores each
// one's advice beside its template: the newest ADVICE_ALERTS_CAP of them, while the rest go with
// their template only. Makes no call with no such Alert. Returns the retry time while
// the call waits for one: the Alerts wait with it. Otherwise the call is done with these Alerts,
// with advice or without, and they never get advice later. An AI error or a refusal never stops an
// Alert: it goes with its template only.
export async function adviseAlerts(options: {
  database: Database;
  ai: HouseholdAi;
  now?: Date;
  logger?: Logger;
}): Promise<{ again: Date } | undefined> {
  const { database, ai, now = new Date(), logger = log } = options;
  const covered = await listAlertsToAdvise(database);
  if (covered.length === 0) return undefined;
  // Oldest first, so the newest are last.
  const alerts = covered.slice(-ADVICE_ALERTS_CAP);
  const advice = new Map<string, string>();
  try {
    const reply = await ai.generate({
      use: "alert advice",
      task: ALERT_ADVICE_TASK,
      changes: [{ role: "user", parts: await adviceParts(database, ai, alerts, now) }],
      alerts: alerts.length,
      output: batchReply(ADVICE_ANSWER, alerts.length),
    });
    if (!reply.ready && "retryAt" in reply) return { again: reply.retryAt };
    if (reply.ready) {
      for (const { row, advice: text } of reply.output.answers) {
        const alert = alerts[row - 1];
        if (alert !== undefined) advice.set(alert.id, await ai.forScreen(text));
      }
    } else {
      logger.info("The Alerts go with their template only", {
        alerts: alerts.length,
        reason: "pause" in reply ? reply.pause : reply.failed,
      });
    }
  } catch (error) {
    // Only the error's name: never the prompt, the reply, or a message that may quote them.
    logger.warn("The Alert advice call failed, so the Alerts go with their template only", {
      alerts: alerts.length,
      error: error instanceof Error ? error.name : "unknown",
    });
    advice.clear();
  }
  await storeAlertAdvice(
    database,
    covered.map((alert) => alert.id),
    advice,
    new Date(),
  );
  return undefined;
}
