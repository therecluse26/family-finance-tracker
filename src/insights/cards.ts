import * as z from "zod";
import { type HouseholdAi, PrivacyRefusal, type SummaryPart, typedDate } from "../ai/index.ts";
import { alertList } from "../anomalies/index.ts";
import {
  type Database,
  holdsNewPostedTransaction,
  type InsightCardRow,
  listInsightCards,
  type NewInsightCard,
  replaceInsightCards,
  storeInsightCardDone,
} from "../db/index.ts";
import { registerFollowUpStep } from "../follow-up/index.ts";
import { calendarDateIn, MINUS, percent, wholeDollars } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { type Logger, log } from "../log.ts";
import { listReviews, readReview } from "../monthly-review/index.ts";
import {
  MAX_PICTURE_MERCHANTS,
  PICTURE_TYPES,
  type PictureChoice,
  pictureChoice,
} from "../pictures/index.ts";
import { closedProposals } from "../proposals/index.ts";
import { householdSummary, plainLine, proposalParts } from "../summary/index.ts";

// Insight cards (spec 08, Insight cards; Every AI use): at most once a day, the Writer tier writes
// 4 to 7 cards for the dashboard's AI box from the Household summary and the feedback since the
// last run. One call writes every card and picks every picture, and a new run replaces the whole
// set. The run is the follow-up job's last step: the first sync after 6 AM, Household time, that
// brings new posted Transactions starts it. A run that ends on the no-AI path does not use up the
// day, so the next qualifying sync that day tries again. Until a run writes new cards, the last
// cards stay, while AI is paused too.

// The Household's hour, 0 to 23, from which the day's run may start.
export const INSIGHT_CARDS_HOUR = 6;

// How many cards one run writes.
export const MIN_INSIGHT_CARDS = 4;
export const MAX_INSIGHT_CARDS = 7;

export const CARD_GROUPS = ["worth_acting_on", "heads_up", "good_news"] as const;
export const FIGURE_KINDS = ["dollars", "count", "percent"] as const;

export type CardGroup = (typeof CARD_GROUPS)[number];

// A picture as the AI names it: every field there, null when the picture does not name it, for
// OpenAI's strict mode. Each card's choice is then checked on its own (pictureOf), so a bad one
// shows no picture and never fails the reply.
const PICTURE_ANSWER = z.object({
  type: z.enum(PICTURE_TYPES),
  category: z.string().nullable(),
  merchants: z.array(z.string()).nullable(),
});

// The text of a field: any text but blank. Word counts are in the prompt only (spec 08, Limits on
// each call).
const TEXT = z.string().trim().min(1);

const CARD = z.object({
  group: z.enum(CARD_GROUPS),
  about: TEXT,
  figure: z.number().nullable(),
  figureKind: z.enum(FIGURE_KINDS),
  figureLabel: TEXT,
  title: TEXT,
  why: TEXT,
  nextStep: TEXT,
  picture: PICTURE_ANSWER.nullable(),
});

// The reply: an object whose one field is the array of cards, as structured output takes it.
export const INSIGHT_CARDS_REPLY = z.object({
  cards: z.array(CARD).min(MIN_INSIGHT_CARDS).max(MAX_INSIGHT_CARDS),
});

export type InsightCardsReply = z.infer<typeof INSIGHT_CARDS_REPLY>;

// The task. It stays the same from run to run; the feedback follows it.
export const INSIGHT_CARDS_TASK = [
  `Write the Household's Insight cards for its dashboard: ${MIN_INSIGHT_CARDS} to ${MAX_INSIGHT_CARDS} cards, in the field "cards".`,
  "- Each card is one finding that matters now, with a concrete next step drawn from live facts in the summary, such as a balance, a due date, a Budget's pace, or a Goal's progress.",
  "- At least two cards are habit-based ideas to save: each names a habit the Habit counts show, the change, and the saving a month.",
  "- Order the cards by importance, the most important first.",
  '- Read the feedback after this task. Do not repeat a card a Member marked Done unless something new happened since; then say what changed. Do not warn again about an Alert a Member marked "Not a problem".',
  "Each card's fields:",
  '- group: "worth_acting_on" for something to act on now, "heads_up" for something to watch, or "good_news".',
  "- about: the Category or topic, 1 to 4 words.",
  "- figure: the key number, as a number, such as 180 or 12.5, or null. Amounts are dollars.",
  '- figureKind: "dollars", "count", or "percent".',
  "- figureLabel: 2 to 5 words that explain the figure.",
  "- title: one sentence, under 12 words.",
  "- why: 1 or 2 sentences of evidence.",
  "- nextStep: 1 or 2 sentences, with an amount and a date or how often. For a good_news card: what the news means.",
  "- picture: one picture from the picture menu that shows the evidence, or null. The app draws it from its own data.",
  "The picture menu, by type:",
  '- "days": a calendar of the month, with each day it happened marked. Name a Category in "category", or 1 to ' +
    `${MAX_PICTURE_MERCHANTS} Merchants in "merchants", not both.`,
  `- "trend": 7 months of a Category's Spending against its Budget. Name the Category.`,
  `- "cards": each credit card's balance, with its APR. Name nothing.`,
  `- "recurring": the monthly Recurring charges in a Category. Name the Category.`,
  "Write a Category exactly as the summary does, and a Merchant as the summary names it. Set each field the picture does not name to null.",
].join("\n");

export type InsightCardOptions = {
  database: Database;
  ai: HouseholdAi;
  now?: () => Date;
  logger?: Logger;
};

// How a run ended: it wrote the cards; it was not due; it took the no-AI path, which does not use
// up the day; or its call failed and its AI retry starts a follow-up job at retryAt.
export type InsightCardRun = "written" | "not due" | "no AI" | { retryAt: Date };

const timeZoneOf = async (database: Database) => (await householdTimeZone(database)) ?? "UTC";

// The Household's hour at `now`, 0 to 23.
function hourIn(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  return Number(parts.find((part) => part.type === "hour")?.value);
}

// Whether today's run is still to come: it is 6 AM or later, Household time, and no run wrote the
// current cards today.
export async function insightCardsDue(database: Database, now: Date): Promise<boolean> {
  const timeZone = await timeZoneOf(database);
  if (hourIn(now, timeZone) < INSIGHT_CARDS_HOUR) return false;
  const [last] = await listInsightCards(database);
  return (
    last === undefined || calendarDateIn(last.writtenAt, timeZone) !== calendarDateIn(now, timeZone)
  );
}

// The moment of `hour` o'clock on the Household's calendar day of `now`. 6 AM is never in a
// daylight saving gap, so two steps find the offset.
export function householdHourOn(now: Date, hour: number, timeZone: string): Date {
  const day = calendarDateIn(now, timeZone);
  const wall = Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`);
  const offsetAt = (moment: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      })
        .formatToParts(new Date(moment))
        .map((part) => [part.type, Number(part.value)]),
    );
    const shown = Date.UTC(
      parts.year ?? 0,
      (parts.month ?? 1) - 1,
      parts.day ?? 1,
      parts.hour ?? 0,
      parts.minute ?? 0,
      parts.second ?? 0,
    );
    return shown - moment;
  };
  const first = wall - offsetAt(wall);
  return new Date(wall - offsetAt(first));
}

// The follow-up step's check: a run when it is due and the job brings a Transaction a sync first
// stored as posted at 6 AM today or later, Household time (spec 08: "the first sync after 6 AM
// that brings new posted Transactions"). A Member's edit or a change to a posted Transaction makes
// it unhandled again, but not new.
export async function checkInsightCards(
  options: InsightCardOptions,
  unhandled: readonly string[],
): Promise<InsightCardRun> {
  const { database, now = () => new Date() } = options;
  const at = now();
  if (!(await insightCardsDue(database, at))) return "not due";
  const six = householdHourOn(at, INSIGHT_CARDS_HOUR, await timeZoneOf(database));
  if (!(await holdsNewPostedTransaction(database, unhandled, six))) return "not due";
  return writeInsightCards(options);
}

// A choice the AI named, checked on its own by the same rule as a Monthly review's: only the null
// fields, which a strict reply schema needs, are dropped. A choice that names a field its type does
// not take, such as a `cards` picture with a Category, is a bad choice: no picture (spec 08,
// Picture menu).
function pictureOf(answer: z.infer<typeof PICTURE_ANSWER> | null): PictureChoice | null {
  if (answer === null) return null;
  const { type, category, merchants } = answer;
  const named = {
    type,
    ...(category !== null ? { category } : {}),
    ...(merchants !== null ? { merchants } : {}),
  };
  const parsed = pictureChoice.safeParse(named);
  return parsed.success ? parsed.data : null;
}

// One line of the feedback, from text and typed values.
const feedbackLine = (...parts: SummaryPart[]): SummaryPart[] => [...parts, "\n"];

// The feedback since the last run (spec 08, Insight cards): the cards marked Done, the "Not a
// problem" marks, the Proposals a Member accepted or skipped, and the plan items a Member ticked.
// Each date is typed, and each Proposal's amounts too; the cards' and the plan's words, which the
// AI wrote, are text the filter reads.
async function feedbackParts(
  database: Database,
  current: readonly InsightCardRow[],
  now: Date,
): Promise<SummaryPart[]> {
  const timeZone = await timeZoneOf(database);
  const dateOf = (moment: Date) => typedDate(calendarDateIn(moment, timeZone));
  const since = current[0]?.writtenAt;
  const none = feedbackLine("- None.");

  const done = current.filter((card) => card.doneAt !== null);
  const marks = (await alertList(database))
    .flatMap((alert) =>
      alert.notAProblem
        .filter((press) => since === undefined || press.pressedAt > since)
        .map((press) => ({ alert, pressedAt: press.pressedAt })),
    )
    .sort((a, b) => a.pressedAt.getTime() - b.pressedAt.getTime());
  const proposals = await closedProposals(database, since, now);
  // The plan is the latest review's: one read, whatever the number of reviews.
  const [latest] = await listReviews(database);
  const review = latest === undefined ? undefined : await readReview(database, latest.month);
  const ticks = (review?.ticks ?? [])
    .filter((tick) => since === undefined || tick.tickedAt > since)
    .flatMap((tick) => {
      const item = review?.review.plan[tick.item];
      const idea = item === undefined ? undefined : review?.review.ideas[item.idea];
      return item === undefined || idea === undefined
        ? []
        : [{ idea: idea.idea, when: item.when, tickedAt: tick.tickedAt }];
    });

  return [
    ...(since === undefined
      ? feedbackLine("Feedback: this is the first Insight card run, so none came before it.")
      : feedbackLine("Feedback since the last Insight card run, on ", dateOf(since), ":")),
    ...feedbackLine("Cards a Member marked Done:"),
    ...(done.length === 0
      ? none
      : done.flatMap((card) =>
          feedbackLine(`- ${plainLine(card.about)}: ${plainLine(card.title)}`),
        )),
    ...feedbackLine('Alerts a Member marked "Not a problem":'),
    ...(marks.length === 0
      ? none
      : marks.flatMap(({ alert, pressedAt }) =>
          feedbackLine(
            `- ${alert.kind} Alert${alert.category === null ? "" : ` in ${alert.category}`} from `,
            dateOf(alert.createdAt),
            ", marked on ",
            dateOf(pressedAt),
          ),
        )),
    ...feedbackLine("Proposals a Member accepted or skipped:"),
    ...(proposals.length === 0
      ? none
      : proposals.flatMap((proposal) =>
          feedbackLine(
            `- ${proposal.status === "accepted" ? "Accepted" : "Skipped"} on `,
            dateOf(proposal.closedAt),
            ": ",
            ...proposalParts(proposal),
          ),
        )),
    ...feedbackLine("Plan items a Member ticked in the latest Monthly review:"),
    ...(ticks.length === 0
      ? none
      : ticks.flatMap(({ idea, when, tickedAt }) =>
          feedbackLine(
            "- Ticked on ",
            dateOf(tickedAt),
            `: ${plainLine(idea)}, ${plainLine(when)}`,
          ),
        )),
  ];
}

// One Insight card run, at any hour: one Writer call that writes every card and picks every
// picture. Cards that pass the schema replace the whole set. A pause, an AI error with no retry
// left, or a call the privacy filter refuses takes the no-AI path: the last cards stay.
export async function writeInsightCards(options: InsightCardOptions): Promise<InsightCardRun> {
  const { database, ai, now = () => new Date(), logger = log } = options;
  const current = await listInsightCards(database);
  const summary = await householdSummary({ database, ai, now, logger }).today();
  const feedback = await feedbackParts(database, current, now());
  let reply: Awaited<ReturnType<typeof ai.generate<InsightCardsReply>>>;
  try {
    reply = await ai.generate({
      use: "insight cards",
      summary: summary.parts,
      task: INSIGHT_CARDS_TASK,
      changes: [{ role: "user", parts: feedback }],
      output: INSIGHT_CARDS_REPLY,
    });
  } catch (error) {
    if (!(error instanceof PrivacyRefusal)) throw error;
    logger.warn("The privacy filter refused the Insight card run");
    return "no AI";
  }
  if (!reply.ready) return "retryAt" in reply ? { retryAt: reply.retryAt } : "no AI";

  const writtenAt = now();
  const month = calendarDateIn(writtenAt, await timeZoneOf(database)).slice(0, 7);
  const cards: NewInsightCard[] = [];
  for (const [index, card] of reply.output.cards.entries()) {
    cards.push({
      id: crypto.randomUUID(),
      position: index + 1,
      writtenAt,
      month,
      group: card.group,
      about: await ai.forScreen(card.about),
      figure: card.figure,
      figureKind: card.figureKind,
      figureLabel: await ai.forScreen(card.figureLabel),
      title: await ai.forScreen(card.title),
      why: await ai.forScreen(card.why),
      nextStep: await ai.forScreen(card.nextStep),
      picture: pictureOf(card.picture),
    });
  }
  await replaceInsightCards(database, cards);
  logger.info("Wrote the Insight cards", { cards: cards.length });
  return "written";
}

// Registers the Insight card check as the follow-up job's last step. A failed call waits for its
// AI retry, which starts a follow-up job: the step leaves the job's Transactions unhandled until
// then. Any other failure ends like the no-AI path, with one log line: the next qualifying sync
// tries again, and the job never runs the step again by itself. The start calls it before jobs run.
export function startInsightCards(options: InsightCardOptions): { stop(): void } {
  const logger = options.logger ?? log;
  const stop = registerFollowUpStep("insight card check", async (unhandled) => {
    let run: InsightCardRun;
    try {
      run = await checkInsightCards(options, unhandled);
    } catch (error) {
      // Only the error's name: a failed query's message holds its values.
      logger.error("The Insight card check failed", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return undefined;
    }
    return typeof run === "object" ? { handled: [], again: run.retryAt } : undefined;
  });
  return { stop };
}

// --- The AI box ---------------------------------------------------------------------------------

const GROUP_NAMES = {
  worth_acting_on: "Worth acting on",
  heads_up: "Heads up",
  good_news: "Good news",
} as const satisfies Record<CardGroup, string>;

// An Insight card as the AI box shows it (spec 07, 1. AI box).
export type InsightCard = {
  id: string;
  group: (typeof GROUP_NAMES)[CardGroup];
  // The left column: the figure in the app's number format, or empty with none, and its label.
  figure: string;
  figureLabel: string;
  about: string;
  title: string;
  why: string;
  // A Good news card's words say what the news means, with no "Next step:" label.
  nextStep: string;
  // The picture under "Why?", drawn for `month`, YYYY-MM.
  picture: PictureChoice | null;
  month: string;
  done: boolean;
};

// The largest figure the app shows: past it, the number is no figure the app could have given.
const MAX_FIGURE = 1e12;

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

// The figure in the app's number format: whole dollars, a count, or a whole percent.
function figureText(figure: number | null, kind: InsightCardRow["figureKind"]): string {
  if (figure === null || !Number.isFinite(figure) || Math.abs(figure) >= MAX_FIGURE) return "";
  switch (kind) {
    case "dollars":
      return wholeDollars(Math.round(figure * 100));
    case "count":
      return COUNT.format(figure).replace("-", MINUS);
    case "percent":
      return percent(figure / 100);
  }
}

// The current Insight cards, in the AI's order.
export async function insightCards(database: Database): Promise<InsightCard[]> {
  return (await listInsightCards(database)).map((card) => {
    const picture = card.picture === null ? undefined : pictureChoice.safeParse(card.picture);
    return {
      id: card.id,
      group: GROUP_NAMES[card.group],
      figure: figureText(card.figure, card.figureKind),
      figureLabel: card.figure === null ? "" : card.figureLabel,
      about: card.about,
      title: card.title,
      why: card.why,
      nextStep: card.nextStep,
      picture: picture?.success === true ? picture.data : null,
      month: card.month,
      done: card.doneAt !== null,
    };
  });
}

// Marks a current Insight card Done for every Member, or clears the mark. It makes no AI call:
// the next run reads the mark as feedback. False when no current card has the ID.
export function markInsightCard(
  database: Database,
  mark: { cardId: string; memberId: string; done: boolean },
  now = new Date(),
): Promise<boolean> {
  return storeInsightCardDone(database, { ...mark, at: now });
}
