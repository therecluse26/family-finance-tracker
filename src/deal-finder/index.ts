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
  DIETARY_DISCLAIMER,
  PRODUCT_MATCH_TASK,
  rememberMatchChoice,
  SEARCH_WORDS_TASK,
  showsDietaryDisclaimer,
} from "./match.ts";
export type { ProductDataAdapter, ProductFacts } from "./product-data.ts";
export { type PriceSourceReaderOptions, priceSourceReaders } from "./readers/index.ts";
export {
  checkProduct,
  PlanRunJob,
  type PlanRunNotices,
  type PlanRunOptions,
  type PlanRuns,
  PriceHistoryPruneJob,
  planRuns,
  prunePriceHistory,
  startPlanRuns,
  startPriceHistoryPrune,
} from "./run.ts";
export * from "./run-view.ts";
export { priceSourceSettings, readPriceSourceKeys } from "./settings.ts";
export {
  editShoppingList,
  shoppingList,
  shoppingListCards,
  shoppingListForChat,
} from "./shopping-list.ts";
export * from "./shopping-list-view.ts";
export {
  type ListItemUnit,
  type PackageSize,
  packagesToBuy,
  productSize,
  readSize,
  unitPrice,
} from "./sizes.ts";
export * from "./view.ts";
