import * as z from "zod";
import {
  type AiReply,
  type BatchItem,
  batchReply,
  type HouseholdAi,
  PrivacyRefusal,
  QUICK_BATCH_SIZE,
} from "../ai/index.ts";
import { CATEGORIES, type Category } from "../categories/index.ts";
import {
  applyMerchantNameAnswers,
  type Database,
  listMarkedNames,
  readMerchantNameAnswers,
  storeMerchantNameAnswers,
} from "../db/index.ts";
import { dollarsAndCents } from "../format.ts";
import { log } from "../log.ts";

// The categorization step's two Quick-tier uses (spec 08, Every AI use; spec 04, AI decisions):
// the Category fix at cascade step 5, and AI cleanup of the Merchant names the fixed rules could
// not fix. Each sends up to 100 rows in one normal call, never a batch API. Each row is plain
// fields with its row number, never a Transaction ID. All of it is app-built text, so the privacy
// filter's final check reads it.

// What a use's batch got back: an answer per row, in row order; or a retry time, so the rows wait
// for the AI retry; or no answer, so the rows take the no-AI path. With `off`, AI is not available,
// such as with no AI provider, at the AI cost cap, or after the last retry, and the use's later
// batches take the no-AI path too, so no new retry cycle starts. With `refused`, the privacy filter
// refused this batch alone.
export type QuickAnswer<T> = { answers: T[] } | { retryAt: Date } | { noAi: "off" | "refused" };

// The AI's confidence in a Category. Below high, the AI counts as unsure.
export type AiConfidence = "high" | "medium" | "low";

// One Transaction of a Category fix: its Merchant, bank description, amount, date, Account label,
// and the provider's category and MCC as hints.
export type CategoryFixRow = {
  merchant: string | null;
  description: string;
  amount: number;
  date: string;
  account: string | null;
  providerCategory: string | null;
  mcc: string | null;
};

const CATEGORY_NAMES = CATEGORIES.map((category) => category.name) as [Category, ...Category[]];

// The Category fix's task: the same in every call, so a sync's batches share its cache mark.
export const CATEGORY_FIX_TASK = [
  "Choose one Category for each Transaction below. Each Transaction is one JSON object with its row number.",
  "- merchant: the Merchant's clean name, or null when it has none.",
  "- description: the bank's description.",
  "- amount: in dollars. A minus sign is money out of the Account.",
  "- date: the date it posted.",
  "- account: the Account, by bank and type.",
  "- providerCategory: the bank-data provider's category. It is a hint only, and may be wrong or missing.",
  "- mcc, when given: the card network's merchant category code. It is a hint only.",
  "Answer every row once, with its row number, one Category from the list below by its exact name, and your confidence: high, medium, or low. Say high only when you are sure.",
  "Categories:",
  ...CATEGORIES.map((category) => `- ${category.name}: ${category.definition}`),
].join("\n");

// AI cleanup's task. No example holds a digit, so no Account's last 4 digits can match it.
export const MERCHANT_CLEANUP_TASK = [
  "Give the Merchant's clean name for each Transaction below. Each Transaction is one JSON object with its row number and the bank's description.",
  'The clean name is the business or person paid, written as a person would write it, such as "Chipotle" for "CHIPOTLE AUSTIN TX".',
  "Leave out store numbers, cities, states, dates, payment-processor prefixes, card and reference numbers, and words such as PURCHASE or DEBIT.",
  "Answer every row once, with its row number and the name.",
].join("\n");

const CATEGORY_ANSWER = z.object({
  category: z.enum(CATEGORY_NAMES),
  confidence: z.enum(["high", "medium", "low"]),
});

const NAME_ANSWER = z.object({ name: z.string().trim().min(1).max(100) });

// The answers of one batch's reply, in row order, or why it has none. A privacy refusal sends
// nothing: its rows take the no-AI path, and the next batch still goes out.
async function ask<T extends { row: number }>(
  generate: () => Promise<AiReply<{ answers: T[] }>>,
  use: string,
): Promise<QuickAnswer<T>> {
  let reply: AiReply<{ answers: T[] }>;
  try {
    reply = await generate();
  } catch (error) {
    if (!(error instanceof PrivacyRefusal)) throw error;
    log.warn("The privacy filter refused a Quick batch", { use });
    return { noAi: "refused" };
  }
  if (reply.ready) {
    return { answers: [...reply.output.answers].sort((a, b) => a.row - b.row) };
  }
  if ("retryAt" in reply) return { retryAt: reply.retryAt };
  return { noAi: "off" };
}

const fixRow = (row: CategoryFixRow): BatchItem => ({
  merchant: row.merchant,
  description: row.description,
  amount: dollarsAndCents(row.amount),
  date: row.date,
  account: row.account,
  providerCategory: row.providerCategory,
  ...(row.mcc === null ? {} : { mcc: row.mcc }),
});

// One Category fix call for 1 to 100 Transactions.
export async function fixCategories(
  ai: HouseholdAi,
  rows: readonly CategoryFixRow[],
): Promise<QuickAnswer<{ category: Category; confidence: AiConfidence }>> {
  if (rows.length === 0 || rows.length > QUICK_BATCH_SIZE) {
    throw new RangeError("A Category fix batch holds 1 to 100 Transactions.");
  }
  return ask(
    () =>
      ai.generate({
        use: "category fix",
        task: CATEGORY_FIX_TASK,
        batch: rows.map(fixRow),
        output: batchReply(CATEGORY_ANSWER, rows.length),
      }),
    "category fix",
  );
}

// AI cleanup of the marked Merchant names among these Transactions, before the cascade reads them
// (spec 04, Names). An answer kept for a description is reused, so the AI sees each description
// once; the others go out in batches of up to 100 descriptions. Each answer becomes the clean name
// of every marked Transaction with that description. Returns the Transactions whose names wait for
// the AI retry, and its time. Without AI, the rule-cleaned name stays, and so does its mark, for
// the redo of no-AI work.
export async function cleanMarkedNames(
  database: Database,
  ai: HouseholdAi,
  ids: readonly string[],
  now = new Date(),
): Promise<{ waiting: ReadonlySet<string>; again?: Date }> {
  const marked = await listMarkedNames(database, ids);
  if (marked.length === 0) return { waiting: new Set() };
  const kept = await readMerchantNameAnswers(
    database,
    marked.map((txn) => txn.description),
  );
  const asked = [...new Set(marked.map((txn) => txn.description))].filter(
    (description) => !kept.has(description),
  );
  let again: Date | undefined;
  let left: readonly string[] = [];
  for (let start = 0; start < asked.length; start += QUICK_BATCH_SIZE) {
    const descriptions = asked.slice(start, start + QUICK_BATCH_SIZE);
    const answer = await ask(
      () =>
        ai.generate({
          use: "merchant cleanup",
          task: MERCHANT_CLEANUP_TASK,
          batch: descriptions.map((description) => ({ description })),
          output: batchReply(NAME_ANSWER, descriptions.length),
        }),
      "merchant cleanup",
    );
    if ("retryAt" in answer) {
      again = answer.retryAt;
      left = asked.slice(start);
      break;
    }
    if ("noAi" in answer) {
      if (answer.noAi === "off") break;
      continue;
    }
    // Each name as the screen shows it: a Member's label back to the Member's name, in the one
    // plain voice. A name that leaves nothing keeps the rule-cleaned name and its mark.
    const named: { description: string; name: string }[] = [];
    for (const { row, name } of answer.answers) {
      const shown = (await ai.forScreen(name)).replace(/\s+/g, " ").trim();
      const description = descriptions[row - 1];
      if (shown !== "" && description !== undefined) named.push({ description, name: shown });
    }
    await storeMerchantNameAnswers(database, named, now);
  }
  await applyMerchantNameAnswers(
    database,
    marked.map((txn) => txn.id),
  );
  const waitingFor = new Set(left);
  const waiting = new Set(
    marked.filter((txn) => waitingFor.has(txn.description)).map((txn) => txn.id),
  );
  return again === undefined ? { waiting } : { waiting, again };
}
