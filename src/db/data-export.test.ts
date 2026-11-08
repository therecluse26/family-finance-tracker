import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { type SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXPORTED_TABLES, NEVER_EXPORTED_TABLES, readExportedJson } from "./data-export.ts";
import * as schema from "./schema.ts";
import { newTestDatabase, type TestDatabase } from "./testing.ts";

// The data export's allowlist (spec 11, Data export): every table and column in schema.ts is
// either exported or named as never exported, so a table or column added later fails here until
// someone decides.

const TABLES: SQLiteTable[] = Object.values(schema as Record<string, unknown>).filter(
  (value): value is SQLiteTable => is(value, SQLiteTable),
);
const exportedNamed = (name: string) => EXPORTED_TABLES.find((entry) => entry.name === name);

describe("the data export's allowlist", () => {
  it("names every table in schema.ts once: exported, or never exported with a reason", () => {
    const exported = EXPORTED_TABLES.map((entry) => entry.name);
    const never = [...NEVER_EXPORTED_TABLES.keys()];

    expect(new Set(exported).size).toBe(exported.length);
    expect(exported.filter((name) => NEVER_EXPORTED_TABLES.has(name))).toEqual([]);
    expect([...exported, ...never].sort()).toEqual(TABLES.map(getTableName).sort());
    for (const reason of NEVER_EXPORTED_TABLES.values()) expect(reason).not.toBe("");
  });

  it("names every column of an exported table once: exported, or left out", () => {
    for (const entry of EXPORTED_TABLES) {
      const named = [...entry.columns, ...entry.leftOut];
      expect(new Set(named).size, entry.name).toBe(named.length);
      expect(named.sort(), entry.name).toEqual(Object.keys(getTableColumns(entry.table)).sort());
    }
  });

  it("never exports a secret, a login record, a session, or the provider's raw data", () => {
    for (const table of [
      schema.dataKeys,
      schema.sessions,
      schema.accounts,
      schema.verifications,
      schema.twoFactors,
      schema.passkeys,
      schema.rateLimits,
      schema.signInTries,
      schema.vapidKeys,
      schema.pushDevices,
    ]) {
      expect(exportedNamed(getTableName(table)), getTableName(table)).toBeUndefined();
    }
    const leftOut = (table: SQLiteTable, column: string) =>
      expect(exportedNamed(getTableName(table))?.leftOut).toContain(column);
    leftOut(schema.connections, "credential");
    leftOut(schema.connections, "syncCursor");
    leftOut(schema.plaidSettings, "clientId");
    leftOut(schema.plaidSettings, "secret");
    leftOut(schema.smtpSettings, "username");
    leftOut(schema.smtpSettings, "password");
    leftOut(schema.aiSettings, "apiKey");
    leftOut(schema.aiSettings, "gatewayToken");
    leftOut(schema.aiSettings, "baseUrl");
    leftOut(schema.transactions, "raw");
    leftOut(schema.householdAccounts, "raw");
  });

  it("exports the data spec 11 names: removed Transactions, Monthly reviews, Insight cards, Chat, Proposals, and Alerts", () => {
    for (const table of [
      schema.transactions,
      schema.monthlyReviews,
      schema.insightCards,
      schema.chatThreads,
      schema.chatMessages,
      schema.proposals,
      schema.proposalBudgets,
      schema.alerts,
    ]) {
      expect(exportedNamed(getTableName(table)), getTableName(table)).toBeDefined();
    }
    expect(exportedNamed("transactions")?.columns).toEqual(
      expect.arrayContaining(["hiddenReason", "hiddenAt"]),
    );
  });
});

describe("reading an exported table", () => {
  let test: TestDatabase;

  beforeEach(async () => {
    test = await newTestDatabase();
  });

  afterEach(() => {
    test.close();
  });

  const entryNamed = (name: string) => {
    const entry = exportedNamed(name);
    if (entry === undefined) throw new Error(`${name} is not exported.`);
    return entry;
  };

  const pagesOf = async (name: string, pageRows?: number) => {
    const pages: unknown[][] = [];
    for await (const page of readExportedJson(test.database, entryNamed(name), pageRows)) {
      pages.push(JSON.parse(`[${page}]`) as unknown[]);
    }
    return pages;
  };

  // The rows as Drizzle reads them, by column name, through JSON.stringify: what data.json would
  // hold if the app wrote each row itself.
  const drizzleRows = async (name: string) => {
    const entry = entryNamed(name);
    const columns = getTableColumns(entry.table);
    const picked = Object.fromEntries(
      entry.columns.map((key) => [columns[key]?.name ?? key, columns[key] as SQLiteColumn]),
    );
    const rows = await test.database.select(picked).from(entry.table).orderBy(sql`rowid`);
    return JSON.parse(JSON.stringify(rows)) as unknown[];
  };

  it("exports the stored Chat model, and an empty one as null", async () => {
    await test.database.$client.execute(
      "INSERT INTO ai_settings (id, provider, quick_model, writer_model) " +
        "VALUES (1, 'anthropic', 'quick-model', 'writer-model')",
    );
    expect((await pagesOf("ai_settings")).flat()).toEqual([
      {
        provider: "anthropic",
        quick_model: "quick-model",
        writer_model: "writer-model",
        chat_model: null,
        web_lookup: true,
      },
    ]);

    await test.database.$client.execute("UPDATE ai_settings SET chat_model = 'chat-model'");
    expect((await pagesOf("ai_settings")).flat()).toMatchObject([{ chat_model: "chat-model" }]);
  });

  it("reads every row once, a page at a time, by column name as app.db names it", async () => {
    const at = new Date("2026-11-05T12:00:00.000Z");
    for (let i = 1; i <= 5; i += 1) {
      await test.database
        .insert(schema.systemNotices)
        .values({ id: `notice-${i}`, kind: "event", text: `Notice ${i}`, raisedAt: at });
    }

    const pages = await pagesOf("system_notices", 2);

    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
    expect(pages.flat().map((row) => (row as { id: string }).id)).toEqual([
      "notice-1",
      "notice-2",
      "notice-3",
      "notice-4",
      "notice-5",
    ]);
    expect(pages[0]?.[0]).toEqual({
      id: "notice-1",
      kind: "event",
      text: "Notice 1",
      condition: null,
      raised_at: "2026-11-05T12:00:00.000Z",
      closed_at: null,
      closed_by: null,
    });
  });

  it("writes each kind of column as the app reads it: booleans, JSON, reals, cents, moments, and nulls", async () => {
    const at = new Date("2026-11-05T12:00:00.000Z");
    await test.database.insert(schema.budgets).values([
      {
        category: 'Groceries "and" more\n\ttab',
        amount: -12_345,
        period: "monthly",
        takesEffect: "2026-11",
        source: "formula",
        pinned: true,
        setAt: at,
        noBudget: false,
        reason: "Ünïcode ✓ \u0001",
      },
      {
        category: "Rent",
        amount: 0,
        period: "yearly",
        takesEffect: "2026",
        source: "Member edit",
        pinned: false,
        setAt: at,
        noBudget: true,
      },
      {
        category: "Fuel",
        amount: 1,
        period: "monthly",
        takesEffect: "2026-12",
        source: "AI draft",
        setAt: at,
      },
    ]);
    const card = {
      writtenAt: at,
      month: "2026-11",
      group: "heads_up" as const,
      about: "Groceries",
      figureKind: "dollars" as const,
      figureLabel: "this month",
      title: "Title",
      why: "Why",
      nextStep: "Next",
    };
    await test.database.insert(schema.insightCards).values([
      {
        ...card,
        id: "card-1",
        position: 1,
        figure: 0.1 + 0.2,
        picture: { kind: "bars", values: [1.5, -2, null], nested: { a: "b" } },
      },
      { ...card, id: "card-2", position: 2, figure: 1e-7, picture: null },
      { ...card, id: "card-4", position: 4, figure: -2, picture: { at: "x" } },
      { ...card, id: "card-5", position: 5, figure: 123_456_789.125, picture: null },
      {
        ...card,
        id: "card-3",
        position: 3,
        figure: null,
        picture: [] as unknown as Record<string, unknown>,
      },
    ]);

    for (const name of ["budgets", "insight_cards"]) {
      expect((await pagesOf(name)).flat(), name).toEqual(await drizzleRows(name));
    }
    expect(
      (await pagesOf("budgets")).flat().map((row) => (row as { pinned: unknown }).pinned),
    ).toEqual([true, false, null]);
  });

  it("knows every column kind in an exported table", async () => {
    // readExportedJson throws on a column kind it does not know, before any row is read.
    for (const entry of EXPORTED_TABLES) {
      for await (const _ of readExportedJson(test.database, entry)) {
        // Every table is empty here.
      }
    }
  });
});
