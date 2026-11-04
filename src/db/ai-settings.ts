import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { aiSettings } from "./schema.ts";

// The Household's one AI provider in app.db (spec 08, AI settings page). The ai module decides and
// encrypts; these functions store and read.

// The ID of ai_settings' one row. The API key's and the gateway token's ciphertexts are bound to
// it.
export const AI_SETTINGS_ROW = 1;

export type StoredAiSettings = {
  provider: "anthropic" | "openai" | "openrouter" | "openai-compatible";
  // The API key's ciphertext, as the secrets module made it.
  apiKey: string | null;
  baseUrl: string | null;
  // The gateway token's ciphertext.
  gatewayToken: string | null;
  quickModel: string;
  writerModel: string;
  keyRejectedAt: Date | null;
};

// The settings, or undefined with no AI provider, and the row's generation: 0 with no row.
export type AiSettingsVersion = {
  settings: StoredAiSettings | undefined;
  generation: number;
};

export async function readAiSettingsVersion(database: Database): Promise<AiSettingsVersion> {
  const [row] = await database.select().from(aiSettings).where(eq(aiSettings.id, AI_SETTINGS_ROW));
  if (row === undefined) return { settings: undefined, generation: 0 };
  const { id: _id, generation, provider, quickModel, writerModel, ...rest } = row;
  if (provider === null || quickModel === null || writerModel === null) {
    return { settings: undefined, generation };
  }
  return { settings: { provider, quickModel, writerModel, ...rest }, generation };
}

export async function readAiSettings(database: Database): Promise<StoredAiSettings | undefined> {
  return (await readAiSettingsVersion(database)).settings;
}

// Replaces the whole row, so the Household has one AI provider at a time, but only while the row
// is still at `generation`. False when a save or a Remove AI provider changed it first.
export async function storeAiSettings(
  database: Database,
  settings: StoredAiSettings,
  generation: number,
): Promise<boolean> {
  const next = { ...settings, generation: generation + 1 };
  const result =
    generation === 0
      ? await database
          .insert(aiSettings)
          .values({ id: AI_SETTINGS_ROW, ...next })
          .onConflictDoNothing()
      : await database
          .update(aiSettings)
          .set(next)
          .where(and(eq(aiSettings.id, AI_SETTINGS_ROW), eq(aiSettings.generation, generation)));
  return result.rowsAffected === 1;
}

const EMPTY = {
  provider: null,
  apiKey: null,
  baseUrl: null,
  gatewayToken: null,
  quickModel: null,
  writerModel: null,
  keyRejectedAt: null,
};

// Removes the AI provider, with its API key and gateway token. The row stays, one generation on,
// so a save that started before this never writes the settings back.
export async function removeAiSettings(database: Database): Promise<void> {
  await database
    .insert(aiSettings)
    .values({ id: AI_SETTINGS_ROW, ...EMPTY, generation: 1 })
    .onConflictDoUpdate({
      target: aiSettings.id,
      set: { ...EMPTY, generation: sql`${aiSettings.generation} + 1` },
    });
}
