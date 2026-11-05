import { dateLabel, monthLabel, wholeDollars } from "../format.ts";
import type { StoredReview } from "../monthly-review/review-view.ts";
import type { MonthlyReviewView, ReviewListView } from "../server/monthly-reviews-views.ts";
import { api } from "./api.ts";
import { monthName } from "./dashboard.ts";

// The Reviews page (spec 07, Reviews page): the past Monthly reviews, and one review drawn from the
// review as it was written. The AI wrote the words; every number here is the app's, from the
// stored review, and every amount is drawn from whole cents.

export const NO_REVIEW_WITHOUT_AI = "With no AI provider, no Monthly review is written.";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// "Sunday", for a date written YYYY-MM-DD.
function weekday(date: string): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "";
}

// The month after `month`, both written YYYY-MM.
export function nextMonth(month: string): string {
  const [year = 0, number = 1] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 7);
}

// The list's line for a review: "Oct 2026 review".
export const listLine = (month: string) => `${monthLabel(`${month}-01`)} review`;

// The header's first line: "October review · written Sunday, Nov 1". `today` is the Household's
// date, so a date in another year shows its year.
export const reviewTitle = (month: string, writtenOn: string, today: string) =>
  `${monthName(month)} review · written ${weekday(writtenOn)}, ${dateLabel(writtenOn, today)}`;

// "Your November plan".
export const planHeading = (month: string) => `Your ${monthName(nextMonth(month))} plan`;

// The AI box's review link: "Your October review is ready".
export const reviewLinkTitle = (month: string) => `Your ${monthName(month)} review is ready`;

// "Left over": the month's Budget less its Spending, in the Categories Left to spend counts, or
// "$X over" once the Spending passed the Budget.
export function leftOver(header: StoredReview["header"]): string | null {
  if (header.budget === null) return null;
  const left = header.budget - header.spending;
  return left < 0 ? `${wholeDollars(-left)} over` : wholeDollars(left);
}

// The header bar's words, which carry its numbers: "$3,420 of $3,100 Budget".
export function spendingLine(header: StoredReview["header"]): string {
  return header.budget === null
    ? `${wholeDollars(header.spending)} spent, no Budget`
    : `${wholeDollars(header.spending)} of ${wholeDollars(header.budget)} Budget`;
}

// The share of the bar the Spending fills, from 0 to 1, against 125% of the Budget so an overage
// still shows; and where the Budget's mark sits.
export const BAR_TOP = 1.25;
export function spendingShare(header: StoredReview["header"]): number {
  if (header.budget === null || header.budget <= 0) return header.spending > 0 ? 1 : 0;
  return Math.min(header.spending / (header.budget * BAR_TOP), 1);
}

export type IdeaRow = StoredReview["ideas"][number] & {
  // Its place in the review's ideas.
  index: number;
  // The bar's length, from 0 to 1, as a share of the largest saving.
  share: number;
  // Debt ideas are red; every other kind is a Spending idea, green.
  debt: boolean;
};

// The ideas, by what they save a month, largest first. Ideas that save the same keep the AI's
// order.
export function ideaRows(ideas: StoredReview["ideas"]): IdeaRow[] {
  const most = Math.max(1, ...ideas.map((idea) => idea.savesMonth));
  return ideas
    .map((idea, index) => ({
      ...idea,
      index,
      share: idea.savesMonth / most,
      debt: idea.kind === "Debt",
    }))
    .sort((a, b) => b.savesMonth - a.savesMonth || a.index - b.index);
}

// An idea's line under "Why?": its kind, its effort, and the saving a year, 12 × the saving a
// month: "Habit · Some effort · $1,440 a year".
export const ideaFacts = (idea: StoredReview["ideas"][number]) =>
  `${idea.kind} · ${idea.effort} · ${wholeDollars(idea.savesMonth * 12)} a year`;

// The first idea that targets each Habit, in the AI's order: the Habit card's "Try: …".
export function firstIdeaFor(ideas: StoredReview["ideas"], habit: number): string | undefined {
  return ideas.find((idea) => idea.habit === habit)?.idea;
}

// The plan's ideas with their savings, and "All three": the total a month.
export function planRows(review: StoredReview): {
  rows: { item: number; idea: string; when: string; savesMonth: number }[];
  total: number;
} {
  const rows = review.plan.flatMap((entry, item) => {
    const idea = review.ideas[entry.idea];
    return idea === undefined
      ? []
      : [{ item, idea: idea.idea, when: entry.when, savesMonth: idea.savesMonth }];
  });
  return { rows, total: rows.reduce((sum, row) => sum + row.savesMonth, 0) };
}

// --- Requests -----------------------------------------------------------------------------------

export async function loadReviewList(): Promise<ReviewListView> {
  const res = await api["monthly-reviews"].$get();
  if (!res.ok) throw new Error(`The Reviews list's request answered ${res.status}.`);
  return (await res.json()) as ReviewListView;
}

// A month's review, or null when the month has none.
export async function loadReview(month: string): Promise<MonthlyReviewView | null> {
  const res: Response = await api["monthly-reviews"][":month"].$get({ param: { month } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The review's request answered ${res.status}.`);
  return (await res.json()) as MonthlyReviewView;
}

async function refusal(send: () => Promise<Response>): Promise<string | undefined> {
  let res: Response;
  try {
    res = await send();
  } catch {
    return "The server did not answer.";
  }
  if (res.ok) return undefined;
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

// A tick on a plan item for every Member, or a tick cleared. The words of a refusal, or undefined
// when it worked.
export function tickPlanItem(month: string, item: number, done: boolean) {
  // The route reads its JSON body itself, so the typed client does not list `json`.
  const tick = { param: { month, item: String(item) }, json: { done } };
  return refusal(() => api["monthly-reviews"][":month"].plan[":item"].$put(tick));
}

// Done on the AI box's review link, for every Member: the link leaves the box.
export function markReviewLinkDone(month: string, done: boolean) {
  const mark = { param: { month }, json: { done } };
  return refusal(() => api["ai-box"]["review-links"][":month"].done.$put(mark));
}
