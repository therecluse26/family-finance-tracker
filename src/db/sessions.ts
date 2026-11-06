import { and, desc, eq, gt } from "drizzle-orm";
import type { Database } from "./client.ts";
import { sessions } from "./schema.ts";

// A Member's signed-in devices (spec 09, Signed-in devices): their sessions that have not expired.
// Better Auth makes and renews each session; these read and end them. No token leaves this file.

export type OpenSession = { id: string; userAgent: string | null; createdAt: Date };

// The Member's sessions that have not expired at `at`, newest first.
export async function listOpenSessions(
  database: Database,
  memberId: string,
  at: Date,
): Promise<OpenSession[]> {
  return database
    .select({ id: sessions.id, userAgent: sessions.userAgent, createdAt: sessions.createdAt })
    .from(sessions)
    .where(and(eq(sessions.userId, memberId), gt(sessions.expiresAt, at)))
    .orderBy(desc(sessions.createdAt), desc(sessions.id));
}

// "Sign out" on another device: ends the one session with this ID, only when it is the Member's
// own and has not expired at `at`. False, with nothing changed, otherwise.
export async function endOpenSession(
  database: Database,
  memberId: string,
  id: string,
  at: Date,
): Promise<boolean> {
  const ended = await database
    .delete(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userId, memberId), gt(sessions.expiresAt, at)))
    .returning({ id: sessions.id });
  return ended.length > 0;
}
