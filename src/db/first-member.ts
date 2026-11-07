import { eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import { accounts, members, sessions, twoFactors, verifications } from "./schema.ts";

// The first Member's login rows (spec 12, The first-run wizard), which the auth module makes. They
// are written in one transaction, so a failure partway leaves no half-made Member, and the setup
// code still works for the next try.

export type FirstMemberRows = {
  at: Date;
  member: { id: string; name: string; email: string };
  account: { id: string; password: string };
  // The TOTP secret and backup codes, already sealed to this row, and the time step of the code
  // that made the Member, so that code cannot sign them in again.
  twoFactor: { id: string; secret: string; backupCodes: string; lastTotpStep: number };
  // The identifier of the TOTP secret that waited for the first Member, which is used up.
  pendingTotp: string;
  session: {
    id: string;
    token: string;
    expiresAt: Date;
    ipAddress: string;
    userAgent: string;
  };
};

// Makes the first Member, with their password, TOTP and backup codes, and their first session, and
// uses up the TOTP secret that waited for them, all in one transaction, or none of it.
export async function makeFirstMember(database: Database, rows: FirstMemberRows): Promise<void> {
  const { at, member } = rows;
  await database.transaction(async (tx) => {
    await tx.insert(members).values({
      id: member.id,
      name: member.name,
      email: member.email,
      emailVerified: false,
      twoFactorEnabled: true,
      createdAt: at,
      updatedAt: at,
    });
    await tx.insert(accounts).values({
      id: rows.account.id,
      accountId: member.id,
      providerId: "credential",
      userId: member.id,
      password: rows.account.password,
      createdAt: at,
      updatedAt: at,
    });
    await tx.insert(twoFactors).values({
      id: rows.twoFactor.id,
      userId: member.id,
      secret: rows.twoFactor.secret,
      backupCodes: rows.twoFactor.backupCodes,
      verified: true,
      lastTotpStep: rows.twoFactor.lastTotpStep,
    });
    await tx.delete(verifications).where(eq(verifications.identifier, rows.pendingTotp));
    await tx.insert(sessions).values({
      ...rows.session,
      userId: member.id,
      createdAt: at,
      updatedAt: at,
    });
  });
}
