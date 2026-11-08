import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aiCost, type HouseholdAi, householdAi } from "../ai/index.ts";
import { asTheAiReads, newTestAi, type TestAi } from "../ai/testing.ts";
import { addGoal, addUnconnectedAccount, loginTables } from "../db/index.ts";
import { progressDetailPieces, readGoalsWithProgress, startGoal } from "../goals/index.ts";
import { lookupTools } from "./index.ts";

// Chat's Goal lookup (spec 08, Lookup tools): a Goal's progress detail is text the app builds, so
// each amount in it goes as its own piece, as the Household summary sends it. The Household's
// names and numbers are made up, and no test calls an AI provider.

const NOW = new Date("2026-11-20T14:00:00.000Z");

type Answer = { goals: { progress: { detail: unknown } | null }[] };

describe("the Goal lookup", () => {
  let test: TestAi;
  let ai: HouseholdAi;

  beforeEach(async () => {
    test = await newTestAi();
    const joined = new Date("2026-01-02T00:00:00Z");
    await test.database.insert(loginTables.user).values({
      id: "m1",
      name: "Dana Whitfield",
      email: "dana@example.com",
      createdAt: joined,
      updatedAt: joined,
    });
    await addUnconnectedAccount(test.database, {
      subtype: "savings",
      institutionName: "Ally",
      name: "Rainy day fund",
      mask: "4999",
    });
    const id = await addGoal(test.database, {
      words: "Spend less on dining out",
      authorId: "m1",
      date: "2026-11-01",
      target: { kind: "Category", category: "Restaurants" },
      change: { amount: 10_000 },
      deadline: null,
    });
    expect(await startGoal(test.database, id, { goalAmount: 499_900, now: NOW })).toMatchObject({
      goalAmount: 499_900,
    });
    ai = householdAi({
      database: test.database,
      secrets: test.secrets,
      cost: aiCost({ database: test.database }),
    });
  });

  afterEach(() => {
    test.close();
  });

  it("sends a Goal's progress detail with each amount as its own piece, even one that matches an Account's last 4", async () => {
    const [goal] = await readGoalsWithProgress(test.database, NOW);
    const detail = goal?.progress?.detail ?? "";
    // The Goal amount, $4,999, matches the Account's last 4.
    expect(detail).toBe("On pace for $0 this month; Goal is $4,999");

    const tools = lookupTools({ database: test.database, ai, now: () => NOW });
    const answer = asTheAiReads(
      await tools.get_budgets_and_goals?.run({ month: "2026-11" }),
    ) as Answer;

    expect(answer.goals[0]?.progress?.detail).toEqual([
      "On pace for ",
      "0.00",
      " this month; Goal is ",
      "4999.00",
    ]);
  });

  it("reads each amount of every detail template, and leaves any other detail as words", () => {
    expect(progressDetailPieces("$12,480 of $20,000; $1,005 behind pace")).toEqual([
      { cents: 1_248_000 },
      " of ",
      { cents: 2_000_000 },
      "; ",
      { cents: 100_500 },
      " behind pace",
    ]);
    expect(progressDetailPieces("−$5 of $500")).toEqual([
      { cents: -500 },
      " of ",
      { cents: 50_000 },
    ]);
    expect(progressDetailPieces("$300 of $9,000 paid; $12 ahead of pace")).toEqual([
      { cents: 30_000 },
      " of ",
      { cents: 900_000 },
      " paid; ",
      { cents: 1_200 },
      " ahead of pace",
    ]);
    expect(progressDetailPieces("Goal amount not set yet")).toEqual(["Goal amount not set yet"]);
    expect(progressDetailPieces("$4,999 for Dana")).toEqual(["$4,999 for Dana"]);
  });
});
