import { type Category, isCategory } from "../categories/list.ts";

// A Category item's answer value on the Review list (spec 04, Review list items): a Category, which
// makes a rule, or a Category for only this Transaction. The server and the Review list page both
// read values here, so this file imports nothing from the database.

const ONLY_THIS = "only this Transaction: ";

export function categoryChoiceValue(category: Category, onlyThisTransaction: boolean): string {
  return onlyThisTransaction ? `${ONLY_THIS}${category}` : category;
}

// A Category item's answer: the Category, and whether it is for only this Transaction.
export function readCategoryChoice(
  value: string,
): { category: Category; onlyThisTransaction: boolean } | undefined {
  const only = value.startsWith(ONLY_THIS);
  const name = only ? value.slice(ONLY_THIS.length) : value;
  return isCategory(name) ? { category: name, onlyThisTransaction: only } : undefined;
}
