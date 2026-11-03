import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema.ts";
import { FIRST_MIGRATION, type FixtureMigration, writeMigrationsFolder } from "./testing.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS_FOLDER = join(ROOT, "drizzle");

type JournalEntry = { idx: number; when: number; tag: string };

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function journalEntries(folder: string): JournalEntry[] {
  return readJson(join(folder, "meta", "_journal.json")).entries;
}

// Drizzle's migrator applies only migrations newer than the newest one applied, so each entry must
// be later than the one before it. Parallel branches that each add a migration break this.
function journalProblems(folder: string): string[] {
  const entries = journalEntries(folder);
  const problems = entries.flatMap((entry, position) => {
    const found: string[] = [];
    const number = String(position).padStart(4, "0");
    if (entry.idx !== position || !entry.tag.startsWith(`${number}_`)) {
      found.push(`${entry.tag} is entry ${position}, so its idx and tag must start with ${number}`);
    }
    const before = entries[position - 1];
    if (before !== undefined && entry.when <= before.when) {
      found.push(
        `${entry.tag} must be later than ${before.tag}. Regenerate it with pnpm db:generate`,
      );
    }
    return found;
  });
  const listed = new Set(entries.map((entry) => `${entry.tag}.sql`));
  for (const file of readdirSync(folder).filter((name) => name.endsWith(".sql"))) {
    if (!listed.has(file)) problems.push(`${file} is not in meta/_journal.json`);
  }
  return problems;
}

describe("the schema and its migrations", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fft-journal-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function migration(tag: string, when: number): FixtureMigration {
    return { tag, when, sql: FIRST_MIGRATION.sql };
  }

  it("drizzle/ is up to date with the schema, so `pnpm db:generate` has nothing to add", async () => {
    const last = journalEntries(MIGRATIONS_FOLDER).at(-1);
    const committed =
      last === undefined
        ? await generateSQLiteDrizzleJson({})
        : readJson(
            join(MIGRATIONS_FOLDER, "meta", `${String(last.idx).padStart(4, "0")}_snapshot.json`),
          );

    const current = await generateSQLiteDrizzleJson(schema);

    expect(readJson(join(MIGRATIONS_FOLDER, "meta", "_journal.json")).dialect).toBe("sqlite");
    expect(await generateSQLiteMigration(committed, current)).toEqual([]);
  });

  it("flags a journal whose order and times disagree, or that misses a SQL file", () => {
    const folder = writeMigrationsFolder(dir, [
      migration("0000_a", 300),
      migration("0001_b", 200),
      migration("0003_c", 400),
      migration("0003_d", 400),
    ]);
    writeFileSync(join(folder, "0004_orphan.sql"), FIRST_MIGRATION.sql);

    expect(journalProblems(folder)).toEqual([
      "0001_b must be later than 0000_a. Regenerate it with pnpm db:generate",
      "0003_c is entry 2, so its idx and tag must start with 0002",
      "0003_d must be later than 0003_c. Regenerate it with pnpm db:generate",
      "0004_orphan.sql is not in meta/_journal.json",
    ]);
  });

  it("drizzle/ lists its migrations in order, each later than the one before", () => {
    expect(journalProblems(MIGRATIONS_FOLDER)).toEqual([]);
  });

  it("no package script runs drizzle-kit push", () => {
    const scripts: Record<string, string> = readJson(join(ROOT, "package.json")).scripts;

    expect(Object.values(scripts).some((script) => /drizzle-kit\s+push/.test(script))).toBe(false);
  });
});
