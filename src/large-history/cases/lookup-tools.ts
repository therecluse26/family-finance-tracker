import { expect } from "vitest";
import { aiCost, householdAi } from "../../ai/index.ts";
import { lookupTools, RECURRING_ROWS } from "../../chat/index.ts";
import { HISTORY_NOW } from "../history.ts";
import { REQUEST_LIMIT_MS, timedCase } from "../index.ts";

// Chat's lookup tools on the full history, each as the AI's tool call runs it, through the privacy
// filter. Each has the 1 s request limit: Chat waits on it. Each answer's size goes in the table,
// and stays under 10,000 characters, about 2,500 tokens (spec 08 counts characters / 4), as the AI
// reads it again on each later round. The widest inputs: every Transaction, every Merchant and
// every month over five years, every Recurring charge, Debt over every date, and 92 days of daily
// Cash on hand.
const ANSWER_CHARACTERS = 10_000;

timedCase("Chat lookup tools", async (history, time) => {
  const ai = householdAi({
    database: history.database,
    secrets: history.secrets,
    cost: aiCost({ database: history.database }),
  });
  const tools = lookupTools({ database: history.database, ai, now: HISTORY_NOW });
  const sizes: Record<string, number> = {};
  const lookup = async (name: keyof typeof tools, input: unknown, what = "") => {
    const started = performance.now();
    const answer = await tools[name]?.run(input);
    const ms = Math.round(performance.now() - started);
    const characters = JSON.stringify(answer).length;
    sizes[`${name}${what}`] = characters;
    time.add({
      path: `Chat tool ${name}${what}, ${characters.toLocaleString("en-US")} characters`,
      ms,
      limitMs: REQUEST_LIMIT_MS,
    });
    return answer;
  };

  const found = (await lookup("search_transactions", {
    merchant: null,
    category: null,
    account: null,
    type: null,
    from: null,
    to: null,
    minAmount: null,
    maxAmount: null,
  })) as { count: number };
  expect(found.count).toBeGreaterThan(10_000);
  for (const groupedBy of ["Merchant", "month"]) {
    await lookup(
      "get_totals",
      { of: "Spending", groupedBy, from: "2021-11-01", to: "2026-10-31" },
      ` by ${groupedBy}`,
    );
  }
  await lookup(
    "get_balance_history",
    { of: "Debt", account: null, from: "1900-01-01", to: "2999-12-31" },
    ", Debt over every date",
  );
  await lookup(
    "get_balance_history",
    { of: "Cash on hand", account: null, from: "2026-08-01", to: "2026-10-31" },
    ", 92 days of Cash on hand",
  );
  const charges = (await lookup("get_recurring_charges", { category: null })) as {
    count: number;
  };
  expect(charges.count).toBeGreaterThan(RECURRING_ROWS);
  await lookup("get_budgets_and_goals", { month: "2026-10" });

  expect(Object.entries(sizes).filter(([, size]) => size >= ANSWER_CHARACTERS)).toEqual([]);
});
