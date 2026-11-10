// The categories module's interface (spec 04, Categories and Category groups). Other modules
// import from here.
export {
  CATEGORIES,
  CATEGORY_GROUPS,
  type Category,
  type CategoryDetails,
  type CategoryGroup,
  categoryGroupOf,
  categoryGroupTotals,
  isCategory,
  LINE_ITEM_CATEGORIES,
  NOT_FOR_LINE_ITEMS,
} from "./list.ts";
export { isSuperstore, SUPERSTORES } from "./superstores.ts";
