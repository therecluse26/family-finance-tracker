import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { type AI_USE_NAMES, aiCalls, aiCostCap, aiModelPrices, aiRequestLog } from "./schema.ts";

// AI calls, the AI cost cap, and Member-entered prices in app.db (spec 08, Counting cost and The
// AI cost cap). The ai module decides and counts; these functions store and read. Nothing here
// holds prompt text or reply text: the AI request log keeps that, in its own table.

export type AiUseName = (typeof AI_USE_NAMES)[number];

export type StoredAiCall = typeof aiCalls.$inferSelect;

export type NewAiCall = Omit<StoredAiCall, "id">;

// The ID of ai_cost_cap's one row.
const COST_CAP_ROW = 1;

// Stores one call. Returns its ID, which the AI request log links its text to.
export async function addAiCall(database: Database, call: NewAiCall): Promise<number> {
  const [row] = await database.insert(aiCalls).values(call).returning({ id: aiCalls.id });
  if (row === undefined) throw new Error("The AI call was not stored.");
  return row.id;
}

// The month's cost, in billionths of a dollar.
export async function readMonthCost(database: Database, month: string): Promise<number> {
  const [row] = await database
    .select({ total: sql<number | null>`sum(${aiCalls.costNanos})` })
    .from(aiCalls)
    .where(eq(aiCalls.month, month));
  return Number(row?.total ?? 0);
}

export type UseCost = { use: AiUseName; calls: number; costNanos: number };

// The month's cost per use, most costly first.
export async function readMonthCostByUse(database: Database, month: string): Promise<UseCost[]> {
  const rows = await database
    .select({
      use: aiCalls.use,
      calls: sql<number>`count(*)`,
      costNanos: sql<number>`sum(${aiCalls.costNanos})`,
    })
    .from(aiCalls)
    .where(eq(aiCalls.month, month))
    .groupBy(aiCalls.use)
    .orderBy(desc(sql`sum(${aiCalls.costNanos})`), aiCalls.use);
  return rows.map((row) => ({
    ...row,
    calls: Number(row.calls),
    costNanos: Number(row.costNanos),
  }));
}

// The month's calls, newest first, at most `limit`, each with the ID of its kept text in the AI
// request log, or null.
export async function listMonthAiCalls(
  database: Database,
  month: string,
  limit: number,
): Promise<(StoredAiCall & { logEntryId: number | null })[]> {
  const rows = await database
    .select({ call: aiCalls, logEntryId: aiRequestLog.id })
    .from(aiCalls)
    .leftJoin(aiRequestLog, eq(aiRequestLog.aiCallId, aiCalls.id))
    .where(eq(aiCalls.month, month))
    .orderBy(desc(aiCalls.at), desc(aiCalls.id))
    .limit(limit);
  return rows.map(({ call, logEntryId }) => ({ ...call, logEntryId }));
}

// The cap a Member set, in cents, or undefined while it is the default.
export async function readCostCap(database: Database): Promise<number | undefined> {
  const [row] = await database
    .select({ capCents: aiCostCap.capCents })
    .from(aiCostCap)
    .where(eq(aiCostCap.id, COST_CAP_ROW));
  return row?.capCents ?? undefined;
}

export async function storeCostCap(database: Database, capCents: number): Promise<void> {
  await database
    .insert(aiCostCap)
    .values({ id: COST_CAP_ROW, capCents })
    .onConflictDoUpdate({ target: aiCostCap.id, set: { capCents } });
}

export type CapNotice = "80%" | "100%";

// Marks the notice as sent for `month`. True only for the one caller that marked it first, so each
// notice goes out once a month.
export async function claimCapNotice(
  database: Database,
  notice: CapNotice,
  month: string,
): Promise<boolean> {
  const column = notice === "80%" ? aiCostCap.warnedMonth : aiCostCap.reachedMonth;
  await database.insert(aiCostCap).values({ id: COST_CAP_ROW }).onConflictDoNothing();
  const claimed = await database
    .update(aiCostCap)
    .set(notice === "80%" ? { warnedMonth: month } : { reachedMonth: month })
    .where(and(eq(aiCostCap.id, COST_CAP_ROW), or(isNull(column), ne(column, month))))
    .returning({ id: aiCostCap.id });
  return claimed.length === 1;
}

export type ProviderName = (typeof aiModelPrices.$inferSelect)["provider"];

export type MemberPrice = { input: number; output: number };

export async function readMemberPrice(
  database: Database,
  provider: ProviderName,
  model: string,
): Promise<MemberPrice | undefined> {
  const [row] = await database
    .select({ input: aiModelPrices.input, output: aiModelPrices.output })
    .from(aiModelPrices)
    .where(and(eq(aiModelPrices.provider, provider), eq(aiModelPrices.model, model)));
  return row;
}

export async function storeMemberPrice(
  database: Database,
  provider: ProviderName,
  model: string,
  price: MemberPrice,
): Promise<void> {
  await database
    .insert(aiModelPrices)
    .values({ provider, model, ...price })
    .onConflictDoUpdate({ target: [aiModelPrices.provider, aiModelPrices.model], set: price });
}
