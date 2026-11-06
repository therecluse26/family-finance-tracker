import { expect } from "vitest";
import { aiCost, aiSettings } from "../../ai/index.ts";
import { newAiKey } from "../../ai/testing.ts";
import { draftFirstBudgets } from "../../budgets/index.ts";
import { listWaitingTailoringRuns } from "../../db/index.ts";
import { householdTimeZone } from "../../household/index.ts";
import { steadyIncome } from "../../recurring/index.ts";
import {
  checkNewBankRedraft,
  runWaitingTailoring,
  tailorFirstDraft,
} from "../../tailoring/index.ts";
import { HISTORY_NOW } from "../history.ts";
import { timedCase } from "../index.ts";

const PRICE = { input: 1_000_000, output: 2_000_000 };

// Redraft Proposals on the full history (spec 05, Which Proposals exist), with an AI provider set
// up and AI SDK test models: a typed Steady Income that moves I more than 10% runs the Income
// redraft check in its request, then the Budget tailoring job runs the redraft. The New bank check
// sums every posted part twice, with and without one Connection's Transactions.
timedCase("Redrafts", async (history, time) => {
  const { database, secrets } = history;
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
  history.ai.answers.writer = "work";
  history.ai.reply = JSON.stringify({
    reason: "The formula's figures fit.",
    budgets: [],
    goalAmount: null,
    goalReason: null,
  });
  expect(await draftFirstBudgets(database, HISTORY_NOW(), tailorFirstDraft)).toBe(true);
  expect(await listWaitingTailoringRuns(database)).toEqual([]);

  const income = (await steadyIncome(database, HISTORY_NOW())).amount;
  await time.request("PUT /api/steady-income (Income redraft check)", () =>
    history.browser.send("PUT", "/api/steady-income", { typed: Math.round(income * 1.5) }),
  );
  expect(await listWaitingTailoringRuns(database)).toHaveLength(1);

  history.ai.reply = JSON.stringify({
    reason: "Income rose, so the flexible Budgets rise with it.",
    budgets: [{ category: "Restaurants", amount: 400, reason: "Room for a little more." }],
    goalAmount: null,
    goalReason: null,
  });
  await time.job("Budget tailoring job, a redraft, on the full history", 10_000, async () => {
    expect(await runWaitingTailoring()).toBe(1);
  });

  const connectionId = history.connectionIds.get("fake-lh-lakeshore") ?? "";
  await time.job("New bank redraft check on the full history", 5_000, async () => {
    await checkNewBankRedraft(connectionId);
  });
});
