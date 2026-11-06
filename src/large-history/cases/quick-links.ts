import { expect } from "vitest";
import { aiCost, aiSettings } from "../../ai/index.ts";
import { newAiKey, type StubMessage } from "../../ai/testing.ts";
import { fakeTxn } from "../../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../../bank/index.ts";
import { MERCHANT_CLEANUP_TASK } from "../../categorization/quick-tier.ts";
import { followUpAgain, runFollowUp } from "../../follow-up/index.ts";
import { LOAN_TASK, PAIR_TASK, PICK_TASK } from "../../money-movement/ai-links.ts";
import { MONEY_FROM_PERSON_KIND } from "../../money-movement/index.ts";
import { timedCase } from "../index.ts";

const PRICE = { input: 1_000_000, output: 2_000_000 };
const DAY = () => new Date("2026-11-02T14:00:00.000Z");
const NEXT_DAY = () => new Date("2026-11-03T14:00:00.000Z");

const textOf = (content: StubMessage["content"]): string =>
  typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
const holdsTask = (messages: StubMessage[], task: string) =>
  messages.some(
    (message) =>
      typeof message.content !== "string" && message.content.some((part) => part.text === task),
  );

// The Quick tier's link decisions (spec 03, Tiers, Reimbursements) on the full history. With the AI
// on, Matching runs again over every Transaction: each Unclear Transfer pair and Manual loan
// payment goes to the AI in batches, and so does each money from a person with no open item. The
// test models answer "no" with low confidence and pick no Spending, so nothing links. A second run
// asks nothing: each answer is stored. Then a normal day brings three new money from a person, and
// a day with none asks nothing. It prints each run's link calls and their input tokens, as
// characters divided by 4 (spec 08), for the PR text. Categorization's own calls are not counted.
timedCase("the Quick tier's link decisions on the full history", async (history, time) => {
  const { database, secrets } = history;
  const saved = await aiSettings({
    database,
    secrets,
    makeModels: history.ai.makeModels,
    cost: aiCost({ database }),
  }).save({
    provider: "anthropic",
    apiKey: newAiKey(),
    baseUrl: null,
    quickModel: "quick-model",
    writerModel: "writer-model",
    prices: { quick: PRICE, writer: PRICE },
  });
  expect(saved).toMatchObject({ saved: true });
  const used = { picks: 0, others: 0, characters: 0 };
  history.ai.replyTo = (messages) => {
    // The batch is the last message: one JSON text for each row.
    const last = messages.at(-1)?.content;
    const rows = typeof last === "string" || last === undefined ? [] : last;
    const link = [PICK_TASK, PAIR_TASK, LOAN_TASK].some((task) => holdsTask(messages, task));
    if (link) {
      for (const message of messages) used.characters += textOf(message.content).length;
    }
    if (holdsTask(messages, PICK_TASK)) {
      used.picks += 1;
      const money = rows.filter((part) => part.text?.includes('"kind":"money in"')).length;
      return JSON.stringify({
        answers: Array.from({ length: money }, (_, index) => ({
          row: index + 1,
          spendingRow: null,
          confidence: "low",
        })),
      });
    }
    if (link) used.others += 1;
    const cleanup = holdsTask(messages, MERCHANT_CLEANUP_TASK);
    return JSON.stringify({
      answers: rows.map((_, index) =>
        link
          ? { row: index + 1, answer: "no", confidence: "low" }
          : cleanup
            ? { row: index + 1, name: "Shop" }
            : { row: index + 1, category: "Hobbies", confidence: "low" },
      ),
    });
  };
  const counted = (run: string) => {
    const { picks, others, characters } = used;
    console.log(
      `Quick tier links, ${run}: ${picks} Reimbursement calls, ${others} other link calls, ` +
        `about ${Math.round(characters / 4)} input tokens`,
    );
    used.picks = 0;
    used.others = 0;
    used.characters = 0;
    return picks + others;
  };

  // Each money from a person goes to the AI only when it opens an item.
  await database.$client.execute({
    sql: "DELETE FROM review_items WHERE kind = ?",
    args: [MONEY_FROM_PERSON_KIND],
  });
  const ids = (await database.$client.execute("SELECT id FROM transactions")).rows.map((row) =>
    String(row.id),
  );
  await followUpAgain(database, ids);
  // A background job, not a request, so K9's 1 s rule does not apply; 45 s of CPU time.
  await time.job("Matching with the Quick tier on the full history", 45_000, () =>
    runFollowUp(DAY),
  );
  expect(counted("first run")).toBeGreaterThan(0);
  const answers = await database.$client.execute("SELECT count(*) AS n FROM ai_link_answers");
  expect(Number(answers.rows[0]?.n)).toBeGreaterThan(0);

  await followUpAgain(database, ids);
  await time.job("Matching again, with every answer stored", 60_000, () => runFollowUp(DAY));
  expect(counted("again")).toBe(0);

  // A normal day: three new money from a person on checking. Then a day with one new purchase.
  const lakeshore = history.generated.banks.find((bank) => bank.bankId === "fake-lh-lakeshore");
  const checking = lakeshore?.accounts.find((account) => account.subtype === "checking");
  if (lakeshore === undefined || checking === undefined) throw new Error("No checking Account.");
  const connectionId = history.connectionIds.get(lakeshore.bankId) ?? "";
  const syncDay = async (added: TxnRecord[], now: () => Date) => {
    history.fake.addPages(lakeshore.bankId, {
      added,
      changed: [],
      removed: [],
      historyLoaded: true,
    });
    await syncConnection(connectionId, now);
  };
  await syncDay(
    [2_500, 4_000, 6_500].map((amount, index) =>
      fakeTxn({
        id: `lh-day-money-${index}`,
        accountId: checking.id,
        amount,
        postedDate: "2026-11-02",
        description: "VENMO CASHOUT",
        category: {
          name: "TRANSFER_IN_TRANSFER_IN_FROM_APPS",
          confidence: "MEDIUM",
          version: "v2",
          mcc: null,
        },
      }),
    ),
    DAY,
  );
  await time.job("Follow-up of a day with 3 money from a person", 10_000, () => runFollowUp(DAY));
  const day = used.picks;
  expect(counted("normal day")).toBeGreaterThan(0);
  expect(day).toBeLessThanOrEqual(6);

  await syncDay(
    [
      fakeTxn({
        id: "lh-day-purchase",
        accountId: checking.id,
        amount: -1_850,
        postedDate: "2026-11-03",
        description: "CORNER BISTRO",
        merchantName: "Corner Bistro",
      }),
    ],
    NEXT_DAY,
  );
  await time.job("Follow-up of a day with no money from a person", 10_000, () =>
    runFollowUp(NEXT_DAY),
  );
  expect(counted("day with no money from a person")).toBe(0);
});
