import { expect } from "vitest";
import { aiCost, householdAi } from "../../ai/index.ts";
import {
  type BuiltSummary,
  householdSummary,
  SUMMARY_TOKENS,
  summaryTokens,
} from "../../summary/index.ts";
import { HISTORY_NOW } from "../history.ts";
import { REQUEST_LIMIT_MS, timedCase, timeWork } from "../index.ts";

// The Household summary on the full history (spec 08, Household summary): the day's build, which
// runs before the day's first Writer use, and the Monthly review's build for the month just ended.
// Each has the 1 s request limit, as a Writer use waits on it. Each row names its size in tokens.
timedCase("the Household summary", async (history, time) => {
  const ai = householdAi({
    database: history.database,
    secrets: history.secrets,
    cost: aiCost({ database: history.database }),
  });
  const summary = householdSummary({ database: history.database, ai, now: HISTORY_NOW });
  const build = async (what: string, work: () => Promise<BuiltSummary>) => {
    const { result, ms, wallMs } = await timeWork(work);
    const { text } = result;
    const tokens = summaryTokens(text);
    time.add({
      path: `Household summary, ${what}, ${tokens.toLocaleString("en-US")} tokens`,
      ms,
      wallMs,
      limitMs: REQUEST_LIMIT_MS,
    });
    expect(tokens).toBeLessThanOrEqual(SUMMARY_TOKENS);
    return result;
  };

  const today = await build("the day's build", () => summary.today());
  expect(today.text).toContain("## Per Category, Spending in each complete month");
  await build("the Monthly review's build", () => summary.monthJustEnded());
});
