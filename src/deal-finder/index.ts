// The deal-finder module's interface (spec 15, Deal finder). Other modules import from here.
export type {
  Costed,
  FoundStore,
  PriceSourceAdapter,
  PriceSourceErrorKind,
  PriceSourceKeys,
  ProductRead,
  StoreLocation,
  WeeklyAdItem,
} from "./adapter.ts";
export { PriceSourceError } from "./adapter.ts";
export {
  buildShoppingPlan,
  deliveryFeeOf,
  findDeals,
  type PlanDeal,
  type PlanDeals,
  type PlanInput,
  type PlanLine,
  type PlanStore,
  packagesToBuy,
  planTotals,
  type ShoppingPlanResult,
  type StoreDeals,
} from "./plan.ts";
export { priceSourceSettings, readPriceSourceKeys } from "./settings.ts";
export * from "./view.ts";
