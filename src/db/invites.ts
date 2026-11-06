import { and, asc, eq, gt, lte } from "drizzle-orm";
import type { Database } from "./client.ts";
import { invites, members } from "./schema.ts";

// Invite links in app.db (spec 09, Invites). The auth module makes and checks each token; these
// functions store and read only its hash.

export type NewInvite = {
  id: string;
  tokenHash: string;
  madeBy: string;
  at: Date;
  expiresAt: Date;
};

// An open invite link as Settings list it: who made it, when, and when it stops working.
export type OpenInvite = { id: string; madeBy: string; createdAt: Date; expiresAt: Date };

// Stores a new invite link, and deletes the links that have expired.
export async function addInvite(database: Database, invite: NewInvite): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.delete(invites).where(lte(invites.expiresAt, invite.at));
    await tx.insert(invites).values({
      id: invite.id,
      tokenHash: invite.tokenHash,
      madeBy: invite.madeBy,
      createdAt: invite.at,
      expiresAt: invite.expiresAt,
    });
  });
}

// The links that still work at `now`, oldest first, with the name of the Member who made each.
export async function listOpenInvites(database: Database, now: Date): Promise<OpenInvite[]> {
  return database
    .select({
      id: invites.id,
      madeBy: members.name,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
    })
    .from(invites)
    .innerJoin(members, eq(members.id, invites.madeBy))
    .where(gt(invites.expiresAt, now))
    .orderBy(asc(invites.createdAt), asc(invites.id));
}

// Each link that still works at `now`, with its token's hash, for the auth module's check.
export async function listOpenInviteHashes(
  database: Database,
  now: Date,
): Promise<{ id: string; tokenHash: string }[]> {
  return database
    .select({ id: invites.id, tokenHash: invites.tokenHash })
    .from(invites)
    .where(gt(invites.expiresAt, now));
}

// Deletes one link that still works at `now`, in one statement. True only for the one request that
// deleted it.
async function deleteOpenInvite(database: Database, id: string, now: Date): Promise<boolean> {
  const deleted = await database
    .delete(invites)
    .where(and(eq(invites.id, id), gt(invites.expiresAt, now)))
    .returning({ id: invites.id });
  return deleted.length === 1;
}

// Cancel. False, with nothing changed, when no open link has the ID.
export const cancelInvite = deleteOpenInvite;

// Uses up one link as a new Member joins: of two requests at once, only one gets true, so a link
// works once.
export const claimInvite = deleteOpenInvite;
