import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { deleteRemovedConnection, listTransactions, markConnectionRemoved } from "./index.ts";
import { merchantMatch, merchantTerms } from "./merchant-search.ts";

// Merchant search (spec 07, Transactions page): the terms a Member types, and the FTS5 index the
// triggers in migration 0072 keep in step with transactions.

const BANK = "ins_merchant_search";
const at = (moment: string) => () => new Date(moment);

describe("reading a Member's Merchant search", () => {
  it("reads words, quoted phrases, and words that match inside a word", () => {
    expect(merchantTerms("  corner   bist ")).toEqual({
      words: ["corner", "bist"],
      phrases: [],
      inside: [],
    });
    expect(merchantTerms('"Corner Bistro" *istro bist* ** %')).toEqual({
      words: ["bist"],
      phrases: ["Corner Bistro"],
      inside: ["istro", "%"],
    });
    // A quote with no end runs to the end; an empty one is nothing.
    expect(merchantTerms('shell "" "corner bis')).toEqual({
      words: ["shell"],
      phrases: ["corner bis"],
      inside: [],
    });
    expect(merchantTerms('"%" _')).toEqual({ words: [], phrases: [], inside: ["%", "_"] });
    expect(merchantTerms("")).toEqual({ words: [], phrases: [], inside: [] });
  });

  it("writes every term in quotes, so no text reads as FTS5 syntax", () => {
    expect(merchantMatch(merchantTerms('corner "shell shack" a"b'))).toBe(
      '"corner"* AND "a""b"* AND "shell shack"',
    );
    expect(merchantMatch(merchantTerms("NEAR(corner OR NOT -x ^y name:z"))).toBe(
      '"NEAR(corner"* AND "OR"* AND "NOT"* AND "-x"* AND "^y"* AND "name:z"*',
    );
    expect(merchantMatch(merchantTerms("*istro %"))).toBeUndefined();
  });
});

describe("the Merchant search index", () => {
  let bank: TestBank;
  let connectionId: string;
  const card = fakeAccount({ id: "acc-card", type: "credit", subtype: "credit card" });
  const NAMES = ["CAFÉ ÉCLAIR", "Corner Bistro", "Shellfish Shack", "Shell", "50% OFF OUTLET"];

  beforeEach(async () => {
    bank = await newTestBank();
    connectionId = await bank.connect(BANK, "First Fake Bank");
    bank.fake.addPages(BANK, {
      accounts: [card],
      added: NAMES.map((name, n) =>
        fakeTxn({
          id: `txn-${n}`,
          accountId: card.id,
          amount: -1_000 - n,
          postedDate: `2026-10-0${n + 1}`,
          description: name.toUpperCase(),
          merchantName: name,
        }),
      ),
      historyLoaded: true,
    });
    await syncConnection(connectionId, at("2026-10-10T12:00:00.000Z"));
  });

  afterEach(() => {
    bank.close();
  });

  const found = async (merchant: string) =>
    (await listTransactions(bank.database, { merchant }))
      .map((txn) => txn.merchantCleanName ?? txn.merchantName)
      .sort();
  const rowsIn = async (table: string) =>
    Number((await bank.database.$client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);

  it("finds word starts in any case and with or without accents, exact words in quotes, and text inside a word after *", async () => {
    expect(await found("cafe")).toEqual(["CAFÉ ÉCLAIR"]);
    expect(await found("ÉCL")).toEqual(["CAFÉ ÉCLAIR"]);
    expect(await found("shell")).toEqual(["Shell", "Shellfish Shack"]);
    expect(await found('"shell"')).toEqual(["Shell"]);
    expect(await found('"shellfish shack"')).toEqual(["Shellfish Shack"]);
    expect(await found('"shack shellfish"')).toEqual([]);
    expect(await found("bistro corner")).toEqual(["Corner Bistro"]);
    expect(await found("bistro shack")).toEqual([]);
    expect(await found("istro")).toEqual([]);
    expect(await found("*istro")).toEqual(["Corner Bistro"]);
    expect(await found("*FISH sha")).toEqual(["Shellfish Shack"]);
    expect(await found("%")).toEqual(["50% OFF OUTLET"]);
    expect(await found("_")).toEqual([]);
    // FTS5 syntax in a Member's text is only text.
    for (const text of ['"', "NEAR(", "OR", "NOT shell", "-shell", "^shell", "name:shell", "*"]) {
      await expect(found(text), text).resolves.toBeInstanceOf(Array);
    }
    expect(await found("  ")).toHaveLength(NAMES.length);
  });

  it("follows a changed Merchant name, and drops a deleted Transaction's entry and key", async () => {
    await bank.database.$client.execute(
      "UPDATE transactions SET merchant_clean_name = 'Bluebird Books' WHERE merchant_name = 'Shell'",
    );
    expect(await found("bluebird")).toEqual(["Bluebird Books"]);
    expect(await found('"shell"')).toEqual([]);
    expect(await rowsIn("transaction_search")).toBe(NAMES.length);
    expect(await rowsIn("transaction_search_keys")).toBe(NAMES.length);

    await markConnectionRemoved(bank.database, connectionId, new Date("2026-10-11T12:00:00.000Z"));
    expect(
      await deleteRemovedConnection(
        bank.database,
        connectionId,
        new Date("2026-10-11T12:00:00.000Z"),
      ),
    ).toBeDefined();

    expect(await rowsIn("transactions")).toBe(0);
    expect(await rowsIn("transaction_search")).toBe(0);
    expect(await rowsIn("transaction_search_keys")).toBe(0);
  });

  it("keeps its triggers on transactions, which a migration that rebuilds the table would drop", async () => {
    const triggers = await bank.database.$client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'transactions' ORDER BY name",
    );

    expect(triggers.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "transaction_search_delete",
        "transaction_search_insert",
        "transaction_search_update",
      ]),
    );
  });

  it("indexes the Transactions already stored when the migration runs", async () => {
    const statements = readFileSync(
      new URL("../../drizzle/0072_merchant_search.sql", import.meta.url),
      "utf8",
    )
      .split("--> statement-breakpoint")
      .map((statement) => statement.replace(/^--.*$/gm, "").trim())
      .filter((statement) => statement.startsWith("INSERT INTO"));
    expect(statements).toHaveLength(2);
    await bank.database.$client.execute("DELETE FROM transaction_search");
    await bank.database.$client.execute("DELETE FROM transaction_search_keys");
    expect(await found("bistro")).toEqual([]);

    for (const statement of statements) await bank.database.$client.execute(statement);

    expect(await found("bistro")).toEqual(["Corner Bistro"]);
    expect(await rowsIn("transaction_search")).toBe(NAMES.length);
  });
});
