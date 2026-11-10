// The line-items module's interface (spec 14, Line items and Amazon orders). Other modules import
// from here.
export {
  badValue,
  cardLast4Of,
  centsOf,
  cleanItemName,
  ORDER_FILE_LIMITS,
  ORDER_FILE_NAME,
  type OrderFile,
  type OrderFileItem,
  type OrderFileLimits,
  type OrderFileRefusal,
  readOrderFile,
  SKIP_REASONS,
  type SkipCount,
  type UploadKind,
} from "./amazon.ts";
export {
  categorizeUnlinked,
  chooseLineItemCategories,
  deleteLineItemRule,
  LINE_ITEM_CATEGORY_TASK,
  lineItemCategoriesSettled,
  retryLineItemCategories,
  startLineItemCategories,
} from "./categories.ts";
export { LINE_ITEM_CATEGORY_KIND, updateLineItemCards } from "./category-cards.ts";
export {
  type ImportCounts,
  type ImportOutcome,
  importOrderFile,
  LineItemStoreError,
} from "./import.ts";
export {
  changeLineItemCategory,
  itemRules,
  type LineItemChange,
  type LineItemChangeResult,
  lineItemCategoryChoices,
  takesLineItemCategory,
} from "./item-rules.ts";
export {
  LINE_ITEM_STEPS,
  type LineItemStep,
  type LineItemStepName,
  lineItemsImported,
  lineItemsRemoved,
  registerLineItemsImported,
  registerLineItemsRemoved,
} from "./seams.ts";

// The Review list kind of an Amazon shipment that fits two or more Transactions (spec 14, Review
// list items). Linking registers it; the Amazon page counts its open items.
export const AMAZON_SHIPMENT_KIND = "Amazon shipment";
