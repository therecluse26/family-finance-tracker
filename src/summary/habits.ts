import { type Category, categoryGroupOf, isCategory } from "../categories/index.ts";
import type { HabitSpending } from "../db/index.ts";
import { merchantKey } from "../merchants/index.ts";
import { merchantGroupOf } from "../recurring/index.ts";

// The Habit counts (spec 08, Household summary): frequency counts the app makes, per month, for the
// AI's Habits. The AI uses them as they are and never counts again. Each counts Spending by its
// purchase date, before Refunds: a Habit is what the Household does, not what it got back.

// The food delivery services whose orders count as delivery orders. The app ships this list.
export const DELIVERY_SERVICES = [
  "DoorDash",
  "Uber Eats",
  "Grubhub",
  "Postmates",
  "Seamless",
  "Caviar",
  "Gopuff",
] as const;

// How many Merchants the most frequent list holds.
export const FREQUENT_MERCHANTS = 10;

const DELIVERY_KEYS = DELIVERY_SERVICES.map(merchantKey);
const wordsOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const DELIVERY_WORDS = DELIVERY_SERVICES.map(wordsOf);

// Whether a Merchant is a food delivery service on the list: its whole name, in any case and with
// any spacing or punctuation, such as "UBEREATS" or "Door Dash", or the name followed by the
// restaurant, such as "DoorDash Chipotle" or "DOORDASH*TAQUERIA".
export function isDeliveryService(merchantName: string): boolean {
  const key = merchantKey(merchantName);
  if (DELIVERY_KEYS.includes(key)) return true;
  const words = wordsOf(merchantName);
  return [...DELIVERY_WORDS, ...DELIVERY_KEYS].some((service) => words.startsWith(`${service} `));
}

// A Merchant's Transactions and Spending in whole cents, and its average Transaction: the
// Spending ÷ the Transactions, to the cent.
export type FrequentMerchant = { name: string; count: number; total: number; average: number };

// How many Merchants each Category's top list holds.
export const TOP_MERCHANTS = 3;

export type MonthHabits = {
  month: string;
  // Transactions with Spending in Restaurants.
  mealsOut: number;
  // Restaurants Spending ÷ meals out, in whole cents, or null with no meal out.
  averageMealOut: number | null;
  // Transactions at a food delivery service.
  deliveryOrders: number;
  // Each flexible Category with Spending: the share of it, from 0 to 1, made Friday to Sunday.
  fridayToSunday: { category: Category; share: number }[];
  // The 10 Merchants with the most Transactions, most first, with their Spending in whole cents.
  frequentMerchants: FrequentMerchant[];
};

// Friday, Saturday, or Sunday, for a date written YYYY-MM-DD.
function fromFridayToSunday(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 5 || day === 6 || day === 0;
}

// Each month's Habit counts from its Spending parts, in the order of `months` (YYYY-MM).
export function habitCounts(
  spending: readonly HabitSpending[],
  months: readonly string[],
): MonthHabits[] {
  const byMonth = new Map<string, HabitSpending[]>(months.map((month) => [month, []]));
  for (const part of spending) byMonth.get(part.date.slice(0, 7))?.push(part);
  return months.map((month) => {
    const parts = byMonth.get(month) ?? [];
    const meals = new Set<string>();
    let restaurants = 0;
    const delivery = new Set<string>();
    const flexible = new Map<Category, { all: number; fridayToSunday: number }>();
    const merchants = new Map<string, { name: string; txns: Set<string>; total: number }>();
    for (const part of parts) {
      if (part.category === "Restaurants") {
        meals.add(part.transactionId);
        restaurants += part.amount;
      }
      if (part.merchantName !== null && isDeliveryService(part.merchantName)) {
        delivery.add(part.transactionId);
      }
      if (
        part.category !== null &&
        isCategory(part.category) &&
        categoryGroupOf(part.category) !== "Bills"
      ) {
        const sum = flexible.get(part.category) ?? { all: 0, fridayToSunday: 0 };
        sum.all += part.amount;
        if (fromFridayToSunday(part.date)) sum.fridayToSunday += part.amount;
        flexible.set(part.category, sum);
      }
      addMerchant(merchants, part);
    }
    return {
      month,
      mealsOut: meals.size,
      averageMealOut: meals.size === 0 ? null : Math.round(restaurants / meals.size),
      deliveryOrders: delivery.size,
      fridayToSunday: [...flexible]
        .filter(([, sum]) => sum.all > 0)
        .map(([category, sum]) => ({ category, share: Math.max(0, sum.fridayToSunday) / sum.all }))
        .sort((a, b) => a.category.localeCompare(b.category)),
      frequentMerchants: merchantList(merchants)
        .sort((a, b) => b.count - a.count || b.total - a.total || a.name.localeCompare(b.name))
        .slice(0, FREQUENT_MERCHANTS),
    };
  });
}

type MerchantSums = Map<string, { name: string; txns: Set<string>; total: number }>;

// Adds a Spending part to its Merchant's sums, by the Merchant's group, as the Recurring charges
// group Merchants. A part with no Merchant name adds nothing.
function addMerchant(merchants: MerchantSums, part: HabitSpending): void {
  if (part.merchantName === null || merchantKey(part.merchantName) === "") return;
  const group = merchantGroupOf({ id: part.merchantId, name: part.merchantName });
  const merchant = merchants.get(group) ?? { name: part.merchantName, txns: new Set(), total: 0 };
  merchant.txns.add(part.transactionId);
  merchant.total += part.amount;
  merchants.set(group, merchant);
}

const merchantList = (merchants: MerchantSums): FrequentMerchant[] =>
  [...merchants.values()].map(({ name, txns, total }) => ({
    name,
    count: txns.size,
    total,
    average: Math.round(total / txns.size),
  }));

// One Category's purchases in a month: its Transactions, and its top Merchants by Spending.
export type CategoryPurchases = { transactions: number; topMerchants: FrequentMerchant[] };

// Each Category's purchases in `month` (YYYY-MM), from the same Spending parts as the Habit
// counts, in one pass: how many Transactions it has, and its 3 Merchants with the most Spending,
// most first. A Transaction split across Categories counts in each.
export function categoryPurchases(
  spending: readonly HabitSpending[],
  month: string,
): Map<Category, CategoryPurchases> {
  const sums = new Map<Category, { txns: Set<string>; merchants: MerchantSums }>();
  for (const part of spending) {
    if (part.date.slice(0, 7) !== month || part.category === null) continue;
    if (!isCategory(part.category)) continue;
    const sum = sums.get(part.category) ?? { txns: new Set(), merchants: new Map() };
    sum.txns.add(part.transactionId);
    addMerchant(sum.merchants, part);
    sums.set(part.category, sum);
  }
  return new Map(
    [...sums].map(([category, { txns, merchants }]) => [
      category,
      {
        transactions: txns.size,
        topMerchants: merchantList(merchants)
          .filter((merchant) => merchant.total > 0)
          .sort((a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name))
          .slice(0, TOP_MERCHANTS),
      },
    ]),
  );
}
