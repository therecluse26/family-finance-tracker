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
export { priceSourceSettings, readPriceSourceKeys } from "./settings.ts";
export * from "./view.ts";
