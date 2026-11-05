import { stat } from "node:fs/promises";
import { createClient } from "@libsql/client";
import type { Database } from "./client.ts";

// The two statements a backup runs on app.db and its copy (spec 11, How the app makes a backup).
// The backups module names the files and does the rest.

// Copies app.db into a new file at `path` with VACUUM INTO, while the app keeps running. The copy
// holds every committed row, the ones still in the WAL file too, and no uncommitted one. VACUUM
// INTO refuses a file that already exists.
export async function copyDatabaseInto(database: Database, path: string): Promise<void> {
  await database.$client.execute({ sql: "VACUUM INTO ?", args: [path] });
}

// Whether the copy at `path` passes SQLite's integrity check. It reads the check through its
// table-valued function, which sets nothing. A missing file fails, and is not made, and so does a
// file SQLite cannot open or read.
export async function checkDatabaseCopy(path: string): Promise<boolean> {
  let client: ReturnType<typeof createClient> | undefined;
  try {
    if (!(await stat(path)).isFile()) return false;
    client = createClient({ url: `file:${path}` });
    const result = await client.execute("SELECT * FROM pragma_integrity_check()");
    return result.rows.length === 1 && result.rows[0]?.[0] === "ok";
  } catch {
    return false;
  } finally {
    client?.close();
  }
}
