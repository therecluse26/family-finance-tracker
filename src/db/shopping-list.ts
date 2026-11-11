import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database, Queries } from "./client.ts";
import {
  LIST_ITEM_UNITS,
  type ListItemSnapshot,
  shoppingListChanges,
  shoppingListItems,
} from "./schema.ts";

// The Shopping list's List items in app.db (spec 15, Shopping list), and the changes Chat makes to
// it with their Undo. Each write that may pass the list's cap counts and writes in one transaction,
// on app.db's one write queue, so two writes at once never pass it.

export type StoredListItem = typeof shoppingListItems.$inferSelect;
export type StoredShoppingListChange = typeof shoppingListChanges.$inferSelect;
export type ListItemUnit = (typeof LIST_ITEM_UNITS)[number];

// The fields a Member or the AI sets on a List item.
export type ListItemFields = {
  words: string;
  quantity: number;
  unit: ListItemUnit;
  brandLock: string | null;
  note: string | null;
};
export type ListItemChanges = Partial<ListItemFields & { ticked: boolean }>;

// Every List item, in its place on the list.
export async function listShoppingListItems(database: Queries): Promise<StoredListItem[]> {
  return database
    .select()
    .from(shoppingListItems)
    .orderBy(
      asc(shoppingListItems.place),
      asc(shoppingListItems.addedAt),
      asc(shoppingListItems.id),
    );
}

// The search words the AI wrote were for the List item's words and brand lock: a change to either
// clears them. SET reads the row as it was.
const searchWordsAfter = (changes: ListItemChanges) =>
  changes.words === undefined && changes.brandLock === undefined
    ? sql`${shoppingListItems.searchWords}`
    : sql`CASE WHEN ${shoppingListItems.words} IS ${changes.words ?? shoppingListItems.words}
        AND ${shoppingListItems.brandLock} IS ${
          changes.brandLock === undefined ? shoppingListItems.brandLock : changes.brandLock
        } THEN ${shoppingListItems.searchWords} END`;

// Changes one List item. False when no List item has the ID.
export async function changeShoppingListItem(
  database: Queries,
  id: string,
  changes: ListItemChanges,
): Promise<boolean> {
  if (changes.unit !== undefined && !LIST_ITEM_UNITS.includes(changes.unit)) {
    throw new RangeError("Unknown List item unit.");
  }
  const changed = await database
    .update(shoppingListItems)
    .set({ ...changes, searchWords: searchWordsAfter(changes) })
    .where(eq(shoppingListItems.id, id))
    .returning({ id: shoppingListItems.id });
  return changed.length === 1;
}

// Removes one List item. False when no List item has the ID.
export async function removeShoppingListItem(database: Queries, id: string): Promise<boolean> {
  const removed = await database
    .delete(shoppingListItems)
    .where(eq(shoppingListItems.id, id))
    .returning({ id: shoppingListItems.id });
  return removed.length === 1;
}

// "Clear ticked items": removes every ticked List item, and keeps the rest. The count removed.
export async function clearTickedListItems(database: Queries): Promise<number> {
  const removed = await database
    .delete(shoppingListItems)
    .where(eq(shoppingListItems.ticked, true))
    .returning({ id: shoppingListItems.id });
  return removed.length;
}

const snapshotOf = (item: StoredListItem): ListItemSnapshot => ({
  ...item,
  addedAt: item.addedAt.toISOString(),
});

const rowOf = (item: ListItemSnapshot): StoredListItem => ({
  ...item,
  addedAt: new Date(item.addedAt),
});

// One change of an edit: add a List item, change one, or remove one.
export type ShoppingListOp =
  | { op: "add"; id: string; fields: ListItemFields }
  | { op: "change"; id: string; changes: ListItemChanges }
  | { op: "remove"; id: string };

export type ShoppingListEditResult =
  | { applied: StoredShoppingListChange }
  | { refused: "no item"; id: string }
  | { refused: "full" };

// Applies an edit Chat's AI made, all its changes at once or none, and keeps it for its card and
// Undo. Each change or remove names a List item on the list, and each List item takes at most one
// change; the caller checks the second. The list after it holds at most `max` List items.
export async function applyShoppingListEdit(
  database: Database,
  edit: {
    id: string;
    threadId: string;
    answerId: string;
    madeBy: string | null;
    madeAt: Date;
    ops: readonly ShoppingListOp[];
  },
  max: number,
): Promise<ShoppingListEditResult> {
  return database.transaction(async (tx) => {
    const items = await listShoppingListItems(tx);
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const op of edit.ops) {
      if (op.op !== "add" && !byId.has(op.id)) return { refused: "no item", id: op.id };
    }
    const adds = edit.ops.filter((op) => op.op === "add").length;
    const removes = edit.ops.filter((op) => op.op === "remove").length;
    if (items.length + adds - removes > max) return { refused: "full" };

    let place = Math.max(-1, ...items.map((item) => item.place)) + 1;
    const touched: StoredShoppingListChange["items"] = [];
    for (const op of edit.ops) {
      if (op.op === "add") {
        const [added] = await tx
          .insert(shoppingListItems)
          .values({
            id: op.id,
            ...op.fields,
            ticked: false,
            place: place++,
            addedAt: edit.madeAt,
            addedBy: edit.madeBy,
          })
          .returning();
        if (added === undefined) throw new Error("The List item was not added.");
        touched.push({ before: null, after: snapshotOf(added) });
      } else if (op.op === "change") {
        const [changed] = await tx
          .update(shoppingListItems)
          .set({ ...op.changes, searchWords: searchWordsAfter(op.changes) })
          .where(eq(shoppingListItems.id, op.id))
          .returning();
        const before = byId.get(op.id);
        if (changed === undefined || before === undefined) throw new Error("No List item.");
        touched.push({ before: snapshotOf(before), after: snapshotOf(changed) });
      } else {
        const before = byId.get(op.id);
        if (before === undefined) throw new Error("No List item.");
        await tx.delete(shoppingListItems).where(eq(shoppingListItems.id, op.id));
        touched.push({ before: snapshotOf(before), after: null });
      }
    }
    const [applied] = await tx
      .insert(shoppingListChanges)
      .values({
        id: edit.id,
        threadId: edit.threadId,
        answerId: edit.answerId,
        items: touched,
        madeAt: edit.madeAt,
        madeBy: edit.madeBy,
      })
      .returning();
    if (applied === undefined) throw new Error("The change was not kept.");
    return { applied };
  });
}

// The fields a Member sees: Undo checks that each List item the change touched still shows as the
// change left it.
const sameOnList = (stored: StoredListItem, kept: ListItemSnapshot) =>
  stored.words === kept.words &&
  stored.quantity === kept.quantity &&
  stored.unit === kept.unit &&
  stored.brandLock === kept.brandLock &&
  stored.note === kept.note &&
  stored.ticked === kept.ticked;

export type ShoppingListUndoResult =
  | "undone"
  | "no change"
  | "undone already"
  | "changed since"
  | "full";

// Undo on a Shopping list change's card: each List item it touched goes back as it was, with its
// ID and place, all at once or none. It refuses when one of them changed since, so it never undoes
// a Member's later edit, and when the list would then hold more than `max` List items.
export async function undoShoppingListChange(
  database: Database,
  id: string,
  by: { memberId: string; at: Date },
  max: number,
): Promise<ShoppingListUndoResult> {
  return database.transaction(async (tx) => {
    const [change] = await tx
      .select()
      .from(shoppingListChanges)
      .where(eq(shoppingListChanges.id, id));
    if (change === undefined) return "no change";
    if (change.undoneAt !== null) return "undone already";
    const ids = change.items.flatMap((each) => [each.before?.id, each.after?.id]);
    const wanted = [...new Set(ids.filter((each) => each !== undefined))];
    const current = new Map(
      (await tx.select().from(shoppingListItems).where(inArray(shoppingListItems.id, wanted))).map(
        (item) => [item.id, item],
      ),
    );
    for (const { before, after } of change.items) {
      const itemId = (after ?? before)?.id ?? "";
      const now = current.get(itemId);
      if (after === null ? now !== undefined : now === undefined || !sameOnList(now, after)) {
        return "changed since";
      }
    }
    const puts = change.items.filter((each) => each.after === null).length;
    const takes = change.items.filter((each) => each.before === null).length;
    if (puts > takes) {
      const [listed] = await tx.select({ count: count() }).from(shoppingListItems);
      if ((listed?.count ?? 0) + puts - takes > max) return "full";
    }
    for (const { before, after } of change.items) {
      if (before === null && after !== null) {
        await tx.delete(shoppingListItems).where(eq(shoppingListItems.id, after.id));
      } else if (before !== null && after === null) {
        await tx.insert(shoppingListItems).values(rowOf(before));
      } else if (before !== null) {
        const { id: itemId, words, quantity, unit, brandLock, note, ticked } = before;
        await tx
          .update(shoppingListItems)
          .set({
            words,
            quantity,
            unit,
            brandLock,
            note,
            ticked,
            searchWords: sql`CASE WHEN ${shoppingListItems.words} IS ${words}
              AND ${shoppingListItems.brandLock} IS ${brandLock}
              THEN ${shoppingListItems.searchWords} ELSE ${before.searchWords} END`,
          })
          .where(eq(shoppingListItems.id, itemId));
      }
    }
    const undone = await tx
      .update(shoppingListChanges)
      .set({ undoneAt: by.at, undoneBy: by.memberId })
      .where(and(eq(shoppingListChanges.id, id), isNull(shoppingListChanges.undoneAt)))
      .returning({ id: shoppingListChanges.id });
    if (undone.length !== 1) throw new Error("The change was undone already.");
    return "undone";
  });
}

// The Shopping list changes Chat made in a thread, oldest first, for their cards.
export async function listShoppingListChanges(
  database: Queries,
  threadId: string,
): Promise<StoredShoppingListChange[]> {
  return database
    .select()
    .from(shoppingListChanges)
    .where(eq(shoppingListChanges.threadId, threadId))
    .orderBy(asc(shoppingListChanges.madeAt), asc(shoppingListChanges.id));
}
