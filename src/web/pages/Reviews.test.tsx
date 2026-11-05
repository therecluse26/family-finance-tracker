import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureReview } from "../../monthly-review/testing.ts";
import type { MonthlyReviewView } from "../../server/monthly-reviews-views.ts";
import type { ProposalView } from "../../server/proposals-views.ts";
import {
  ideaFacts,
  ideaRows,
  leftOver,
  planHeading,
  planRows,
  reviewTitle,
  spendingLine,
  spendingShare,
} from "../monthly-review.ts";
import { ReviewListReport, ReviewReport } from "./Reviews.tsx";

// The Reviews page (spec 07, Reviews page), drawn from a fixture review as the server sends it:
// the list, and each section of one review. No AI call: every word and number is the stored
// review's.

const TODAY = "2026-11-03";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROPOSAL: ProposalView = {
  id: "p1",
  kind: "Budget change",
  source: "Monthly review",
  createdAt: "2026-11-01T14:00:00.000Z",
  reason: "Takeout has run over three months in a row.",
  changes: ["Restaurants Budget: $400 → $480"],
  budgets: [{ category: "Restaurants", from: 40_000, to: 48_000, period: "monthly" }],
  goal: null,
  words: null,
};

const view = (fields: Partial<MonthlyReviewView> = {}): MonthlyReviewView => ({
  month: "2026-10",
  review: fixtureReview(),
  ticked: [],
  proposals: [PROPOSAL],
  heldBack: [
    {
      id: "a1",
      createdAt: "2026-10-22T15:00:00.000Z",
      heading: null,
      texts: ["Restaurants is $60 over its $480 Budget."],
    },
  ],
  ...fields,
});

const render = (answer: MonthlyReviewView, openIdea?: number) =>
  renderToString(
    <MemoryRouter>
      <ReviewReport
        view={answer}
        today={TODAY}
        onChanged={() => {}}
        {...(openIdea === undefined ? {} : { openIdea })}
      />
    </MemoryRouter>,
  );

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// The words of each element with `data-slot`, which must hold no element of its own tag.
function slotTexts(html: string, slot: string): string[] {
  return [
    ...html.matchAll(new RegExp(`<(\\w+)[^>]*data-slot="${slot}"[^>]*>(.*?)</\\1>`, "gs")),
  ].map((match) => text(match[2] ?? ""));
}

// The HTML of the section labelled by the heading with `id`.
function section(html: string, id: string): string {
  const match = new RegExp(`<section aria-labelledby="${id}"[^>]*>(.*?)</section>`, "s").exec(html);
  if (match === null) throw new Error(`No section ${id}.`);
  return match[1] ?? "";
}

describe("the Reviews list", () => {
  const list = (aiProvider: boolean, reviews = [{ month: "2026-10", writtenOn: "2026-11-01" }]) =>
    renderToString(
      <MemoryRouter>
        <ReviewListReport list={{ aiProvider, reviews }} today={TODAY} />
      </MemoryRouter>,
    );

  it("lists each past review newest first as the server sends it, each opening its month", () => {
    const html = list(true, [
      { month: "2026-10", writtenOn: "2026-11-01" },
      { month: "2026-09", writtenOn: "2026-10-01" },
    ]);

    expect(slotTexts(html, "no-ai")).toEqual([]);
    expect(
      [...html.matchAll(/<li data-review="([^"]+)">(.*?)<\/li>/gs)].map((match) => [
        match[1],
        text(match[2] ?? ""),
      ]),
    ).toEqual([
      ["2026-10", "Oct 2026 review written Nov 1"],
      ["2026-09", "Sep 2026 review written Oct 1"],
    ]);
    expect(html).toContain('href="/reviews/2026-10"');
    expect(html).toContain('href="/reviews/2026-09"');
  });

  it("says no review is written with no AI provider, and links to the AI settings", () => {
    const html = list(false, []);

    expect(slotTexts(html, "no-ai")).toEqual([
      "With no AI provider, no Monthly review is written. Set up AI",
    ]);
    expect(html).toContain('href="/settings/ai"');
    // The past reviews still open.
    expect(text(list(false))).toContain("Oct 2026 review written Nov 1");
  });
});

describe("one Monthly review", () => {
  it("heads the review with its month, the day it was written, the headline, and the header's numbers", () => {
    const html = section(render(view()), "review-title");

    expect(text(html)).toBe(
      "October review · written Sunday, Nov 1 Takeout carried October, and the cards still hold a balance. AI The AI wrote the words. The app drew every number and picture. Spending: $3,420 of $3,100 Budget Left over $320 over Debt $12,840",
    );
    // The bar runs to 125% of the Budget, and its words carry its numbers.
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("width:88.258");
  });

  it("words Left over under the Budget and with no monthly Budget", () => {
    const header = { spending: 250_000, budget: 310_000, debt: 0 };
    expect(leftOver(header)).toBe("$600");
    expect(spendingLine(header)).toBe("$2,500 of $3,100 Budget");
    expect(spendingShare(header)).toBeCloseTo(250_000 / 387_500);

    const noBudget = { ...header, budget: null };
    expect(leftOver(noBudget)).toBeNull();
    expect(spendingLine(noBudget)).toBe("$2,500 spent, no Budget");
    const html = section(
      render(view({ review: fixtureReview({ header: noBudget }) })),
      "review-title",
    );
    expect(slotTexts(html, "left-over")).toEqual([]);
    expect(slotTexts(html, "debt")).toEqual(["Debt $0"]);
  });

  it("gives each Habit a card: its name, line, picture, the first idea that targets it, and its cost a month", () => {
    const html = section(render(view()), "habits");

    expect(slotTexts(html, "habit-name")).toEqual([
      "Takeout fills the busy nights",
      "The cards never quite get paid off",
      "Streaming keeps adding up",
    ]);
    expect(slotTexts(html, "habit-try")).toEqual([
      "Try: Cook two more nights a week",
      "Try: Pay the Rewards Card in full",
      "Try: Drop one streaming service",
    ]);
    expect(slotTexts(html, "cost")).toEqual(["$420 a month", "$96 a month", "$68 a month"]);
    // The pictures the app drew when the review was written; the third Habit has none.
    expect(text(html)).toContain("Restaurants in Oct 2026: 2 days");
    expect(text(html)).toContain("Rewards Card $6,400 · 25% APR");
    expect(html.match(/<figure/g)).toHaveLength(2);
  });

  it("leaves Try out of a Habit no idea targets", () => {
    const review = fixtureReview();
    review.ideas = review.ideas.map((idea) => (idea.habit === 2 ? { ...idea, habit: null } : idea));
    const html = section(render(view({ review })), "habits");

    expect(slotTexts(html, "habit-try")).toHaveLength(2);
  });

  it("charts the ideas by what they save a month, green for Spending and red for debt, each hiding its reason until tapped", () => {
    const html = section(render(view()), "ideas");

    expect(slotTexts(html, "idea-words")).toEqual([
      "Cook two more nights a week",
      "Pay the Rewards Card in full",
      "Order takeout for pickup",
      "Shop the insurance renewal",
      "Drop one streaming service",
    ]);
    expect(slotTexts(html, "idea-saves")).toEqual(["$180", "$96", "$60", "$40", "$17"]);
    expect([...html.matchAll(/data-kind="(\w+)"/g)].map((match) => match[1])).toEqual([
      "spending",
      "debt",
      "spending",
      "spending",
      "spending",
    ]);
    expect(html.match(/bg-red-600/g)).toHaveLength(1);
    expect(html.match(/bg-green-600/g)).toHaveLength(4);
    // Every reason is hidden, and the caption carries the chart's reading.
    expect(html.match(/<div id="[^"]+" hidden=""/g)).toHaveLength(5);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(5);
    expect(text(html)).toContain("Green is Spending, red is debt.");
  });

  it("shows why, the Catch, and the kind, effort, and saving a year (12 × a month) of the tapped idea", () => {
    const html = section(render(view(), 0), "ideas");

    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(slotTexts(html, "idea-catch")).toEqual([
      "Catch: It needs a plan for the busiest nights.",
      "Catch: Quotes take an evening.",
    ]);
    expect(slotTexts(html, "idea-facts")[0]).toBe("Habit · Some effort · $2,160 a year");
    const shown = /<div id="[^"]+" class="[^"]*" data-slot="idea-why">(.*?)<\/div>/s.exec(html);
    expect(text(shown?.[1] ?? "")).toBe(
      "Eight delivery orders at $45 is $360; cooking two of those nights saves about $180. Catch: It needs a plan for the busiest nights. Habit · Some effort · $2,160 a year",
    );
  });

  it("keeps the AI's order for ideas that save the same, and draws the largest bar full", () => {
    const ideas = fixtureReview().ideas.map((idea) => ({ ...idea, savesMonth: 5_000 }));
    expect(ideaRows(ideas).map((row) => [row.index, row.share])).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
    ]);
    expect(ideaFacts({ ...ideas[0], savesMonth: 1_750 } as (typeof ideas)[number])).toBe(
      "Habit · Some effort · $210 a year",
    );
  });

  it("lists next month's plan as a checklist with the ticks the Household shares, and All three's total", () => {
    const html = section(render(view({ ticked: [1] })), "plan");

    expect(planHeading("2026-10")).toBe("Your November plan");
    expect(planHeading("2026-12")).toBe("Your January plan");
    expect(text(html)).toMatch(/^Your November plan /);
    expect(
      [...html.matchAll(/<li[^>]*data-slot="plan-item">(.*?)<\/li>/gs)].map((item) =>
        text(item[1] ?? ""),
      ),
    ).toEqual([
      "Cook two more nights a week Starting this week $180",
      "Pay the Rewards Card in full By the Nov 20 due date $96",
      "Drop one streaming service Before Nov 15 $17",
    ]);
    expect(html.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(1);
    expect(html).toMatch(/id="plan-1" type="checkbox"[^>]*checked=""/);
    expect(slotTexts(html, "plan-total")).toEqual(["$293 a month"]);
    expect(planRows(fixtureReview()).total).toBe(29_300);
  });

  it("shows each Goal's meter as it was, with the AI's line", () => {
    const html = section(render(view()), "review-goals");

    expect(text(html)).toBe(
      "Goals “Spend less on eating out” ◆ Behind 62% On pace for $540 this month; Goal is $480 Cooking two more nights moves this about $180 a month.",
    );
    expect(html).toContain("width:62%");

    const none = section(render(view({ review: fixtureReview({ goals: [] }) })), "review-goals");
    expect(text(none)).toBe("Goals No Goal was active when this review was written.");
  });

  it("shows the open Proposals with Accept, Edit and Skip, and the Alerts the weekly cap held back", () => {
    const html = render(view());

    expect(text(section(html, "budget-changes"))).toBe(
      "Budget changes to consider Proposal Restaurants Budget: $400 → $480 Takeout has run over three months in a row. AI Accept Edit Skip Ask about this",
    );
    expect(text(section(html, "held-back"))).toBe(
      "Alerts you did not get The weekly cap held these back in October. Oct 22 Restaurants is $60 over its $480 Budget.",
    );

    const none = render(view({ proposals: [], heldBack: [] }));
    expect(slotTexts(none, "no-proposals")).toEqual(["No open Proposals."]);
    expect(slotTexts(none, "none-held-back")).toEqual([
      "The weekly cap held back no Alerts in October.",
    ]);
  });

  it("lays the sections in two columns on a wide screen and one on a phone, the header and Habits across both", () => {
    const html = render(view());
    const columns = /<div class="([^"]*)" data-slot="review-columns"/.exec(html)?.[1] ?? "";

    expect(columns.split(" ")).toEqual(
      expect.arrayContaining(["grid", "grid-cols-1", "min-[900px]:grid-cols-2"]),
    );
    for (const id of ["review-title", "habits"]) {
      expect(html).toMatch(
        new RegExp(`<section aria-labelledby="${id}" class="[^"]*min-\\[900px\\]:col-span-2`),
      );
    }
  });

  it("titles a review written in another year with its year", () => {
    expect(reviewTitle("2026-12", "2027-01-01", "2027-01-02")).toBe(
      "December review · written Friday, Jan 1",
    );
    expect(reviewTitle("2025-10", "2025-11-01", TODAY)).toBe(
      "October review · written Saturday, Nov 1, 2025",
    );
  });
});
