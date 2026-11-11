// What the Shopping plan routes send the browser (spec 15, What the plan shows). This file imports
// nothing, so the web app's type check can follow it through api.ts. Money is whole cents; dates
// are YYYY-MM-DD in the Household time zone.

export type ShoppingPlanStoreKind = "in person" | "online" | "weekly ad only";

// A Deal that beats a List item's plan price.
export type ShoppingPlanDealView = {
  storeId: string;
  storeName: string;
  productId: string;
  productName: string;
  packages: number;
  price: number;
  total: number;
  // Empty when the source gave no end date.
  endsOn: string | null;
  saves: number;
  // The date of the price read.
  readOn: string;
};

// One List item at one Store.
export type ShoppingPlanLineView = {
  place: number;
  words: string;
  productName: string;
  packages: number;
  price: number;
  total: number;
  // "regular", a Deal a Member used, or a Costco online price.
  priceKind: "regular" | "deal" | "online";
  readOn: string;
  // For a Deal a Member used: its end date, if the source gave one.
  dealEndsOn: string | null;
  // Each Deal that beats this line at a Store already in the plan, best first.
  deals: ShoppingPlanDealView[];
};

export type ShoppingPlanStoreView = {
  storeId: string;
  name: string;
  kind: ShoppingPlanStoreKind;
  lines: ShoppingPlanLineView[];
  subtotal: number;
  deliveryFee: number;
};

// The Deals at a Store not in the plan. "Use this Deal" shows only when their saving pays for the
// trip.
export type ShoppingPlanElsewhereView = {
  storeId: string;
  name: string;
  kind: ShoppingPlanStoreKind;
  saving: number;
  paysForTrip: boolean;
  deals: (ShoppingPlanDealView & { place: number; words: string })[];
};

export type ShoppingPlanView = {
  planId: string;
  // The day the plan was built.
  builtOn: string;
  today: string;
  tripSaving: number;
  stores: ShoppingPlanStoreView[];
  notFound: { place: number; words: string }[];
  total: number;
  trips: number;
  // Against the best one-Store plan. Empty when no one Store finds as many List items.
  saving: number | null;
  elsewhere: ShoppingPlanElsewhereView[];
  // Each Store that could not be read, with its reason.
  failures: { storeId: string; name: string; reason: string }[];
};

// Why "Use this Deal" was refused, or that it was used.
export type TakeDealOutcome = "used" | "no plan" | "plan changed" | "no line" | "no deal";

export type ShoppingPlanRoutes = {
  // The last plan, as it stands today: undefined before the first plan is built.
  view(): Promise<ShoppingPlanView | undefined>;
  takeDeal(
    deal: { planId: string; place: number; productId: string },
    memberId: string,
  ): Promise<TakeDealOutcome>;
  // Back to the regular price. False when the line used no Deal.
  dropDeal(line: { planId: string; place: number }): Promise<boolean>;
};
