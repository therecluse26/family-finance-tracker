import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listShoppingListItems, removeMember } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { newTestDatabase, type TestDatabase } from "../db/testing.ts";
import {
  editShoppingList,
  type ListItemInput,
  MAX_LIST_ITEMS,
  SHOPPING_LIST_RULES,
  type ShoppingList,
  type ShoppingListEditInput,
  shoppingList,
  shoppingListCards,
  shoppingListForChat,
} from "./index.ts";

// The Household's one Shopping list (spec 15, Shopping list; Chat tools): its rules, its cap of
// 100 List items, Chat's edits of up to 30 changes with Undo, and two writes at once. Every List
// item, Member and thread here is made up.

const AT = new Date("2026-11-11T15:00:00.000Z");
const LATER = new Date("2026-11-11T16:00:00.000Z");

let test: TestDatabase;
let list: ShoppingList;
let clock: Date;

// One SQL statement on the test database, for a write no route makes.
const run = (sql: string, ...args: string[]) => test.database.$client.execute({ sql, args });

beforeEach(async () => {
  test = await newTestDatabase();
  clock = AT;
  list = shoppingList({ database: test.database, now: () => clock });
  await test.database.insert(schema.members).values(
    ["dana", "ravi"].map((id) => ({
      id,
      name: id === "dana" ? "Dana Whitfield" : "Ravi Okafor",
      email: `${id}@example.com`,
      createdAt: AT,
      updatedAt: AT,
    })),
  );
  await test.database
    .insert(schema.chatThreads)
    .values({ id: "thread-1", title: "Groceries", createdAt: AT, lastMessageAt: AT });
});

afterEach(() => {
  test.close();
});

const rows = () => listShoppingListItems(test.database);
const everyRow = async () => ({
  items: await rows(),
  changes: await test.database.select().from(schema.shoppingListChanges),
  settings: await test.database.select().from(schema.dealFinderSettings),
});

const BEEF: ListItemInput = { words: "ground beef", quantity: 2, unit: "lb" };
const by = { threadId: "thread-1", answerId: "answer-1", memberId: "dana", at: AT };

async function added(input: ListItemInput, member = "dana"): Promise<string> {
  const outcome = await list.add(member, input);
  if (!("view" in outcome)) throw new Error(`Refused: ${JSON.stringify(outcome)}`);
  const item = outcome.view.items.at(-1);
  if (item === undefined) throw new Error("Nothing added.");
  return item.id;
}

// `count` plain List items, straight into app.db.
async function filled(count: number) {
  await test.database.insert(schema.shoppingListItems).values(
    Array.from({ length: count }, (_, n) => ({
      id: `filled-${n}`,
      words: `item ${n}`,
      quantity: 1,
      unit: "each" as const,
      place: n,
      addedAt: AT,
    })),
  );
}

async function edited(edits: ShoppingListEditInput[], answerId = "answer-1") {
  const result = await editShoppingList(test.database, edits, { ...by, answerId });
  if (!("changeId" in result)) throw new Error(`Refused: ${result.error}`);
  return result.changeId;
}

describe("the Shopping list page's writes", () => {
  it("adds, edits, ticks and removes List items, each in its place, and Clear ticked items removes only ticked ones", async () => {
    const beef = await added(BEEF);
    const eggs = await added({ words: " eggs ", quantity: 12, unit: "ct", note: "large" });
    const jif = await added({
      words: "peanut butter",
      quantity: 1,
      unit: "each",
      brandLock: "Jif",
      note: "",
    });

    expect(await list.change(eggs, { quantity: 18, ticked: true })).toMatchObject({
      view: { items: [{ id: beef }, { id: eggs, quantity: 18, ticked: true }, { id: jif }] },
    });
    await list.change(jif, { brandLock: "" });
    const shown = await list.view();
    expect(shown).toEqual({
      items: [
        {
          id: beef,
          words: "ground beef",
          quantity: 2,
          unit: "lb",
          brandLock: null,
          note: null,
          ticked: false,
        },
        {
          id: eggs,
          words: "eggs",
          quantity: 18,
          unit: "ct",
          brandLock: null,
          note: "large",
          ticked: true,
        },
        {
          id: jif,
          words: "peanut butter",
          quantity: 1,
          unit: "each",
          brandLock: null,
          note: null,
          ticked: false,
        },
      ],
      dietaryNeeds: "",
      tripSaving: 1000,
      maxItems: MAX_LIST_ITEMS,
    });
    expect((await rows()).map((item) => [item.place, item.addedBy])).toEqual([
      [0, "dana"],
      [1, "dana"],
      [2, "dana"],
    ]);

    // Clear ticked items: only the ticked one goes.
    expect(await list.clearTicked()).toMatchObject({
      view: { items: [{ id: beef }, { id: jif }] },
    });
    expect(await list.remove(beef)).toMatchObject({ view: { items: [{ id: jif }] } });
  });

  it("changes only the List item it names, and refuses an ID no List item has with no change", async () => {
    const beef = await added(BEEF);
    const eggs = await added({ words: "eggs", quantity: 12, unit: "ct" });
    await list.change(beef, { words: "ground turkey" });
    expect((await rows()).map((item) => item.words)).toEqual(["ground turkey", "eggs"]);

    const before = await everyRow();
    expect(await list.change("no-such-item", { ticked: true })).toEqual({ refused: "no item" });
    expect(await list.remove("no-such-item")).toEqual({ refused: "no item" });
    expect(await everyRow()).toEqual(before);
    expect((await rows()).map((item) => item.id)).toEqual([beef, eggs]);
  });

  it("clears the AI's search words when the words or the brand lock change, and keeps them otherwise", async () => {
    const beef = await added(BEEF);
    const searched = () =>
      run(
        "UPDATE shopping_list_items SET search_words = ? WHERE id = ?",
        "ground beef 80/20",
        beef,
      );
    const searchWords = async () => (await rows())[0]?.searchWords;

    await searched();
    await list.change(beef, { quantity: 3, ticked: true, words: "ground beef" });
    expect(await searchWords()).toBe("ground beef 80/20");
    await list.change(beef, { words: "ground chuck" });
    expect(await searchWords()).toBeNull();
    await searched();
    await list.change(beef, { brandLock: "Fake Farms" });
    expect(await searchWords()).toBeNull();
  });

  it("refuses each broken rule by name and changes nothing", async () => {
    const beef = await added(BEEF);
    const before = await everyRow();
    const cases: [ListItemInput, keyof typeof SHOPPING_LIST_RULES][] = [
      [{ ...BEEF, words: "   " }, "words"],
      [{ ...BEEF, words: "x".repeat(101) }, "words"],
      [{ ...BEEF, quantity: 0 }, "quantity"],
      [{ ...BEEF, quantity: -1 }, "quantity"],
      [{ ...BEEF, quantity: 1.234 }, "quantity"],
      [{ ...BEEF, quantity: Number.NaN }, "quantity"],
      [{ ...BEEF, quantity: 10_000 }, "quantity"],
      [{ ...BEEF, unit: "kg" as ListItemInput["unit"] }, "unit"],
      [{ ...BEEF, brandLock: "j".repeat(61) }, "brandLock"],
      [{ ...BEEF, note: "n".repeat(201) }, "note"],
    ];
    for (const [input, rule] of cases) {
      expect([input, await list.add("dana", input)]).toEqual([input, { refused: "rule", rule }]);
      const { words: _words, ...changes } = input;
      if (rule !== "words") {
        expect(await list.change(beef, changes)).toEqual({ refused: "rule", rule });
      }
    }
    expect(await list.change(beef, {})).toEqual({ refused: "rule", rule: "nothing" });
    expect(await list.setDietaryNeeds("d".repeat(301))).toEqual({
      refused: "rule",
      rule: "dietaryNeeds",
    });
    for (const cents of [-1, 1.5, 1_000_001]) {
      expect(await list.setTripSaving(cents)).toEqual({ refused: "rule", rule: "tripSaving" });
    }
    expect(await everyRow()).toEqual(before);
  });

  it("saves the dietary needs and the trip setting, and keeps the rest of the deal finder settings", async () => {
    await test.database
      .insert(schema.dealFinderSettings)
      .values({ id: 1, costCap: 700, openFoodFacts: true });
    expect(await list.setDietaryNeeds("  no peanuts, gluten-free  ")).toMatchObject({
      view: { dietaryNeeds: "no peanuts, gluten-free", tripSaving: 1000 },
    });
    expect(await list.setTripSaving(0)).toMatchObject({ view: { tripSaving: 0 } });
    expect(await list.setTripSaving(1_000_000)).toMatchObject({ view: { tripSaving: 1_000_000 } });
    expect(await list.setDietaryNeeds("")).toMatchObject({ view: { dietaryNeeds: "" } });
    expect(await test.database.select().from(schema.dealFinderSettings)).toMatchObject([
      { costCap: 700, openFoodFacts: true, tripSaving: 1_000_000, dietaryNeeds: "" },
    ]);
  });

  it("holds at most 100 List items, even for adds sent together", async () => {
    await filled(95);
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, n) => list.add("dana", { ...BEEF, words: `beef ${n}` })),
    );

    expect(outcomes.filter((outcome) => "view" in outcome)).toHaveLength(5);
    expect(outcomes.filter((outcome) => !("view" in outcome))).toEqual(
      Array(5).fill({ refused: "rule", rule: "full" }),
    );
    expect(await rows()).toHaveLength(MAX_LIST_ITEMS);
  });
});

describe("Chat's edit_shopping_list and Undo", () => {
  it("applies every change at once, shows a card, and Undo puts back the exact list", async () => {
    const beef = await added(BEEF);
    const eggs = await added({ words: "eggs", quantity: 12, unit: "ct", note: "large" });
    const milk = await added({ words: "milk", quantity: 1, unit: "gal" }, "ravi");
    const jif = await added({
      words: "peanut butter",
      quantity: 1,
      unit: "each",
      brandLock: "Jif",
    });
    await list.change(jif, { ticked: true });
    await run("UPDATE shopping_list_items SET search_words = ? WHERE id = ?", "eggs large", eggs);
    const original = await rows();

    clock = LATER;
    const changeId = await edited([
      { action: "add", words: "avocados", quantity: 3, unit: "each" },
      { action: "change", id: eggs, words: "brown eggs", quantity: 18 },
      { action: "remove", id: milk },
      { action: "change", id: beef, ticked: true },
      { action: "change", id: jif, ticked: false, brandLock: "" },
      { action: "add", words: "oat milk", quantity: 64, unit: "fl oz", brandLock: "Oatly" },
    ]);

    expect((await shoppingListForChat(test.database)).listItems).toEqual([
      expect.objectContaining({ id: beef, ticked: true }),
      expect.objectContaining({ id: eggs, words: "brown eggs", quantity: 18 }),
      expect.objectContaining({ id: jif, brandLock: null, ticked: false }),
      expect.objectContaining({ words: "avocados", quantity: 3, unit: "each" }),
      expect.objectContaining({ words: "oat milk", unit: "fl oz", brandLock: "Oatly" }),
    ]);
    expect((await rows()).slice(-2).map((item) => [item.place, item.addedBy])).toEqual([
      [4, "dana"],
      [5, "dana"],
    ]);
    expect(await shoppingListCards(test.database, "thread-1")).toEqual([
      {
        id: changeId,
        answerId: "answer-1",
        lines: [
          "Added 3 avocados",
          "Changed 12 ct eggs (large) to 18 ct brown eggs (large)",
          "Removed 1 gal milk",
          "Ticked 2 lb ground beef",
          "Changed 1 peanut butter, only Jif to 1 peanut butter, unticked",
          "Added 64 fl oz oat milk, only Oatly",
        ],
        undoneAt: null,
      },
    ]);

    expect(await list.undo(changeId, "ravi")).toMatchObject({ view: { items: expect.any(Array) } });
    expect(await rows()).toEqual(original);
    expect(await shoppingListCards(test.database, "thread-1")).toEqual([
      expect.objectContaining({ id: changeId, undoneAt: LATER.toISOString() }),
    ]);
    expect(
      await test.database
        .select({ undoneBy: schema.shoppingListChanges.undoneBy })
        .from(schema.shoppingListChanges),
    ).toEqual([{ undoneBy: "ravi" }]);

    // A second Undo, or one of a change that is not there, changes nothing.
    const before = await everyRow();
    expect(await list.undo(changeId, "dana")).toEqual({ refused: "undone already" });
    expect(await list.undo("no-such-change", "dana")).toEqual({ refused: "no change" });
    expect(await everyRow()).toEqual(before);
  });

  it("refuses Undo with no change when a List item it touched changed since, and allows it when only others did", async () => {
    const beef = await added(BEEF);
    const eggs = await added({ words: "eggs", quantity: 12, unit: "ct" });
    const bread = await added({ words: "bread", quantity: 1, unit: "each" });
    const changeId = await edited([
      { action: "change", id: beef, quantity: 3 },
      { action: "add", words: "avocados", quantity: 3, unit: "each" },
      { action: "remove", id: eggs },
    ]);
    const avocados = (await rows()).at(-1)?.id ?? "";

    // A Member ticks the changed one: Undo would undo the tick.
    await list.change(beef, { ticked: true });
    let before = await everyRow();
    expect(await list.undo(changeId, "dana")).toEqual({ refused: "changed since" });
    expect(await everyRow()).toEqual(before);
    await list.change(beef, { ticked: false });

    // A Member removes the added one.
    await list.remove(avocados);
    before = await everyRow();
    expect(await list.undo(changeId, "dana")).toEqual({ refused: "changed since" });
    expect(await everyRow()).toEqual(before);

    // A Member adds the removed one back by hand: its ID is new, so Undo can put the old one back.
    // A change to a List item the edit did not touch never blocks it.
    await test.database.insert(schema.shoppingListItems).values({
      id: avocados,
      words: "avocados",
      quantity: 3,
      unit: "each",
      place: 9,
      addedAt: AT,
    });
    await list.change(bread, { note: "whole wheat" });
    expect(await list.undo(changeId, "dana")).toMatchObject({ view: {} });
    expect((await rows()).map((item) => [item.id, item.quantity, item.note])).toEqual([
      [beef, 2, null],
      [eggs, 12, null],
      [bread, 1, "whole wheat"],
    ]);
  });

  it("refuses an Undo that would put the list over 100 List items, with no change", async () => {
    await filled(98);
    const changeId = await edited([
      { action: "remove", id: "filled-0" },
      { action: "remove", id: "filled-1" },
    ]);
    await added(BEEF);
    await added(BEEF);
    await added(BEEF);
    const before = await everyRow();

    expect(await list.undo(changeId, "dana")).toEqual({ refused: "rule", rule: "full" });
    expect(await everyRow()).toEqual(before);
  });

  it("takes 1 to 30 changes, each List item once, and names the rule it broke with no change", async () => {
    const beef = await added(BEEF);
    const adds = (count: number): ShoppingListEditInput[] =>
      Array.from({ length: count }, (_, n) => ({
        action: "add",
        words: `item ${n}`,
        quantity: 1,
        unit: "each",
      }));
    const before = await everyRow();
    const refusals: [ShoppingListEditInput[], string][] = [
      [[], SHOPPING_LIST_RULES.changes],
      [adds(31), SHOPPING_LIST_RULES.changes],
      [
        [
          { action: "change", id: beef, quantity: 3 },
          { action: "remove", id: beef },
        ],
        SHOPPING_LIST_RULES.once,
      ],
      [[...adds(2), { action: "change", id: beef }], SHOPPING_LIST_RULES.nothing],
      [[...adds(2), { action: "change", id: beef, quantity: 0 }], SHOPPING_LIST_RULES.quantity],
      [[{ action: "add", words: "", quantity: 1, unit: "each" }], SHOPPING_LIST_RULES.words],
      [
        [...adds(2), { action: "remove", id: "no-such-item" }],
        'No List item has the ID "no-such-item". Read the list with get_shopping_list first.',
      ],
    ];
    for (const [edits, error] of refusals) {
      expect(await editShoppingList(test.database, edits, by)).toEqual({ error });
    }
    expect(await everyRow()).toEqual(before);

    await edited(adds(30));
    expect(await rows()).toHaveLength(31);
  });

  it("holds the list to 100 List items over an edit's adds and removes, and over two edits sent together", async () => {
    await filled(95);
    const adds = (count: number): ShoppingListEditInput[] =>
      Array.from({ length: count }, () => ({ action: "add", ...BEEF }));
    const before = await everyRow();

    expect(await editShoppingList(test.database, adds(6), by)).toEqual({
      error: SHOPPING_LIST_RULES.full,
    });
    expect(await everyRow()).toEqual(before);
    await edited([...adds(6), { action: "remove", id: "filled-0" }]);
    expect(await rows()).toHaveLength(100);

    await list.remove("filled-1");
    await list.remove("filled-2");
    await list.remove("filled-3");
    const together = await Promise.all([
      editShoppingList(test.database, adds(2), { ...by, answerId: "answer-2" }),
      editShoppingList(test.database, adds(2), { ...by, answerId: "answer-3" }),
    ]);
    expect(together.filter((result) => "changeId" in result)).toHaveLength(1);
    expect(together.filter((result) => "error" in result)).toEqual([
      { error: SHOPPING_LIST_RULES.full },
    ]);
    expect(await rows()).toHaveLength(99);
  });

  it("undoes a change once when two Undos are sent together", async () => {
    const beef = await added(BEEF);
    const changeId = await edited([{ action: "change", id: beef, quantity: 5 }]);

    const outcomes = await Promise.all([list.undo(changeId, "dana"), list.undo(changeId, "ravi")]);

    expect(outcomes.filter((outcome) => "view" in outcome)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !("view" in outcome))).toEqual([
      { refused: "undone already" },
    ]);
    expect((await rows()).map((item) => item.quantity)).toEqual([2]);
  });

  // A third Member, so the app's own removal may take Dana and Ravi (it never takes the last one).
  const addKeeper = () =>
    test.database.insert(schema.members).values({
      id: "kim",
      name: "Kim Alder",
      email: "kim@example.com",
      createdAt: AT,
      updatedAt: AT,
    });

  it("puts back an AI-removed List item with no adder once the Member who added it is removed", async () => {
    const beef = await added(BEEF, "ravi");
    const eggs = await added({ words: "eggs", quantity: 12, unit: "ct" }, "dana");
    const changeId = await edited([
      { action: "remove", id: beef },
      { action: "remove", id: eggs },
    ]);
    await addKeeper();
    expect(await removeMember(test.database, "ravi", LATER)).toBe("removed");

    expect("view" in (await list.undo(changeId, "dana"))).toBe(true);
    expect((await rows()).map((item) => [item.id, item.addedBy])).toEqual([
      [beef, null],
      [eggs, "dana"],
    ]);
    expect((await shoppingListCards(test.database, "thread-1"))[0]?.undoneAt).not.toBeNull();
  });

  it("deletes the cards with their thread, keeps them when a Member is removed, and keeps the List items in both", async () => {
    await test.database
      .insert(schema.chatThreads)
      .values({ id: "thread-2", title: "More", createdAt: AT, lastMessageAt: AT });
    await edited([{ action: "add", ...BEEF }]);
    await editShoppingList(
      test.database,
      [{ action: "add", words: "eggs", quantity: 12, unit: "ct" }],
      { ...by, threadId: "thread-2" },
    );
    const [first] = await shoppingListCards(test.database, "thread-1");
    await list.undo(first?.id ?? "", "ravi");
    await edited([{ action: "add", ...BEEF }]);

    await addKeeper();
    expect(await removeMember(test.database, "dana", LATER)).toBe("removed");
    expect(await removeMember(test.database, "ravi", LATER)).toBe("removed");
    expect(
      await test.database
        .select({
          madeBy: schema.shoppingListChanges.madeBy,
          undoneBy: schema.shoppingListChanges.undoneBy,
        })
        .from(schema.shoppingListChanges),
    ).toEqual([
      { madeBy: null, undoneBy: null },
      { madeBy: null, undoneBy: null },
      { madeBy: null, undoneBy: null },
    ]);

    await run("DELETE FROM chat_threads WHERE id = ?", "thread-1");
    expect(await shoppingListCards(test.database, "thread-1")).toEqual([]);
    expect(await shoppingListCards(test.database, "thread-2")).toHaveLength(1);
    expect((await rows()).map((item) => [item.words, item.addedBy])).toEqual([
      ["eggs", null],
      ["ground beef", null],
    ]);
  });
});
