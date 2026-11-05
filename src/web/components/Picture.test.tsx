import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type DaysPictureView,
  PICTURE_TYPES,
  type PictureView,
} from "../../pictures/picture-view.ts";
import { calendarWeeks, pictureQuery } from "../pictures.ts";
import { Picture, PictureDrawing } from "./Picture.tsx";

// Each picture on the menu (spec 08, Picture menu), drawn from its answer. The answers themselves
// are checked on the demo household, through the app's HTTP interface, in
// src/server/pictures-page.test.ts.

const days = (fields: Partial<DaysPictureView> = {}): DaysPictureView => ({
  type: "days",
  month: "2026-10",
  of: { category: "Restaurants" },
  days: [{ date: "2026-10-02", count: 1 }],
  ...fields,
});

const ONE_OF_EACH: Record<PictureView["type"], PictureView> = {
  days: days(),
  trend: {
    type: "trend",
    category: "Groceries",
    months: [
      { month: "2026-09", spending: 50_000, budget: null },
      { month: "2026-10", spending: 40_000, budget: null },
    ],
  },
  cards: {
    type: "cards",
    cards: [
      { id: "a", name: "Rewards Card", owed: 120_049, apr: 28.49, promoEnds: null },
      { id: "b", name: "Store Card", owed: 30_000, apr: null, promoEnds: "2027-03-01" },
    ],
  },
  recurring: {
    type: "recurring",
    category: "Fitness",
    charges: [{ id: "c", merchantName: "Ironworks Fitness", amount: 4_999 }],
  },
};

function words(picture: PictureView | null): string {
  return renderToString(<PictureDrawing picture={picture} />)
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the pictures", () => {
  it("draws each picture type on the menu, and nothing for no picture", () => {
    for (const type of PICTURE_TYPES) {
      expect(renderToString(<PictureDrawing picture={ONE_OF_EACH[type]} />)).toContain(
        `data-picture="${type}"`,
      );
    }
    expect(renderToString(<PictureDrawing picture={null} />)).toBe("");
    expect(renderToString(<Picture choice={null} month="2026-10" />)).toBe("");
  });

  it("lays out the calendar Sunday first, with a blank for each weekday before the 1st", () => {
    // Oct 1, 2026 is a Thursday.
    const weeks = calendarWeeks(days({ days: [{ date: "2026-10-09", count: 3 }] }));

    expect(weeks).toHaveLength(5);
    expect(weeks[0]?.slice(0, 5)).toEqual([
      null,
      null,
      null,
      null,
      { date: "2026-10-01", day: 1, count: 0 },
    ]);
    expect(weeks[1]?.[5]).toEqual({ date: "2026-10-09", day: 9, count: 3 });
    expect(weeks.at(-1)?.at(-1)).toEqual({ date: "2026-10-31", day: 31, count: 0 });
  });

  it("words the days caption for one day and for three Merchants", () => {
    expect(words(days())).toBe("S M T W T F S Restaurants in Oct 2026: 1 day");
    expect(
      words(days({ of: { merchants: ["Pasta Corner", "Noodle House", "Blue Door Cafe"] } })),
    ).toBe("S M T W T F S Pasta Corner, Noodle House, and Blue Door Cafe in Oct 2026: 1 day");
  });

  it("says when a trend has no Budget yet", () => {
    expect(words(ONE_OF_EACH.trend)).toBe(
      "Groceries, Sep 2026 to Oct 2026. Oct 2026: $400. No Budget yet.",
    );
  });

  it("marks where a promo ends, and leaves out an APR the bank did not send", () => {
    const html = renderToString(<PictureDrawing picture={ONE_OF_EACH.cards} />);

    expect(words(ONE_OF_EACH.cards)).toBe(
      "Rewards Card $1,200 · 28% APR Store Card $300 ⚑ promo ends Mar 2027 " +
        "Each card's balance owed and APR. ⚑ marks where a promo ends.",
    );
    expect(html.match(/data-slot="promo"/g)).toHaveLength(1);
  });

  it("words one Recurring charge in cents and the month's total in whole dollars", () => {
    expect(words(ONE_OF_EACH.recurring)).toBe(
      "Ironworks Fitness $49.99 Fitness: 1 monthly Recurring charge, $50 a month",
    );
  });

  it("asks for each choice by its own fields", () => {
    expect(pictureQuery({ type: "cards" }, "2026-10")).toEqual({ month: "2026-10", type: "cards" });
    expect(pictureQuery({ type: "trend", category: "Groceries" }, "2026-10")).toEqual({
      month: "2026-10",
      type: "trend",
      category: "Groceries",
    });
    expect(pictureQuery({ type: "days", merchants: ["A", "B"] }, "2026-10")).toEqual({
      month: "2026-10",
      type: "days",
      merchant: ["A", "B"],
    });
  });
});
