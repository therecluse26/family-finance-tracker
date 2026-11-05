import { budgetsForMonth } from "../budgets/index.ts";
import { isCategory } from "../categories/index.ts";
import { type Database, listCreditCards, listSpendingParts } from "../db/index.ts";
import { totalsByMonth } from "../money-movement/index.ts";
import { recurringCharges } from "../recurring/index.ts";
import type {
  CardsPictureView,
  DaysPictureView,
  PictureChoice,
  PictureType,
  PictureView,
  RecurringPictureView,
  TrendPictureView,
} from "./picture-view.ts";

// The app draws each picture on the menu from app.db (spec 08, Picture menu), and checks the choice
// against the data first. A choice the data does not bear out, such as an unknown Category or a
// Category with no Spending, draws nothing: null.

// How many months a trend picture shows: the month and the 6 before it.
export const TREND_MONTHS = 7;

type ChoiceOf<T extends PictureType> = Extract<PictureChoice, { type: T }>;
type ViewOf<T extends PictureType> = Extract<PictureView, { type: T }>;
type Draw<T extends PictureType> = (
  database: Database,
  choice: ChoiceOf<T>,
  month: string,
  now: Date,
) => Promise<ViewOf<T> | null>;

// YYYY-MM, `count` months before `month`.
function monthBefore(month: string, count: number): string {
  const [year = 0, number = 0] = month.split("-").map(Number);
  const index = year * 12 + number - 1 - count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

// YYYY-MM-DD, the last day of `month`.
function lastDayOf(month: string): string {
  const [year = 0, number = 0] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return `${month}-${String(days).padStart(2, "0")}`;
}

// A Merchant's name for matching the AI's spelling to the app's: case and spacing folded.
function merchantKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

// Each day in the month with Spending in the Category, or at the Merchants. Every Merchant named
// must have Spending in the month, so the picture never names one it does not mark.
const days: Draw<"days"> = async (database, choice, month) => {
  if ("category" in choice && !isCategory(choice.category)) return null;
  const parts = await listSpendingParts(database, { from: `${month}-01`, to: lastDayOf(month) });
  let of: DaysPictureView["of"];
  let found: typeof parts;
  if ("category" in choice) {
    of = { category: choice.category };
    found = parts.filter((part) => part.category === choice.category);
  } else {
    const keys = [...new Set(choice.merchants.map(merchantKey))];
    const names = new Map<string, string>();
    found = parts.filter((part) => {
      if (part.merchantCleanName === null) return false;
      const key = merchantKey(part.merchantCleanName);
      if (!keys.includes(key)) return false;
      if (!names.has(key)) names.set(key, part.merchantCleanName);
      return true;
    });
    const merchants = keys.map((key) => names.get(key));
    if (merchants.some((name) => name === undefined)) return null;
    of = { merchants: merchants as string[] };
  }
  // A Transaction with more than one Spending part counts once on its day.
  const byDay = new Map<string, Set<string>>();
  for (const part of found) {
    const ids = byDay.get(part.date) ?? new Set<string>();
    ids.add(part.transactionId);
    byDay.set(part.date, ids);
  }
  if (byDay.size === 0) return null;
  return {
    type: "days",
    month,
    of,
    days: [...byDay].map(([date, ids]) => ({ date, count: ids.size })),
  };
};

// The Category's Spending in each month, as the Budgets count it: a Refund or Reimbursement takes
// from it. A month's Budget is the monthly Budget in effect then; a yearly Budget gives none.
const trend: Draw<"trend"> = async (database, choice, month) => {
  const { category } = choice;
  if (!isCategory(category)) return null;
  const totals = new Map((await totalsByMonth(database)).map((each) => [each.month, each]));
  const months: TrendPictureView["months"] = [];
  for (let back = TREND_MONTHS - 1; back >= 0; back--) {
    const each = monthBefore(month, back);
    const { budgets } = await budgetsForMonth(database, each);
    const budget = budgets.find((b) => b.category === category && b.period === "monthly");
    months.push({
      month: each,
      spending: totals.get(each)?.byCategory[category] ?? 0,
      budget: budget?.amount ?? null,
    });
  }
  if (months.every((each) => each.spending <= 0)) return null;
  return { type: "trend", category, months };
};

// Each open credit card that is not Excluded, as Debt counts them. A card's APR is its purchase
// APR. No bank adapter sends a promo end date yet (CardDetails in src/bank/adapter.ts), so no card
// has one.
const cards: Draw<"cards"> = async (database) => {
  const found = await listCreditCards(database);
  if (found.length === 0) return null;
  const view: CardsPictureView["cards"] = found.map((card) => ({
    id: card.id,
    name: card.name,
    owed: Math.max(0, -(card.currentBalance ?? 0)),
    apr: card.aprs?.find((each) => each.type === "purchase_apr")?.apr ?? null,
    promoEnds: null,
  }));
  return { type: "cards", cards: view };
};

// The active Recurring charges in the Category that come monthly.
const recurring: Draw<"recurring"> = async (database, choice, _month, now) => {
  const { category } = choice;
  if (!isCategory(category)) return null;
  const charges: RecurringPictureView["charges"] = (await recurringCharges(database, now))
    .filter(
      (charge) =>
        charge.category === category && charge.status === "active" && charge.schedule === "monthly",
    )
    .map((charge) => ({
      id: charge.id,
      merchantName: charge.merchant.name,
      amount: charge.latestAmount,
    }))
    .sort((a, b) => b.amount - a.amount || a.merchantName.localeCompare(b.merchantName));
  if (charges.length === 0) return null;
  return { type: "recurring", category, charges };
};

// The menu: one drawing per picture type.
const MENU: { [T in PictureType]: Draw<T> } = { days, trend, cards, recurring };

// The picture a choice names, drawn for `month` (YYYY-MM), or null when the data does not bear the
// choice out. `cards` and `recurring` show today's cards and Recurring charges.
export async function drawPicture(
  database: Database,
  choice: PictureChoice,
  month: string,
  now = new Date(),
): Promise<PictureView | null> {
  const draw = MENU[choice.type] as Draw<PictureType>;
  return draw(database, choice as ChoiceOf<PictureType>, month, now);
}
