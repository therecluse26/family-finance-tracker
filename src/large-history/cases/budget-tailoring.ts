import { expect } from "vitest";
import { aiCost, aiSettings } from "../../ai/index.ts";
import { newAiKey } from "../../ai/testing.ts";
import { draftFirstBudgets } from "../../budgets/index.ts";
import { addGoal, listWaitingTailoringRuns } from "../../db/index.ts";
import { householdTimeZone, saveHouseholdFacts } from "../../household/index.ts";
import {
  requestGoalTailoring,
  runWaitingTailoring,
  tailorFirstDraft,
} from "../../tailoring/index.ts";
import { HISTORY_NOW } from "../history.ts";
import { timedCase } from "../index.ts";

const PRICE = { input: 1_000_000, output: 2_000_000 };

// Budget tailoring on the full history (spec 05, The AI's part in a draft; Which Proposals exist),
// with an AI provider set up and AI SDK test models: the first draft with its one Writer call,
// which fails here so its AI retry makes the Tailoring run, then the Tailoring run and a Goal run,
// each as the Budget tailoring job runs it. Each reads the Household summary, the formula's
// figures, the Budgets and the Benchmarks.
timedCase("Budget tailoring", async (history, time) => {
  const { database, secrets } = history;
  await saveHouseholdFacts(
    database,
    { zipCode: "10001", ages: [40, 38, 7], rentOrOwn: "rent" },
    history.memberId,
    HISTORY_NOW(),
  );
  const saved = await aiSettings({
    database,
    secrets,
    makeModels: history.ai.makeModels,
    cost: aiCost({ database, timeZone: () => householdTimeZone(database) }),
  }).save({
    provider: "anthropic",
    apiKey: newAiKey(),
    baseUrl: null,
    quickModel: "quick-model",
    writerModel: "writer-model",
    prices: { quick: PRICE, writer: PRICE },
  });
  expect(saved).toMatchObject({ saved: true });
  const calls = () => history.ai.calls.filter((call) => call.tier === "writer").length;
  const before = calls();

  history.ai.answers.writer = "fail";
  await time.job(
    "First Budget draft with Budget tailoring on the full history",
    10_000,
    async () => {
      expect(await draftFirstBudgets(database, HISTORY_NOW(), tailorFirstDraft)).toBe(true);
    },
  );
  expect(await listWaitingTailoringRuns(database)).toHaveLength(1);

  // The AI retry is due: the Tailoring run makes one Proposal.
  history.ai.answers.writer = "work";
  await database.$client.execute("DELETE FROM ai_retries");
  history.ai.reply = JSON.stringify({
    reason: "Restaurant Spending has room to come down.",
    budgets: [
      { category: "Restaurants", amount: 300, reason: "Eating out can come down a little." },
      { category: "Groceries", amount: 700, reason: "Groceries are steady." },
    ],
    goalAmount: 250,
    goalReason: "Aim a little under the usual month.",
  });
  await time.job(
    "Budget tailoring job, the Tailoring run, on the full history",
    10_000,
    async () => {
      expect(await runWaitingTailoring()).toBe(1);
    },
  );

  const goalId = await addGoal(database, {
    words: "Spend less at restaurants",
    authorId: history.memberId,
    date: "2026-11-01",
    target: { kind: "Category", category: "Restaurants" },
    change: null,
    deadline: null,
  });
  await requestGoalTailoring(goalId);
  await time.job("Budget tailoring job, a Goal run, on the full history", 10_000, async () => {
    expect(await runWaitingTailoring()).toBe(1);
  });
  // One Writer call each: the first draft, the Tailoring run, and the Goal run.
  expect(calls() - before).toBe(3);
});
