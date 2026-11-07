import { expect } from "vitest";
import { aiCost, aiSettings } from "../../ai/index.ts";
import { newAiKey, type StubMessage } from "../../ai/testing.ts";
import { fakeTxn } from "../../bank/fake.ts";
import { syncConnection } from "../../bank/index.ts";
import { CATEGORY_FIX_TASK } from "../../categorization/quick-tier.ts";
import { MERCHANT_LOOKUP_TASK } from "../../categorization/web-lookup.ts";
import { markSetupStep, storeMerchantLookup } from "../../db/index.ts";
import { runFollowUp } from "../../follow-up/index.ts";
import { householdTimeZone } from "../../household/index.ts";
import { merchantKey } from "../../merchants/index.ts";
import { timedCase } from "../index.ts";

const NOW = () => new Date("2026-11-02T14:00:00.000Z");
const PRICE = { input: 1_000_000, output: 2_000_000 };

const textsOf = (messages: StubMessage[]) =>
  messages
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.text === undefined ? [] : [part.text])),
    );

// A sync on top of the full history, with an AI provider set up: 600 new purchases at 200 new
// Merchants the Category fix is unsure of and does not know. 150 of the Merchants have a kept Web
// lookup, which decides with no call; the run looks up 50 of the rest, its cap, one at a time. Then
// the reads a Member makes of what a Web lookup chose, and the switch.
timedCase("the Web lookup", async (history, time) => {
  const { database, secrets } = history;
  // The switch is a Settings change, which waits for the first-run wizard.
  await markSetupStep(database, "master key", "done");
  await markSetupStep(database, "household facts", "done");
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
  let lookups = 0;
  history.ai.replyTo = (messages) => {
    const texts = textsOf(messages);
    if (texts.includes(MERCHANT_LOOKUP_TASK)) {
      lookups += 1;
      return JSON.stringify({
        found: true,
        category: "Hobbies",
        confidence: "high",
        description: "A hobby shop.",
      });
    }
    const rows = texts
      .filter((text) => text.startsWith("{"))
      .map((text) => JSON.parse(text) as { row: number; kind?: string });
    if (texts.includes(CATEGORY_FIX_TASK)) {
      return JSON.stringify({
        answers: rows.map((row) => ({
          row: row.row,
          category: "General goods",
          confidence: "medium",
          needsLookup: true,
        })),
      });
    }
    // Matching's questions: "no", or no Spending, with low confidence, so nothing links.
    return JSON.stringify({
      answers: rows.map((row) =>
        row.kind === undefined
          ? { row: row.row, answer: "no", confidence: "low" }
          : { row: row.row, spendingRow: null, confidence: "low" },
      ),
    });
  };

  const shop = (index: number) =>
    `Lookup Shop ${String.fromCharCode(65 + (index % 20), 65 + Math.floor(index / 20))}`;
  for (let index = 0; index < 150; index++) {
    await storeMerchantLookup(database, `name:${merchantKey(shop(index))}`, {
      outcome: "found",
      category: "Hobbies",
      confidence: "high",
      description: "A hobby shop.",
      lookedUpAt: NOW(),
    });
  }
  const [bank] = history.generated.banks;
  const account = bank?.accounts.find((found) => found.type === "credit") ?? bank?.accounts[0];
  if (bank === undefined || account === undefined) throw new Error("The history has no Account.");
  history.fake.addPages(bank.bankId, {
    added: Array.from({ length: 600 }, (_, index) =>
      fakeTxn({
        id: `lh-lookup-${index}`,
        accountId: account.id,
        amount: -1_800,
        postedDate: `2026-10-${String((index % 28) + 1).padStart(2, "0")}`,
        description: `LOOKUP PURCHASE ${index}`,
        merchantName: shop(index % 200),
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

  await time.job(
    "Follow-up with Web lookups (600 new, 150 kept Merchants, 50 lookups)",
    10_000,
    () => runFollowUp(NOW),
  );

  expect(lookups).toBe(50);
  const [looked] = (
    await database.$client.execute(
      `SELECT t.id FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id
       WHERE t.provider_transaction_id LIKE 'lh-lookup-%' AND p.category_source = 'Web lookup'
       LIMIT 1`,
    )
  ).rows;
  expect(looked).toBeDefined();
  const detail = (await time.request("GET /api/transactions/:id (a Web lookup's Category)", () =>
    history.browser.get(`/api/transactions/${String(looked?.id)}`),
  )) as { webLookup: { description: string } | null };
  expect(detail.webLookup).toEqual({ description: "A hobby shop." });
  await time.request("GET /api/ai/settings", () => history.browser.get("/api/ai/settings"));
  await time.request("GET /api/ai/usage (with the month's web lookups)", () =>
    history.browser.get("/api/ai/usage"),
  );
  await time.request("PUT /api/ai/web-lookup", () =>
    history.browser.send("PUT", "/api/ai/web-lookup", { on: false }),
  );
});
