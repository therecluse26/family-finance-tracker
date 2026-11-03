import { eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import { masterKeyChecks, members } from "./schema.ts";

// The last check of a pasted Master key. It never holds the key.

const LAST = 1;

export type MasterKeyCheck = {
  // Null once the Member who checked is removed.
  memberName: string | null;
  at: Date;
  matched: boolean;
};

export async function recordMasterKeyCheck(
  database: Database,
  check: { memberId: string; at: Date; matched: boolean },
): Promise<void> {
  const row = { id: LAST, ...check };
  await database
    .insert(masterKeyChecks)
    .values(row)
    .onConflictDoUpdate({ target: masterKeyChecks.id, set: row });
}

export async function readLastMasterKeyCheck(
  database: Database,
): Promise<MasterKeyCheck | undefined> {
  const [row] = await database
    .select({
      memberName: members.name,
      at: masterKeyChecks.at,
      matched: masterKeyChecks.matched,
    })
    .from(masterKeyChecks)
    .leftJoin(members, eq(members.id, masterKeyChecks.memberId))
    .where(eq(masterKeyChecks.id, LAST));
  return row;
}
