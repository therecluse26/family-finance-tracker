import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAiSettings, removeAiSettings } from "./ai-settings.ts";
import { closeDatabase, type Database, openDatabase } from "./client.ts";
import { applyMigrations } from "./migrate.ts";
import { appMigrations, writeMigrationsFolder } from "./testing.ts";

// Migration 0074 gives ai_settings a Chat model (spec 08, Model tiers). It stays empty in a row
// saved before, and an empty Chat model reads as the Writer model, so a Household's Chat keeps the
// model it ran before until a Member saves the AI settings page.

describe("the Chat model column", () => {
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

  const rows = async () =>
    (
      await database.$client.execute(
        "SELECT provider, quick_model, writer_model, chat_model, generation FROM ai_settings",
      )
    ).rows.map((r) => ({ ...r }));

  const storeOld = () =>
    database.$client.execute(
      "INSERT INTO ai_settings (id, provider, quick_model, writer_model, generation) " +
        "VALUES (1, 'anthropic', 'quick-model', 'writer-model', 3)",
    );

  it("finds the migration after main's last one", () => {
    expect(chatMigration).toBeGreaterThan(0);
  });

  it("leaves a stored row's Chat model empty, and reads it as the Writer model", async () => {
    await storeOld();
    await migrate();

    expect(await rows()).toEqual([
      {
        provider: "anthropic",
        quick_model: "quick-model",
        writer_model: "writer-model",
        chat_model: null,
        generation: 3,
      },
    ]);
    expect(await readAiSettings(database)).toMatchObject({
      writerModel: "writer-model",
      chatModel: "writer-model",
    });
  });

  it("reads a stored Chat model over the Writer model", async () => {
    await storeOld();
    await migrate();
    await database.$client.execute("UPDATE ai_settings SET chat_model = 'chat-model'");

    expect(await readAiSettings(database)).toMatchObject({
      writerModel: "writer-model",
      chatModel: "chat-model",
    });
  });

  it("keeps a row with no AI provider empty, and Remove AI provider empties the Chat model", async () => {
    await database.$client.execute("INSERT INTO ai_settings (id, generation) VALUES (1, 2)");
    await migrate();
    expect(await rows()).toEqual([
      { provider: null, quick_model: null, writer_model: null, chat_model: null, generation: 2 },
    ]);
    expect(await readAiSettings(database)).toBeUndefined();

    await database.$client.execute(
      "UPDATE ai_settings SET provider = 'anthropic', quick_model = 'q', writer_model = 'w', " +
        "chat_model = 'c'",
    );
    await removeAiSettings(database);
    expect(await rows()).toMatchObject([{ provider: null, chat_model: null }]);
  });
});
