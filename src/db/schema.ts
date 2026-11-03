// The only source of app.db's shape. After a change here, `pnpm db:generate` writes its migration.
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// The data key that encrypts every Master-key secret (spec 09, Encryption at rest). v1 stores one.
export const dataKeys = sqliteTable("data_keys", {
  // The key ID that starts each ciphertext the data key makes.
  id: text("id").primaryKey(),
  // The data key, encrypted with the Master key by the secrets module.
  encryptedKey: text("encrypted_key").notNull(),
});
