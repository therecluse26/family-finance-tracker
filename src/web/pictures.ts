import { dollarsAndCents, monthLabel, percent, wholeDollars } from "../format.ts";
import type {
  CardsPictureView,
  DaysPictureView,
  PictureChoice,
  PictureView,
  RecurringPictureView,
  TrendPictureView,
} from "../pictures/picture-view.ts";
import { api } from "./api.ts";

// The words and shapes of the pictures on the picture menu (spec 08, Picture menu). The app draws
// every number from its own data: the server checks the choice and sends the numbers.

// The request's query: the month, the picture type, and what it shows.
export function pictureQuery(
  choice: PictureChoice,
  month: string,
): { month: string; type: string; category?: string; merchant?: string[] } {
  if ("category" in choice) return { month, type: choice.type, category: choice.category };
  if ("merchants" in choice) return { month, type: choice.type, merchant: choice.merchants };
  return { month, type: choice.type };
}

// The picture a choice names for a month, or null when the data does not bear it out or the
// request fails: either way no picture shows.
export async function readPicture(
  choice: PictureChoice,
  month: string,
): Promise<PictureView | null> {
  const res = await api.picture.$get({ query: pictureQuery(choice, month) });
  if (!res.ok) return null;
  return ((await res.json()) as { picture: PictureView | null }).picture;
}

// "A", "A and B", or "A, B, and C".
function listed(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

// --- days ---------------------------------------------------------------------------------------

// One square of the calendar: a day of the month, or a blank before the 1st. `count` is how many
// Transactions that day.
export type CalendarCell = { date: string; day: number; count: number } | null;

// The month's weeks, Sunday first, with a blank for each weekday before the 1st.
export function calendarWeeks(view: DaysPictureView): CalendarCell[][] {
  const [year = 0, month = 0] = view.month.split("-").map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const counts = new Map(view.days.map((each) => [each.date, each.count]));
  const cells: CalendarCell[] = Array.from(
    { length: new Date(Date.UTC(year, month - 1, 1)).getUTCDay() },
    () => null,
  );
  for (let day = 1; day <= days; day++) {
    const date = `${view.month}-${String(day).padStart(2, "0")}`;
    cells.push({ date, day, count: counts.get(date) ?? 0 });
  }
  const weeks: CalendarCell[][] = [];
  for (let start = 0; start < cells.length; start += 7) weeks.push(cells.slice(start, start + 7));
  return weeks;
}

// "Groceries in Oct 2026: 9 days", or the Merchants by name.
export function daysCaption(view: DaysPictureView): string {
  const what = "category" in view.of ? view.of.category : listed(view.of.merchants);
  const count = view.days.length;
  return `${what} in ${monthLabel(`${view.month}-01`)}: ${count} ${count === 1 ? "day" : "days"}`;
}

// --- trend --------------------------------------------------------------------------------------

export type TrendBar = {
  month: string;
  // "Oct 2026".
  label: string;
  spending: number;
  budget: number | null;
  // The picture's own month, in full color; the 6 before it are muted.
  current: boolean;
};

export function trendBars(view: TrendPictureView): TrendBar[] {
  return view.months.map((each, index) => ({
    ...each,
    label: monthLabel(`${each.month}-01`),
    current: index === view.months.length - 1,
  }));
}

// "Groceries, Apr 2026 to Oct 2026. The dashed line is the Budget."
export function trendCaption(view: TrendPictureView): string {
  const first = view.months[0]?.month ?? "";
  const last = view.months.at(-1)?.month ?? "";
  const range = `${view.category}, ${monthLabel(`${first}-01`)} to ${monthLabel(`${last}-01`)}.`;
  return view.months.some((each) => each.budget !== null)
    ? `${range} The dashed line is the Budget.`
    : `${range} No Budget yet.`;
}

// --- cards and recurring ------------------------------------------------------------------------

// One bar of a bar list: a name, the words after it, and the amount the bar draws.
export type BarRow = { key: string; name: string; words: string; amount: number; flag?: string };

// Each card's balance owed in whole dollars, its APR as a whole percent, and the promo mark with
// the month it ends, as a chart labels it.
export function cardRows(view: CardsPictureView): BarRow[] {
  return view.cards.map((card) => ({
    key: card.id,
    name: card.name,
    words:
      card.apr === null
        ? wholeDollars(card.owed)
        : `${wholeDollars(card.owed)} · ${percent(card.apr / 100)} APR`,
    amount: card.owed,
    ...(card.promoEnds === null ? {} : { flag: `⚑ promo ends ${monthLabel(card.promoEnds)}` }),
  }));
}

export function cardsCaption(view: CardsPictureView): string {
  return view.cards.some((card) => card.promoEnds !== null)
    ? "Each card's balance owed and APR. ⚑ marks where a promo ends."
    : "Each card's balance owed and APR.";
}

// Each charge's latest amount, in cents, since one charge shows (spec 07, Number formats).
export function recurringRows(view: RecurringPictureView): BarRow[] {
  return view.charges.map((charge) => ({
    key: charge.id,
    name: charge.merchantName,
    words: dollarsAndCents(charge.amount),
    amount: charge.amount,
  }));
}

// "Streaming: 2 monthly Recurring charges, $27 a month".
export function recurringCaption(view: RecurringPictureView): string {
  const count = view.charges.length;
  const total = view.charges.reduce((sum, charge) => sum + charge.amount, 0);
  return `${view.category}: ${count} monthly Recurring ${count === 1 ? "charge" : "charges"}, ${wholeDollars(total)} a month`;
}
