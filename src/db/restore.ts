import { asc, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import type { StoredDataKey } from "./data-keys.ts";
import {
  aiSettings,
  connections,
  dataKeys,
  dealFinderSettings,
  masterKeyChecks,
  noticeDeliveries,
  plaidSettings,
  pushDevices,
  sessions,
  smtpSettings,
  systemNotices,
  twoFactors,
  vapidKeys,
  verifications,
} from "./schema.ts";

// A restore without the Master key in app.db (spec 11, Without the Master key). `fft restore`
// decides; these functions read and write the backup's copy before it is put in place.

// The secrets a backup holds that a restore without its Master key loses.
export type RestoreLosses = {
  plaidSecret: boolean;
  // The AI key or the gateway token.
  aiKey: boolean;
  smtpPassword: boolean;
  // The Apify token or the Kroger keys.
  priceSourceKeys: boolean;
  // The bank name of each Connection that is not removed, which must be linked again.
  banks: string[];
  // The devices Alerts are on for.
  pushDevices: number;
};

export async function readRestoreLosses(database: Database): Promise<RestoreLosses> {
  const [plaid] = await database
    .select({ id: plaidSettings.id })
    .from(plaidSettings)
    .where(isNotNull(plaidSettings.secret));
  const [ai] = await database
    .select({ id: aiSettings.id })
    .from(aiSettings)
    .where(or(isNotNull(aiSettings.apiKey), isNotNull(aiSettings.gatewayToken)));
  const [smtp] = await database.select({ id: smtpSettings.id }).from(smtpSettings);
  const [priceSources] = await database
    .select({ id: dealFinderSettings.id })
    .from(dealFinderSettings)
    .where(
      or(
        isNotNull(dealFinderSettings.apifyToken),
        isNotNull(dealFinderSettings.krogerClientId),
        isNotNull(dealFinderSettings.krogerClientSecret),
      ),
    );
  const banks = await database
    .select({ bankName: connections.bankName })
    .from(connections)
    .where(isNull(connections.removedAt))
    .orderBy(asc(connections.bankName), asc(connections.id));
  const [devices] = await database.select({ count: sql<number>`count(*)` }).from(pushDevices);
  return {
    plaidSecret: plaid !== undefined,
    aiKey: ai !== undefined,
    smtpPassword: smtp !== undefined,
    priceSourceKeys: priceSources !== undefined,
    banks: banks.map((row) => row.bankName),
    pushDevices: Number(devices?.count ?? 0),
  };
}

// In one transaction: deletes every value the backup's data key encrypted, which the current
// Master key cannot read, and stores a new data key in its place.
// - Each Connection loses its credential. One that is not removed becomes Broken, so its Repair
//   offers only Link again, and it never polls. One whose history had not loaded stops holding back
//   AI, as any Broken Connection does (spec 02, First history load).
// - The Plaid secret, the AI key and gateway token, and the SMTP settings, whose password is
//   required, are deleted. The Plaid Items used stay counted.
// - The Apify token and the Kroger keys are deleted, with their last 4 characters and Tests.
// - The VAPID keys and every web push device are deleted. The app makes new keys at start.
// - Every session, TOTP secret and backup code, and pending login value ends: the login signing
//   secret comes from the Master key, so none of them would work. A reset link still works, and
//   sets a new login.
// - The last Master key check was of the old key, so it is deleted.
// - One System notice tells every Member what to set up again.
export async function forgetUnreadableSecrets(
  database: Database,
  restore: { at: Date; dataKey: StoredDataKey; noticeText: string },
): Promise<void> {
  const { at } = restore;
  await database.transaction(async (tx) => {
    await tx.delete(dataKeys);
    await tx.insert(dataKeys).values(restore.dataKey);
    await tx.update(connections).set({ credential: null });
    await tx
      .update(connections)
      .set({
        health: "broken",
        nextSyncAt: null,
        retryingSince: null,
        failedSyncs: 0,
        historyWaitReleasedAt: sql`CASE WHEN ${connections.historyLoaded} = 0 THEN coalesce(${connections.historyWaitReleasedAt}, ${at.toISOString()}) ELSE ${connections.historyWaitReleasedAt} END`,
      })
      .where(isNull(connections.removedAt));
    await tx.update(plaidSettings).set({ secret: null });
    await tx.update(aiSettings).set({ apiKey: null, gatewayToken: null, keyRejectedAt: null });
    await tx.delete(smtpSettings);
    await tx.update(dealFinderSettings).set({
      apifyToken: null,
      apifyTokenLast4: null,
      apifyCheck: null,
      apifyCheckedAt: null,
      krogerClientId: null,
      krogerClientIdLast4: null,
      krogerClientSecret: null,
      krogerClientSecretLast4: null,
      krogerCheck: null,
      krogerCheckedAt: null,
    });
    // Deleting a device deletes the pushes that wait for it.
    await tx.delete(pushDevices);
    await tx.delete(vapidKeys);
    await tx.delete(sessions);
    await tx.delete(twoFactors);
    await tx.delete(verifications);
    await tx.delete(masterKeyChecks);
    const id = crypto.randomUUID();
    await tx
      .insert(systemNotices)
      .values({ id, kind: "event", text: restore.noticeText, condition: null, raisedAt: at });
    await tx.insert(noticeDeliveries).values({ noticeId: id, createdAt: at });
  });
}
