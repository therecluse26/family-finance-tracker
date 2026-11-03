import { getTableName, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { dataKeys } from "./schema.ts";

// A data key as app.db stores it, encrypted with the Master key.
export type StoredDataKey = { id: string; encryptedKey: string };

// Before the first start's migrations, app.db has no table for data keys, so it holds none.
export async function readDataKeys(database: Database): Promise<StoredDataKey[]> {
  const tables = await database.all(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${getTableName(dataKeys)}`,
  );
  if (tables.length === 0) return [];
  return database.select({ id: dataKeys.id, encryptedKey: dataKeys.encryptedKey }).from(dataKeys);
}

export async function storeDataKey(database: Database, key: StoredDataKey): Promise<void> {
  await database.insert(dataKeys).values(key);
}
