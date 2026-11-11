import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import type {
  ListItemView,
  ShoppingListChangeCardView,
  ShoppingListView,
} from "../../deal-finder/shopping-list-view.ts";
import { ShoppingListChangeCard } from "../components/ShoppingListChange.tsx";
import { ThreadMessages } from "./Chat.tsx";
import { ShoppingList, ShoppingListCards } from "./ShoppingList.tsx";

// The Shopping list page and Chat's Shopping list change card (spec 15, Shopping list; Chat tools),
// as the browser paints them. Every List item here is made up.

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

const item = (id: string, fields: Partial<ListItemView> = {}): ListItemView => ({
  id,
  words: "ground beef",
  quantity: 2,
  unit: "lb",
  brandLock: null,
  note: null,
  ticked: false,
  ...fields,
});

const view = (items: ListItemView[]): ShoppingListView => ({
  items,
  dietaryNeeds: "no peanuts",
  tripSaving: 1000,
  maxItems: 100,
});

const cards = (shown: ShoppingListView, plan?: React.ReactNode) =>
  renderToString(
    <ShoppingListCards view={shown} busy={false} act={async () => true} plan={plan} />,
  );

const inRouter = (element: React.ReactNode) =>
  renderToString(
    <RouterProvider
      router={createMemoryRouter([{ path: "*", element }], { initialEntries: ["/"] })}
    />,
  );

describe("the Shopping list page", () => {
  it("shows each List item in one line, a ticked one struck through, the count, and Clear ticked items", () => {
    const html = cards(
      view([
        item("a", { brandLock: "Fake Farms", note: "for tacos" }),
        item("b", { words: "avocados", quantity: 3, unit: "each", ticked: true }),
      ]),
    );

    expect(text(html)).toContain("2 lb ground beef, only Fake Farms (for tacos)");
    expect(text(html)).toContain("2 of 100");
    expect(html).toMatch(/line-through[^"]*">3 avocados</);
    expect(html).not.toMatch(/line-through[^"]*">2 lb ground beef/);
    expect(text(html)).toContain("Clear ticked items");
    expect(text(html)).toContain("What to buy");
    expect(text(html)).toContain("Dietary needs");
    expect(html).toContain('value="no peanuts"');
    expect(text(html)).toContain("An extra trip must save at least $10.00.");
    expect(html).toContain('value="10.00"');
  });

  it("offers no Clear ticked items with nothing ticked, and no add form at 100 List items", () => {
    const none = cards(view([item("a")]));
    expect(text(none)).not.toContain("Clear ticked items");

    const full = cards(view(Array.from({ length: 100 }, (_, n) => item(`i${n}`))));
    expect(text(full)).toContain("100 of 100");
    expect(text(full)).toContain(
      "The Shopping list holds at most 100 List items. Remove one to add another.",
    );
    expect(text(full)).not.toContain("What to buy");
  });

  it("holds a place for Find the best prices beside the heading, and for the plan under the list", () => {
    const page = renderToString(
      <ShoppingList findBestPrices={<button type="button">Find</button>} />,
    );
    expect(page).toMatch(/<h1[^>]*>Shopping list<\/h1><div data-slot="find-best-prices">/);

    const html = cards(view([]), <p>The plan</p>);
    expect(text(html)).toContain("The list is empty.");
    expect(html.indexOf('data-slot="shopping-plan"')).toBeGreaterThan(html.indexOf("List items"));
    expect(html.indexOf('data-slot="shopping-plan"')).toBeLessThan(html.indexOf("Dietary needs"));
    expect(cards(view([]))).not.toContain("shopping-plan");
  });
});

describe("a Shopping list change's card in Chat", () => {
  const change: ShoppingListChangeCardView = {
    id: "change-1",
    answerId: "answer-1",
    lines: ["Added 3 avocados", "Removed 1 gal milk"],
    undoneAt: null,
  };

  it("shows each change with Undo, and a link to the Shopping list", () => {
    const html = inRouter(<ShoppingListChangeCard change={change} onChanged={() => {}} />);
    expect(text(html)).toContain("Shopping list changed Added 3 avocados Removed 1 gal milk Undo");
    expect(html).toContain('href="/shopping-list"');
  });

  it("shows an undone change struck through, with no Undo", () => {
    const html = inRouter(
      <ShoppingListChangeCard
        change={{ ...change, undoneAt: "2026-11-11T16:00:00.000Z" }}
        onChanged={() => {}}
      />,
    );
    expect(text(html)).toContain("Shopping list change: Undone");
    expect(text(html)).not.toContain("Undo ");
    expect(html).toMatch(/line-through[^"]*">Added 3 avocados/);
  });
});

describe("a Chat thread", () => {
  it("shows a Shopping list change under the answer that made it, and one whose answer failed after the messages", () => {
    const message = (id: string, author: "Member" | "AI", words: string) => ({
      id,
      author,
      name: author === "AI" ? "AI" : "Alice",
      text: words,
      createdAt: "2026-11-11T16:00:00.000Z",
    });
    const card = (id: string, answerId: string | null, line: string) => ({
      id,
      answerId,
      lines: [line],
      undoneAt: null,
    });
    const html = inRouter(
      <ThreadMessages
        thread={{
          id: "t1",
          title: "Groceries",
          note: null,
          messages: [
            message("q1", "Member", "Add avocados"),
            message("a1", "AI", "Added them."),
            message("q2", "Member", "And eggs"),
          ],
          firstSent: null,
          answering: false,
          proposals: [],
          shoppingListChanges: [
            card("c2", null, "Added 12 ct eggs"),
            card("c1", "a1", "Added 3 avocados"),
          ],
          you: "Alice",
        }}
        onChanged={() => {}}
        onAsk={() => {}}
      />,
    );
    const shown = text(html);
    expect(shown.indexOf("Added them.")).toBeLessThan(shown.indexOf("Added 3 avocados"));
    expect(shown.indexOf("Added 3 avocados")).toBeLessThan(shown.indexOf("And eggs"));
    expect(shown.indexOf("And eggs")).toBeLessThan(shown.indexOf("Added 12 ct eggs"));
  });
});
