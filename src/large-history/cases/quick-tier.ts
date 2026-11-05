import { expect } from "vitest";
import { aiCost, aiSettings } from "../../ai/index.ts";
import { newAiKey, type StubMessage } from "../../ai/testing.ts";
import { fakeTxn } from "../../bank/fake.ts";
import { syncConnection } from "../../bank/index.ts";
import { MERCHANT_CLEANUP_TASK } from "../../categorization/quick-tier.ts";
import { runFollowUp } from "../../follow-up/index.ts";
import { householdTimeZone } from "../../household/index.ts";
import { LOAN_TASK, PAIR_TASK, PICK_TASK } from "../../money-movement/ai-links.ts";
import { timedCase } from "../index.ts";

const NOW = () => new Date("2026-11-02T14:00:00.000Z");
const PRICE = { input: 1_000_000, output: 2_000_000 };

// The rows of a Quick batch the test models read: each is its own JSON text.
const rowsOf = (messages: StubMessage[]) =>
  messages
    .filter((message) => message.role === "user" && typeof message.content !== "string")
    .flatMap((message) =>
      typeof message.content === "string"
        ? []
        : message.content.flatMap((part) => (part.text?.startsWith("{") ? [part.text] : [])),
    )
    .map((text) => JSON.parse(text) as { row: number; description?: string; kind?: string });

const holdsTask = (messages: StubMessage[], task: string) =>
  messages.some(
    (message) =>
      typeof message.content !== "string" && message.content.some((part) => part.text === task),
  );
const isCleanup = (messages: StubMessage[]) => holdsTask(messages, MERCHANT_CLEANUP_TASK);

// Matching asks about Unclear Transfers, loan payments, and money from a person first (T81). The
// test models answer each "no", or no Spending, with low confidence, so nothing links.
const linkReply = (messages: StubMessage[]): string | undefined => {
  const rows = rowsOf(messages);
  if (holdsTask(messages, PICK_TASK)) {
    const money = rows.filter((row) => row.kind === "money in");
    return JSON.stringify({
      answers: money.map((row) => ({ row: row.row, spendingRow: null, confidence: "low" })),
    });
  }
  if (holdsTask(messages, PAIR_TASK) || holdsTask(messages, LOAN_TASK)) {
    return JSON.stringify({
      answers: rows.map((row) => ({ row: row.row, answer: "no", confidence: "low" })),
    });
  }
  return undefined;
};

// A sync on top of the full history, with an AI provider set up: 600 new purchases at 200 new
// Merchants the cascade cannot settle, each name marked for AI cleanup. The follow-up job sends
// them to the AI's test models in batches, the Category fix and AI cleanup of Merchant names, with
// Merchant history over 5 years of Transactions.
timedCase("Categories and Merchant names from the Quick tier", async (history, time) => {
  const { database, secrets } = history;
  const saved = await aiSettings({
    database,
    secrets,
    makeModels: history.ai.makeModels,
    cost: aiCost({ database, timeZone: () => householdTimeZone(database) }),
  }).save(
    {
      provider: "anthropic",
      apiKey: newAiKey(),
      baseUrl: null,
      quickModel: "quick-model",
      writerModel: "writer-model",
      prices: { quick: PRICE, writer: PRICE },
    },
    { freshCode: true },
  );
  expect(saved).toMatchObject({ saved: true });
  let calls = 0;
  history.ai.replyTo = (messages) => {
    const link = linkReply(messages);
    if (link !== undefined) return link;
    calls += 1;
    const cleanup = isCleanup(messages);
    const answers = rowsOf(messages).map((row) =>
      cleanup
        ? { row: row.row, name: String(row.description).replace(/ AUSTIN TX$/, "") }
        : { row: row.row, category: "Hobbies", confidence: row.row % 4 === 0 ? "medium" : "high" },
    );
    return JSON.stringify({ answers });
  };

  const [bank] = history.generated.banks;
  const account = bank?.accounts.find((found) => found.type === "credit") ?? bank?.accounts[0];
  if (bank === undefined || account === undefined) throw new Error("The history has no Account.");
  const shop = (index: number) =>
    `NEW SHOP ${String.fromCharCode(65 + (index % 20), 65 + Math.floor(index / 20))} AUSTIN TX`;
  history.fake.addPages(bank.bankId, {
    added: Array.from({ length: 600 }, (_, index) =>
      fakeTxn({
        id: `lh-quick-${index}`,
        accountId: account.id,
        amount: -1_800,
        postedDate: `2026-10-${String((index % 28) + 1).padStart(2, "0")}`,
        description: shop(index % 200),
        category: {
          name: "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE",
          confidence: "LOW",
          version: "v2",
          mcc: null,
        },
      }),
    ),
    historyLoaded: true,
  });
  const connectionId = history.connectionIds.get(bank.bankId);
  if (connectionId === undefined) throw new Error("The bank has no Connection.");
  await syncConnection(connectionId, NOW);

  await time.job("Follow-up with Quick-tier Categories and names (600 new)", 10_000, () =>
    runFollowUp(NOW),
  );

  const asked = await database.$client.execute(
    `SELECT count(*) AS n FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id
     WHERE t.provider_transaction_id LIKE 'lh-quick-%' AND p.category_source = 'AI'`,
  );
  expect(Number(asked.rows[0]?.n)).toBeGreaterThan(0);
  expect(calls).toBeGreaterThan(2);
});
