import { expect } from "vitest";
import { aiCost, aiSettings } from "../../ai/index.ts";
import { newAiKey, type StubMessage } from "../../ai/testing.ts";
import { CATEGORY_FIX_TASK, MERCHANT_CLEANUP_TASK } from "../../categorization/quick-tier.ts";
import { claimHistoryWaitEnd, readAiRedo } from "../../db/index.ts";
import { householdTimeZone } from "../../household/index.ts";
import { INSIGHT_CARDS_TASK } from "../../insights/index.ts";
import { PAIR_TASK, PICK_TASK } from "../../money-movement/ai-links.ts";
import { MONEY_FROM_PERSON_KIND, UNCLEAR_PAIR_KIND } from "../../money-movement/index.ts";
import { runRedo } from "../../redo/index.ts";
import { timedCase } from "../index.ts";

const NOW = () => new Date("2026-11-02T14:00:00.000Z");
const PRICE = { input: 1_000_000, output: 2_000_000 };

const textsOf = (messages: StubMessage[]) =>
  messages.flatMap((message) =>
    message.role !== "user"
      ? []
      : typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.text === undefined ? [] : [part.text])),
  );

const insightCards = JSON.stringify({
  cards: [1, 2, 3, 4].map((n) => ({
    group: "heads_up",
    about: `Topic ${n}`,
    figure: n,
    figureKind: "count",
    figureLabel: "this month",
    title: `Card ${n}`,
    why: `Why card ${n} matters.`,
    nextStep: `Step ${n}.`,
    picture: null,
  })),
});

// The first AI run over the full history (spec 08, Runs that reuse these uses). The build ran with
// no AI provider, so every Category step 6 guessed and every name the rules could not clean is
// marked, as an install has them when AI is set up after the history loads. The run sends them to
// the AI's test models in Quick batches of up to 100, never one call for each Transaction, then
// writes one Insight card run.
timedCase("The first AI run on the full history", async (history, time) => {
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
  const calls = new Map<string, number>();
  let rows = 0;
  history.ai.replyTo = (messages) => {
    const texts = textsOf(messages);
    const batch = texts
      .filter((text) => text.startsWith('{"row":'))
      .map((text) => JSON.parse(text) as { row: number; kind?: string });
    const use = texts.includes(CATEGORY_FIX_TASK)
      ? "category fix"
      : texts.includes(MERCHANT_CLEANUP_TASK)
        ? "merchant cleanup"
        : texts.includes(PAIR_TASK)
          ? "pairs"
          : texts.includes(PICK_TASK)
            ? "picks"
            : texts.some((text) => text.includes(INSIGHT_CARDS_TASK))
              ? "insight cards"
              : "other";
    calls.set(use, (calls.get(use) ?? 0) + 1);
    rows += batch.length;
    expect(batch.length).toBeLessThanOrEqual(100);
    switch (use) {
      case "category fix":
        return JSON.stringify({
          answers: batch.map((row) => ({ row: row.row, category: "Hobbies", confidence: "high" })),
        });
      case "merchant cleanup":
        return JSON.stringify({
          answers: batch.map((row) => ({ row: row.row, name: `Shop ${row.row}` })),
        });
      case "pairs":
        return JSON.stringify({
          answers: batch.map((row) => ({ row: row.row, answer: "no", confidence: "low" })),
        });
      case "picks":
        return JSON.stringify({
          answers: batch
            .filter((row) => row.kind === "money in")
            .map((row) => ({ row: row.row, spendingRow: null, confidence: "low" })),
        });
      case "insight cards":
        return insightCards;
      default:
        return "O";
    }
  };
  const count = async (sql: string) => Number((await database.$client.execute(sql)).rows[0]?.n);
  const transactions = await count("SELECT count(*) AS n FROM transactions");
  const guesses = await count(
    "SELECT count(*) AS n FROM transaction_parts WHERE category_needs_ai = 1",
  );
  const names = await count(
    "SELECT count(DISTINCT description) AS n FROM transactions WHERE merchant_needs_ai = 1",
  );
  const marked = (kind: string) =>
    count(`SELECT count(*) AS n FROM review_items
           WHERE kind = '${kind}' AND needs_ai = 1 AND closed_at IS NULL`);
  const money = await marked(MONEY_FROM_PERSON_KIND);
  const pairs = await marked(UNCLEAR_PAIR_KIND);
  await claimHistoryWaitEnd(database, NOW());

  expect(await time.job("First AI run on the full history", 30_000, () => runRedo())).toBe("done");

  const total = [...calls.values()].reduce((sum, each) => sum + each, 0);
  console.log(
    `The first AI run on ${transactions} Transactions with ${guesses} best guesses, ` +
      `${names} marked names, ${pairs} Unclear pairs and ${money} money from a person: ${total} AI ` +
      `calls (${[...calls].map(([use, n]) => `${use} ${n}`).join(", ")}), ${rows} batch rows`,
  );
  expect(calls.get("insight cards")).toBe(1);
  expect((calls.get("category fix") ?? 0) <= Math.ceil(guesses / 100)).toBe(true);
  expect(
    await count("SELECT count(*) AS n FROM transaction_parts WHERE category_needs_ai = 1"),
  ).toBe(0);
  expect((await readAiRedo(database)).firstRunDoneAt).not.toBeNull();
});
