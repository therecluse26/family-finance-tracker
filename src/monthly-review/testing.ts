import type { StoredReview } from "./review-view.ts";

// Test support: a fixture review as the monthly-review module stores it, for October 2026, written
// on Sunday, Nov 1. Amounts are whole cents.

export function fixtureReview(fields: Partial<StoredReview> = {}): StoredReview {
  return {
    writtenOn: "2026-11-01",
    headline: "Takeout carried October, and the cards still hold a balance.",
    header: { spending: 342_000, budget: 310_000, debt: 1_284_000 },
    habits: [
      {
        name: "Takeout fills the busy nights",
        line: "Most delivery orders land Wednesday to Friday after 7 PM.",
        costMonth: 42_000,
        picture: {
          type: "days",
          month: "2026-10",
          of: { category: "Restaurants" },
          days: [
            { date: "2026-10-02", count: 1 },
            { date: "2026-10-09", count: 2 },
          ],
        },
      },
      {
        name: "The cards never quite get paid off",
        line: "Both cards carried a balance into every month this year.",
        costMonth: 9_600,
        picture: {
          type: "cards",
          cards: [
            { id: "card-1", name: "Rewards Card", owed: 640_000, apr: 24.99, promoEnds: null },
          ],
        },
      },
      {
        name: "Streaming keeps adding up",
        line: "Four services renew each month.",
        costMonth: 6_800,
        picture: null,
      },
    ],
    ideas: [
      {
        idea: "Cook two more nights a week",
        savesMonth: 18_000,
        effort: "Some effort",
        kind: "Habit",
        habit: 0,
        why: "Eight delivery orders at $45 is $360; cooking two of those nights saves about $180.",
        catch: "It needs a plan for the busiest nights.",
      },
      {
        idea: "Pay the Rewards Card in full",
        savesMonth: 9_600,
        effort: "Big step",
        kind: "Debt",
        habit: 1,
        why: "At 24.99% APR, $6,400 carried costs about $96 a month in interest.",
        catch: null,
      },
      {
        idea: "Drop one streaming service",
        savesMonth: 1_700,
        effort: "Easy",
        kind: "Recurring charge",
        habit: 2,
        why: "Two services carry the same shows; the smaller one is $17 a month.",
        catch: null,
      },
      {
        idea: "Order takeout for pickup",
        savesMonth: 6_000,
        effort: "Easy",
        kind: "Habit",
        habit: 0,
        why: "Delivery fees and tips added $60 to October's orders.",
        catch: null,
      },
      {
        idea: "Shop the insurance renewal",
        savesMonth: 4_000,
        effort: "Some effort",
        kind: "Bill",
        habit: null,
        why: "The car insurance renews in December at $180 a month.",
        catch: "Quotes take an evening.",
      },
    ],
    plan: [
      { idea: 0, when: "Starting this week" },
      { idea: 1, when: "By the Nov 20 due date" },
      { idea: 2, when: "Before Nov 15" },
    ],
    goals: [
      {
        goalId: "goal-1",
        words: "Spend less on eating out",
        percentage: 62,
        state: "Behind",
        detail: "On pace for $540 this month; Goal is $480",
        line: "Cooking two more nights moves this about $180 a month.",
      },
    ],
    ...fields,
  };
}
