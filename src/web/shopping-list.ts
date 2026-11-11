import type {
  ListItemChangeInput,
  ListItemInput,
  ShoppingListView,
} from "../deal-finder/shopping-list-view.ts";
import { api } from "./api.ts";

// The Shopping list's requests (spec 15, Shopping list), from its page and from a Shopping list
// change's card in Chat. Every write but removing a List item sends a JSON body, and each answer
// holds the whole list after it, or the error the page shows.

const list = api["shopping-list"];

export const loadShoppingList = () => list.$get();
export const addListItem = (item: ListItemInput) => list.items.$post({ json: item });
// A route with a path parameter and a JSON body takes the body through a variable: the client's
// type names only the parameter.
export const changeListItem = (id: string, changes: ListItemChangeInput) => {
  const request = { param: { id }, json: changes };
  return list.items[":id"].$put(request);
};
export const removeListItem = (id: string) => list.items[":id"].$delete({ param: { id } });
export const clearTickedItems = () => list["clear-ticked"].$post({ json: {} });
export const saveDietaryNeeds = (dietaryNeeds: string) =>
  list["dietary-needs"].$put({ json: { dietaryNeeds } });
export const saveTripSaving = (tripSaving: number) =>
  list["trip-setting"].$put({ json: { tripSaving } });
export const undoShoppingListChange = (id: string) => {
  const request = { param: { id }, json: {} };
  return list.changes[":id"].undo.$post(request);
};

// A write's answer: the list after it, or the error to show.
export async function answerOf(
  res: Response,
): Promise<{ view: ShoppingListView } | { error: string }> {
  const body = (await res.json().catch(() => ({}))) as { shoppingList?: unknown; error?: unknown };
  if (res.ok && typeof body.shoppingList === "object" && body.shoppingList !== null) {
    return { view: body.shoppingList as ShoppingListView };
  }
  return { error: typeof body.error === "string" ? body.error : "That did not work." };
}
