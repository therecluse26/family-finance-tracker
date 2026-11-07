import { expect } from "vitest";
import { aiCost, aiSettings } from "../../ai/index.ts";
import { newAiKey, type StubMessage } from "../../ai/testing.ts";
import { CATEGORY_FIX_TASK, MERCHANT_CLEANUP_TASK } from "../../categorization/quick-tier.ts";
import { claimHistoryWaitEnd, markSetupStep, readAiRedo } from "../../db/index.ts";
import { householdTimeZone } from "../../household/index.ts";
import { INSIGHT_CARDS_TASK } from "../../insights/index.ts";
import { PAIR_TASK, PICK_TASK } from "../../money-movement/ai-links.ts";
import { type AiWorkView, runRedoJob } from "../../redo/index.ts";
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

const charsOf = (messages: StubMessage[]) =>
  messages.reduce(
    (sum, message) =>
      sum +
      (typeof message.content === "string"
        ? message.content.length
        : message.content.reduce((n, part) => n + (part.text?.length ?? 0), 0)),
    0,
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

// Settings → AI: AI work on your Transactions (spec 08) on the full history. The build ran with no
// AI provider, so every Category step 6 guessed and every name the rules could not clean is marked.
// The status line counts the marked items; "Finish AI work now" sends them, with the first AI run;
// "Run AI on all history" then sends the AI each Category of the last 18 months that no hand edit,
// Category rule, or Money movement set, past the provider's category and Merchant history, in Quick
// batches of up to 100. Cleaned names and link answers are not asked twice. The case logs the
// characters each Category fix call sends and gets, for the run's Expected cost (spec 08).
timedCase("AI work on your Transactions on the full history", async (history, time) => {
  const { database, secrets, browser } = history;
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
  await markSetupStep(database, "household facts", "done");
  await claimHistoryWaitEnd(database, NOW());
  const calls = new Map<string, number>();
  const fixChars = { sent: 0, got: 0 };
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
    expect(batch.length).toBeLessThanOrEqual(100);
    switch (use) {
      case "category fix": {
        const reply = JSON.stringify({
          answers: batch.map((row) => ({ row: row.row, category: "Hobbies", confidence: "high" })),
        });
        fixChars.sent += charsOf(messages);
        fixChars.got += reply.length;
        return reply;
      }
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
  type Answer = { work: AiWorkView };
  const workOf = async (res: Response) => ((await res.json()) as Answer).work;

  const { work: before } = (await time.request("GET /api/ai/work", () =>
    browser.get("/api/ai/work"),
  )) as Answer;
  expect(before).toMatchObject({ running: null, waits: null, lastRun: null });
  expect(before.waiting).toBeGreaterThan(1_000);

  const finish = (await time.request("POST /api/ai/work/finish", () =>
    browser.post("/api/ai/work/finish"),
  )) as Answer;
  expect(finish.work.running).toEqual({ kind: "finish", step: "starting" });
  await time.job("Finish AI work now on the full history", 30_000, () => runRedoJob("finish"));
  const finished = await workOf(await browser.get("/api/ai/work"));
  expect(finished).toMatchObject({ running: null, waiting: 0 });
  expect(finished.lastRun).toMatchObject({ outcome: "finished", items: before.waiting });
  expect((await readAiRedo(database)).firstRunDoneAt).not.toBeNull();

  // Merchant history decided most Categories once the names were cleaned. Each Category of the last
  // 18 months that no hand edit, Category rule, or Money movement set goes to the AI.
  const count = async (sql: string) => Number((await database.$client.execute(sql)).rows[0]?.n);
  const sent = await count(`SELECT count(DISTINCT transaction_id) AS n FROM transaction_parts
    WHERE category_source IN ('provider', 'Merchant history', 'AI', 'best guess')
      AND (type = 'Spending' OR (type = 'Refund' AND linked = 0))
      AND transaction_id IN (SELECT id FROM transactions
        WHERE posted_date >= '2025-05-01' AND hidden_reason IS NULL)`);
  expect(sent).toBeGreaterThan(1_000);
  calls.clear();
  fixChars.sent = 0;
  fixChars.got = 0;
  const again = (await time.request("POST /api/ai/work/all-history", () =>
    browser.post("/api/ai/work/all-history"),
  )) as Answer;
  expect(again.work.running).toEqual({ kind: "all history", step: "starting" });
  await time.job("Run AI on all history on the full history", 30_000, () =>
    runRedoJob("all history"),
  );

  const done = await workOf(await browser.get("/api/ai/work"));
  const fixCalls = calls.get("category fix") ?? 0;
  // About 4 characters a token, at the Quick tier's price (spec 08, Expected cost).
  const tokens = { in: fixChars.sent / 4, out: fixChars.got / 4 };
  const dollars = (tokens.in * 0.1 + tokens.out * 0.5) / 1_000_000;
  console.log(
    `Run AI on all history: ${sent} Transactions sent, ${done.lastRun?.items} items decided, ` +
      `the AI answered ${done.lastRun?.aiCategories}, ${fixCalls} Category fix calls, ` +
      `about ${Math.round(tokens.in)} input and ${Math.round(tokens.out)} output tokens, ` +
      `about $${dollars.toFixed(3)} at Haiku 5.5's price`,
  );
  // Only Categories are asked again, in Quick batches, never one call for each Transaction. The
  // provider's category and Merchant history do not stop one.
  expect([...calls.keys()].filter((use) => use !== "category fix")).toEqual([]);
  expect(done.lastRun?.items).toBe(sent);
  expect(done.lastRun?.aiCategories).toBe(sent);
  expect(fixCalls).toBeGreaterThanOrEqual(Math.ceil(sent / 100));
  expect(fixCalls).toBeLessThanOrEqual(Math.ceil(sent / 100) + 1);
  expect(done).toMatchObject({ running: null, waiting: 0 });
  expect(done.lastRun).toMatchObject({ outcome: "finished" });
  expect(
    await count("SELECT count(*) AS n FROM transaction_parts WHERE category_needs_ai = 1"),
  ).toBe(0);
});
