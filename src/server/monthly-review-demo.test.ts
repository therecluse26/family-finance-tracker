import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { seedDemoHousehold } from "../bank/demo.ts";
import { FakeBankAdapter } from "../bank/fake.ts";
import { startBank } from "../bank/index.ts";
import { draftFirstBudgets } from "../budgets/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { addGoal, markSetupStep } from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { startGoal } from "../goals/index.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { type ReviewReply, saveMonthlyReview } from "../monthly-review/index.ts";
import type { PictureView } from "../pictures/index.ts";
import { leftToSpend } from "../web/dashboard.ts";
import { createApp } from "./app.ts";
import type { AccountView, NumberTilesView } from "./bank-views.ts";
import type { BudgetsView } from "./budgets-views.ts";
import type { GoalView } from "./goals-views.ts";
import type { MonthlyReviewView } from "./monthly-reviews-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { TestBrowser } from "./testing.ts";

// Storing October's Monthly review on the demo household (spec 08, Monthly review; spec 07,
// Reviews page), from a fixture AI reply and with no AI call: the app draws the header, each
// Habit's picture and each Goal's meter from app.db when it is written, and the review never
// changes after that.

const APP_URL = "http://nas.local:8080";
// The first draft makes October's Budgets on Oct 20. The review is written on Sunday, Nov 1, at
// 9 AM in New York, the demo Household's time zone. Its history runs to Oct 31.
const DRAFTED = new Date("2026-10-20T16:00:00.000Z");
const WRITTEN = new Date("2026-11-01T14:00:00.000Z");
const MONTH = "2026-10";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-monthly-review-demo-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

// The AI's part of a review, in dollars.
function reply(fields: Partial<ReviewReply> = {}): ReviewReply {
  return {
    headline: "Takeout carried October.",
    habits: [
      {
        name: "Groceries in small trips",
        line: "Most weeks had three or more grocery runs.",
        costMonth: 85.5,
        picture: { type: "trend", category: "Groceries" },
      },
      {
        name: "A habit with a picture the data does not bear out",
        line: "It still shows, with no picture.",
        costMonth: 10,
        picture: { type: "days", category: "Not a Category" },
      },
      {
        name: "A habit with a broken picture choice",
        line: "It still shows, with no picture.",
        costMonth: 5,
        picture: { type: "pie" },
      },
      {
        name: "A habit whose cards picture also names a Category",
        line: "It still shows, with no picture.",
        costMonth: 2,
        picture: { type: "cards", category: "Groceries" },
      },
    ],
    ideas: [
      {
        idea: "One big grocery trip a week",
        savesMonth: 60.25,
        effort: "Some effort",
        kind: "Habit",
        habit: 0,
        why: "Fewer trips, fewer extras.",
        catch: "It needs a list.",
      },
      ...["Two", "Three", "Four", "Five"].map((word, index) => ({
        idea: `Idea ${word}`,
        savesMonth: 10 * (index + 1),
        effort: "Easy" as const,
        kind: "Bill" as const,
        habit: null,
        why: "Because.",
        catch: null,
      })),
    ],
    plan: [
      { idea: 0, when: "This week" },
      { idea: 2, when: "By Nov 15" },
      { idea: 4, when: "Before Nov 30" },
    ],
    goals: [],
    ...fields,
  };
}

describe("storing the Monthly review on the demo household", () => {
  let test: TestAuth;
  let browser: TestBrowser;
  let stops: (() => void)[] = [];
  let goalId: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DRAFTED);
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    const app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
      test.secrets,
    );
    const fake = new FakeBankAdapter();
    stops = [
      startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop,
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startMoneyMovement({ database: test.database }).stop,
      startCategorization({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    await saveHouseholdFacts(
      test.database,
      { zipCode: "10001", ages: [40, 38, 7], rentOrOwn: "rent" },
      member.id,
    );
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
    await seedDemoHousehold(test.database, fake);
    await runFollowUp();
    await draftFirstBudgets(test.database);
    goalId = await addGoal(test.database, {
      authorId: member.id,
      date: "2026-10-01",
      deadline: null,
      words: "Save $1,000",
      target: { kind: "Saving" },
      change: { amount: 100_000 },
    });
    await startGoal(test.database, goalId);
    vi.setSystemTime(WRITTEN);
  });

  afterEach(() => {
    for (const stop of stops) stop();
    vi.useRealTimers();
    test.close();
  });

  const json = async <T>(path: string): Promise<T> => {
    const res = await browser.get(path);
    expect(res.status, path).toBe(200);
    return (await res.json()) as T;
  };
  const opened = () => json<MonthlyReviewView>(`/api/monthly-reviews/${MONTH}`);

  it("draws the header from the Categories Left to spend counts, and the Debt from the Debt tile", async () => {
    expect(await saveMonthlyReview(test.database, { month: MONTH, reply: reply() })).toBe("saved");

    const { review } = await opened();
    const left = leftToSpend(await json<BudgetsView>(`/api/budgets?month=${MONTH}`));
    if (!left.drafted) throw new Error("October has no Budgets.");
    expect(review.writtenOn).toBe("2026-11-01");
    expect(review.header).toEqual({
      spending: left.spending,
      budget: left.budget,
      debt: (await json<NumberTilesView>("/api/number-tiles")).debt.amount,
    });
    expect(left.spending).toBeGreaterThan(0);
    expect(review.header.debt).toBeGreaterThan(0);
  });

  it("stores the AI's dollars as cents, and draws each picture the data bears out", async () => {
    await saveMonthlyReview(test.database, { month: MONTH, reply: reply() });

    const { review } = await opened();
    const trend = await json<{ picture: PictureView | null }>(
      `/api/picture?month=${MONTH}&type=trend&category=Groceries`,
    );
    expect(trend.picture).not.toBeNull();
    expect(review.habits.map((habit) => [habit.costMonth, habit.picture])).toEqual([
      [8_550, trend.picture],
      [1_000, null],
      [500, null],
      [200, null],
    ]);
    // The same cards choice with no stray field draws the cards.
    const cards = await json<{ picture: PictureView | null }>(
      `/api/picture?month=${MONTH}&type=cards`,
    );
    expect(cards.picture?.type).toBe("cards");
    // The picture menu's own request refuses it too.
    const stray = await browser.get(`/api/picture?month=${MONTH}&type=cards&category=Groceries`);
    expect(stray.status).toBe(400);
    expect(review.ideas.map((idea) => idea.savesMonth)).toEqual([
      6_025, 1_000, 2_000, 3_000, 4_000,
    ]);
    expect(review.plan).toEqual(reply().plan);
  });

  it("gives each active Goal its meter as it was then, with the AI's line for it", async () => {
    const line = "Two more weeks of cooking at home gets this to half.";
    await saveMonthlyReview(test.database, {
      month: MONTH,
      reply: reply({
        goals: [
          { goalId, line },
          { goalId: "no-such-goal", line: "Dropped." },
        ],
      }),
    });

    const goal = (await json<{ goals: GoalView[] }>("/api/goals")).goals.find(
      (each) => each.id === goalId,
    );
    expect(goal?.progress?.percentage).toEqual(expect.any(Number));
    expect((await opened()).review.goals).toEqual([
      {
        goalId,
        words: "Save $1,000",
        percentage: goal?.progress?.percentage ?? null,
        state: goal?.progress?.state ?? null,
        detail: goal?.progress?.detail ?? "",
        line,
      },
    ]);
  });

  it("keeps the review as it was written: a second save and a later change to the data leave it", async () => {
    await saveMonthlyReview(test.database, { month: MONTH, reply: reply() });
    const first = await opened();

    expect(
      await saveMonthlyReview(test.database, {
        month: MONTH,
        reply: reply({ headline: "A second run." }),
      }),
    ).toBe("already written");
    // Excluding a card takes its balance out of the Debt tile, and not out of the review.
    const debtBefore = (await json<NumberTilesView>("/api/number-tiles")).debt.amount;
    const card = (await json<{ accounts: AccountView[] }>("/api/accounts")).accounts.find(
      (account) => account.kind === "credit" && (account.currentBalance ?? 0) !== 0,
    );
    if (card === undefined) throw new Error("The demo household has no card with a balance.");
    expect(
      (await browser.send("PUT", `/api/accounts/${card.id}/exclude`, { excluded: true })).status,
    ).toBe(200);
    expect((await json<NumberTilesView>("/api/number-tiles")).debt.amount).not.toBe(debtBefore);

    expect(await opened()).toEqual(first);
  });

  it("refuses a reply that does not fit the review fields, and stores nothing", async () => {
    const before = await readEveryTable(test.database);
    const ideas = reply().ideas;
    const firstIdea = (fields: Partial<(typeof ideas)[number]>) =>
      ideas.map((idea, index) => (index === 0 ? { ...idea, ...fields } : idea));
    const refused = [
      { month: "2026-13", reply: reply() },
      { month: MONTH, reply: { ...reply(), headline: "" } },
      { month: MONTH, reply: reply({ ideas: ideas.slice(0, 4) }) },
      { month: MONTH, reply: reply({ habits: reply().habits.slice(0, 1) }) },
      { month: MONTH, reply: reply({ plan: reply().plan.slice(0, 2) }) },
      // The plan's ideas differ, and each index points at a Habit or idea in the review.
      { month: MONTH, reply: reply({ plan: [0, 0, 1].map((idea) => ({ idea, when: "Now" })) }) },
      { month: MONTH, reply: reply({ plan: [0, 1, 5].map((idea) => ({ idea, when: "Now" })) }) },
      { month: MONTH, reply: reply({ ideas: firstIdea({ habit: 4 }) }) },
      {
        month: MONTH,
        reply: reply({ ideas: firstIdea({ savesMonth: -5 }) }),
      },
      // A field the review fields do not name, at any level.
      { month: MONTH, reply: { ...reply(), mood: "upbeat" } },
      {
        month: MONTH,
        reply: reply({ habits: reply().habits.map((habit) => ({ ...habit, extra: 1 })) }),
      },
      { month: MONTH, reply: reply({ ideas: firstIdea({ extra: 1 } as object) }) },
      { month: MONTH, reply: reply({ plan: reply().plan.map((item) => ({ ...item, extra: 1 })) }) },
      { month: MONTH, reply: reply({ goals: [{ goalId, line: "A line.", extra: 1 } as never] }) },
    ];
    for (const input of refused) {
      expect(await saveMonthlyReview(test.database, input)).toEqual({
        refused: expect.any(String),
      });
    }
    expect(await readEveryTable(test.database)).toEqual(before);

    // The Budget changes in the reply become Proposals elsewhere, and leave the review as it is.
    const withChanges = { ...reply(), budgetChanges: [{ kind: "Budget change" }] };
    expect(await saveMonthlyReview(test.database, { month: MONTH, reply: withChanges })).toBe(
      "saved",
    );
    expect(Object.keys((await opened()).review)).not.toContain("budgetChanges");
  });
});
