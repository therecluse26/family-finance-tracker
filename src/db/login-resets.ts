import { and, eq, gt, lte, or } from "drizzle-orm";
import type { Database } from "./client.ts";
import { accounts, loginResets, members, passkeys, sessions, twoFactors } from "./schema.ts";

// Reset links in app.db (spec 09, Login reset). The auth module makes and checks each token; these
// functions store and read only its hash, and change a Member's login rows in the same
// transaction as the link.

export type NewLoginReset = {
  id: string;
  memberId: string;
  tokenHash: string;
  at: Date;
  expiresAt: Date;
};

// The Member's ID for an email address, in any letter case. Better Auth stores it in lowercase.
export async function findMemberIdByEmail(
  database: Database,
  email: string,
): Promise<string | undefined> {
  const [found] = await database
    .select({ id: members.id })
    .from(members)
    .where(eq(members.email, email.trim().toLowerCase()));
  return found?.id;
}

// Makes a reset, in one transaction: ends every session of the Member, deletes their password,
// TOTP, backup codes and passkeys, and stores the new link's hash in place of their earlier link. It also
// deletes the links that have expired. False, with nothing changed, when no Member has the ID.
export async function startLoginReset(database: Database, reset: NewLoginReset): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [member] = await tx
      .select({ id: members.id })
      .from(members)
      .where(eq(members.id, reset.memberId));
    if (member === undefined) return false;
    await tx.delete(sessions).where(eq(sessions.userId, reset.memberId));
    await tx.delete(accounts).where(eq(accounts.userId, reset.memberId));
    await tx.delete(twoFactors).where(eq(twoFactors.userId, reset.memberId));
    await tx.delete(passkeys).where(eq(passkeys.userId, reset.memberId));
    await tx
      .delete(loginResets)
      .where(or(eq(loginResets.memberId, reset.memberId), lte(loginResets.expiresAt, reset.at)));
    await tx.insert(loginResets).values({
      id: reset.id,
      memberId: reset.memberId,
      tokenHash: reset.tokenHash,
      createdAt: reset.at,
      expiresAt: reset.expiresAt,
    });
    return true;
  });
}

// Each link that still works at `now`, with its token's hash and the email address of its Member,
// for the auth module's check.
export async function listOpenLoginResetHashes(
  database: Database,
  now: Date,
): Promise<{ id: string; memberId: string; email: string; tokenHash: string }[]> {
  return database
    .select({
      id: loginResets.id,
      memberId: loginResets.memberId,
      email: members.email,
      tokenHash: loginResets.tokenHash,
    })
    .from(loginResets)
    .innerJoin(members, eq(members.id, loginResets.memberId))
    .where(gt(loginResets.expiresAt, now));
}

// The new login the reset page sets. The password is a hash, and the TOTP secret and backup codes
// are already encrypted for their row.
export type FinishedLoginReset = {
  resetId: string;
  memberId: string;
  at: Date;
  account: { id: string; password: string };
  twoFactor: { id: string; secret: string; backupCodes: string; lastTotpStep: number };
};

// Uses up a link and sets the Member's new password, TOTP and backup codes, in one transaction. Of
// two requests at once with one link, only one gets true. False, with nothing changed, when the
// link is used, replaced, or expired. Any session or passkey made since the reset ends.
export async function finishLoginReset(
  database: Database,
  finish: FinishedLoginReset,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const used = await tx
      .delete(loginResets)
      .where(and(eq(loginResets.id, finish.resetId), gt(loginResets.expiresAt, finish.at)))
      .returning({ id: loginResets.id });
    if (used.length !== 1) return false;
    await tx.delete(sessions).where(eq(sessions.userId, finish.memberId));
    await tx.delete(accounts).where(eq(accounts.userId, finish.memberId));
    await tx.delete(twoFactors).where(eq(twoFactors.userId, finish.memberId));
    await tx.delete(passkeys).where(eq(passkeys.userId, finish.memberId));
    await tx.insert(accounts).values({
      id: finish.account.id,
      accountId: finish.memberId,
      providerId: "credential",
      userId: finish.memberId,
      password: finish.account.password,
      createdAt: finish.at,
      updatedAt: finish.at,
    });
    await tx.insert(twoFactors).values({
      id: finish.twoFactor.id,
      userId: finish.memberId,
      secret: finish.twoFactor.secret,
      backupCodes: finish.twoFactor.backupCodes,
      verified: true,
      lastTotpStep: finish.twoFactor.lastTotpStep,
    });
    return true;
  });
}
