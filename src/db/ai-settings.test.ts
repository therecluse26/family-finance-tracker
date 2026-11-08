import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database, openDatabase } from "./client.ts";
import { applyMigrations } from "./migrate.ts";
import { appMigrations, writeMigrationsFolder } from "./testing.ts";

// Migration 0074 gives ai_settings a Chat model (spec 08, Model tiers). A Household's Chat keeps
// the model it ran before: its Writer model.

describe("the Chat model migration", () => {
  let dir: string;
  let database: Database;
  const migrations = appMigrations();
  const chatMigration = migrations.findIndex(({ tag }) => tag.endsWith("_chat_model"));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "fft-chat-model-"));
    database = await openDatabase(`file:${join(dir, "app.db")}`);
    const before = writeMigrationsFolder(join(dir, "before"), migrations.slice(0, chatMigration));
    await applyMigrations(database, before);
  });

  afterEach(() => {
    closeDatabase(database);
    rmSync(dir, { recursive: true, force: true });
  });

  const migrate = () =>
    applyMigrations(database, writeMigrationsFolder(join(dir, "after"), migrations));

  const row = async () =>
    (
      await database.$client.execute(
        "SELECT provider, quick_model, writer_model, chat_model, generation FROM ai_settings",
      )
    ).rows.map((r) => ({ ...r }));

  it("finds the migration after main's last one", () => {
    expect(chatMigration).toBeGreaterThan(0);
  });

  it("copies a stored Writer model into the Chat model", async () => {
    await database.$client.execute(
      "INSERT INTO ai_settings (id, provider, quick_model, writer_model, generation) " +
        "VALUES (1, 'anthropic', 'quick-model', 'writer-model', 3)",
    );
    await migrate();
    expect(await row()).toEqual([
      {
        provider: "anthropic",
        quick_model: "quick-model",
        writer_model: "writer-model",
        chat_model: "writer-model",
        generation: 3,
      },
    ]);
  });

  it("keeps a row with no AI provider empty", async () => {
    await database.$client.execute("INSERT INTO ai_settings (id, generation) VALUES (1, 2)");
    await migrate();
    expect(await row()).toEqual([
      { provider: null, quick_model: null, writer_model: null, chat_model: null, generation: 2 },
    ]);
  });

  it("refuses a Chat model without an AI provider, and an AI provider without one", async () => {
    await migrate();
    await expect(
      database.$client.execute("INSERT INTO ai_settings (id, chat_model) VALUES (1, 'chat-model')"),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      database.$client.execute(
        "INSERT INTO ai_settings (id, provider, quick_model, writer_model) " +
          "VALUES (1, 'anthropic', 'quick-model', 'writer-model')",
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
