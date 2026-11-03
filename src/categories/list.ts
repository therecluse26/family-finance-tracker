// The fixed Category list (spec 04, Categories and Category groups; ADR 0007). v1 ships 30
// Categories in 6 Category groups. Members cannot add, rename, or remove a Category, so the list
// is frozen and no route changes it. Each Category has a one-line definition for AI prompts: the
// spec's "What goes where" text where it has one, else what the Category covers in the
// Transaction categorization research, section 7.3.

export const CATEGORY_GROUPS = deepFreeze([
  {
    name: "Bills",
    categories: [
      {
        name: "Housing",
        definition: "Rent and property tax. Mortgage principal and escrow follow Money movement.",
      },
      { name: "Utilities", definition: "Electricity, gas, water, sewer, and trash bills" },
      { name: "Phone and internet", definition: "Phone, internet, and cable bills" },
      { name: "Insurance", definition: "Auto, home, health, and life insurance" },
      { name: "Taxes and government", definition: "Income tax payments" },
      {
        name: "Interest and fees",
        definition:
          "Card interest, card fees, and bank fees, such as ATM, overdraft, late, and annual fees. The interest in every loan payment.",
      },
    ],
  },
  {
    name: "Shopping",
    categories: [
      { name: "Groceries", definition: "Food for home, from grocery stores and farmers' markets" },
      {
        name: "Superstores",
        definition:
          "Every Merchant that sells groceries and general goods together: Walmart, Target, Costco, Sam's Club, BJ's, Amazon, and dollar stores. A purchase these Merchants already show apart keeps its own Category. Examples: Costco gas, Whole Foods, and an Amazon Prime membership.",
      },
      { name: "Clothing", definition: "Clothes, shoes, jewelry, and dry cleaning" },
      { name: "Home and garden", definition: "Home repairs and upkeep" },
      { name: "Alcohol and tobacco", definition: "Liquor stores, tobacco, and vape" },
      {
        name: "General goods",
        definition: "Mixed goods from other stores, including Etsy and eBay",
      },
    ],
  },
  {
    name: "Transportation",
    categories: [
      { name: "Gas", definition: "Fuel and EV charging" },
      { name: "Car", definition: "Car repairs and upkeep, and vehicle registration" },
      {
        name: "Transit and rideshare",
        definition: "Buses, trains, taxis, rideshare, and bike or scooter rentals",
      },
    ],
  },
  {
    name: "Health and care",
    categories: [
      { name: "Health", definition: "Doctors, dentists, eye care, and pharmacies" },
      { name: "Personal care", definition: "Hair, beauty, and spa" },
      { name: "Childcare", definition: "Daycare and babysitters" },
      { name: "Pets", definition: "Pet supplies, pet food, and vets" },
      { name: "Fitness", definition: "Gyms and fitness classes" },
    ],
  },
  {
    name: "Leisure",
    categories: [
      { name: "Restaurants", definition: "Meals, coffee, takeout, and delivery" },
      { name: "Entertainment", definition: "Streaming, events, games, and music" },
      { name: "Hobbies", definition: "Sporting goods, toys, crafts, and hobby supplies" },
      { name: "Travel", definition: "Flights, hotels, and rental cars" },
      { name: "Books and education", definition: "Tuition, school fees, books, and news" },
    ],
  },
  {
    name: "Other",
    categories: [
      { name: "Gifts and donations", definition: "Charity and cash gifts" },
      {
        name: "Payments to people",
        definition:
          "Payments to a person by Zelle, Venmo, Cash App, or PayPal, and money added to Venmo or PayPal",
      },
      { name: "Cash", definition: "Cash withdrawals, and cash back at a checkout" },
      { name: "Services", definition: "Legal, accounting, postage, and other services" },
      {
        name: "Miscellaneous",
        definition:
          "The fallback when nothing else fits, and payments to a card the app does not track",
      },
    ],
  },
] as const);

export type CategoryGroup = (typeof CATEGORY_GROUPS)[number]["name"];
export type Category = (typeof CATEGORY_GROUPS)[number]["categories"][number]["name"];

export type CategoryDetails = { name: Category; group: CategoryGroup; definition: string };

// Every Category in the spec's order: by Category group, then within it.
export const CATEGORIES: readonly CategoryDetails[] = Object.freeze(
  CATEGORY_GROUPS.flatMap((group) =>
    group.categories.map((category) => Object.freeze({ ...category, group: group.name })),
  ),
);

const BY_NAME = new Map(CATEGORIES.map((category) => [category.name, category]));

export function isCategory(name: string): name is Category {
  return BY_NAME.has(name as Category);
}

export function categoryGroupOf(category: Category): CategoryGroup {
  const found = BY_NAME.get(category);
  if (found === undefined) throw new Error(`"${category}" is not a Category.`);
  return found.group;
}

// A Category group's total is the sum of its Categories. Amounts are whole cents. A Category with
// no amount adds nothing, and every Category group appears, at 0 when it has nothing.
export function categoryGroupTotals(
  totals: Partial<Record<Category, number>>,
): Record<CategoryGroup, number> {
  const sums = Object.fromEntries(CATEGORY_GROUPS.map((group) => [group.name, 0])) as Record<
    CategoryGroup,
    number
  >;
  for (const [name, cents] of Object.entries(totals) as [Category, number | undefined][]) {
    if (cents === undefined) continue;
    sums[categoryGroupOf(name)] += cents;
  }
  return sums;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}
