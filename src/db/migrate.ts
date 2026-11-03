import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { type MigrationMeta, readMigrationFiles } from "drizzle-orm/migrator";
import type { Database } from "./client.ts";

const MIGRATIONS_TABLE = "__drizzle_migrations";

export type AppliedMigration = { hash: string; createdAt: number };

// How the migrations in app.db compare with the ones a migrations folder ships.
export type MigrationCheck = {
  // Migrations app.db holds.
  applied: number;
  // Shipped migrations that the migrator will apply.
  pending: number;
  // Migrations app.db holds that the folder does not ship. A newer version wrote them.
  newer: number;
  // Shipped migrations app.db lacks that are older than the newest one it holds. Drizzle's
  // migrator applies only migrations newer than that one, so it would skip these.
  skipped: number;
};

export class NewerDatabaseError extends Error {
  override name = "NewerDatabaseError";
}

export class SkippedMigrationError extends Error {
  override name = "SkippedMigrationError";
}

export async function appliedMigrations(database: Database): Promise<AppliedMigration[]> {
  const tables = await database.all(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${MIGRATIONS_TABLE}`,
  );
  if (tables.length === 0) return [];
  const rows = await database.all<{ hash: string; created_at: number }>(
    sql`SELECT hash, created_at FROM ${sql.identifier(MIGRATIONS_TABLE)} ORDER BY created_at, id`,
  );
  return rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }));
}

function same(shipped: MigrationMeta, applied: AppliedMigration): boolean {
  return shipped.hash === applied.hash && shipped.folderMillis === applied.createdAt;
}

export async function checkMigrations(
  database: Database,
  migrationsFolder: string,
): Promise<MigrationCheck> {
  const shipped = readMigrationFiles({ migrationsFolder });
  const applied = await appliedMigrations(database);
  const newest = applied.at(-1)?.createdAt ?? Number.NEGATIVE_INFINITY;
  const missing = shipped.filter((m) => !applied.some((a) => same(m, a)));
  return {
    applied: applied.length,
    pending: missing.filter((m) => m.folderMillis > newest).length,
    newer: applied.filter((a) => !shipped.some((m) => same(m, a))).length,
    skipped: missing.filter((m) => m.folderMillis <= newest).length,
  };
}

function migrations(count: number): string {
  return count === 1 ? "a migration" : `${count} migrations`;
}

// Applies the pending migrations in `migrationsFolder` and returns how many it applied. It leaves
// app.db unchanged and throws when a newer version wrote app.db, or when it would skip a migration.
export async function applyMigrations(
  database: Database,
  migrationsFolder: string,
): Promise<number> {
  const check = await checkMigrations(database, migrationsFolder);
  if (check.newer > 0) {
    throw new NewerDatabaseError(
      `app.db holds ${migrations(check.newer)} that this version of the app does not have, so a ` +
        "newer version wrote it. Run the newer version, or restore a backup from this version.",
    );
  }
  if (check.skipped > 0) {
    throw new SkippedMigrationError(
      `app.db lacks ${migrations(check.skipped)} that this version ships, but holds a later one, ` +
        `so the migrator would skip ${check.skipped === 1 ? "it" : "them"}. This version's ` +
        "migrations are out of order. app.db is unchanged.",
    );
  }
  await migrate(database, { migrationsFolder, migrationsTable: MIGRATIONS_TABLE });
  return check.pending;
}
