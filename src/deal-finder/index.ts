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
export { type PriceSourceReaderOptions, priceSourceReaders } from "./readers/index.ts";
export { priceSourceSettings, readPriceSourceKeys } from "./settings.ts";
export {
  editShoppingList,
  shoppingList,
  shoppingListCards,
  shoppingListForChat,
} from "./shopping-list.ts";
export * from "./shopping-list-view.ts";
export * from "./view.ts";
