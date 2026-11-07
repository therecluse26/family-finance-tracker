import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  alertChannels,
  alertDeliveries,
  noticeDeliveries,
  pushDevices,
  pushSends,
  systemNotices,
  vapidKeys,
} from "./schema.ts";

// Web push for Alerts and System notices in app.db (spec 06, Recipients and channels; Quiet
// hours): the VAPID keys, each Member's devices, and the pushes that wait for each device. The
// notify module decides and encrypts; these functions store and read.

// The ID of vapid_keys' one row. Both keys' ciphertexts are bound to it.
export const VAPID_KEYS_ROW = 1;

// Both VAPID keys' ciphertexts, as the secrets module made them.
export type StoredVapidKeys = { publicKey: string; privateKey: string };

export async function readVapidKeys(database: Database): Promise<StoredVapidKeys | undefined> {
  const [row] = await database
    .select({ publicKey: vapidKeys.publicKey, privateKey: vapidKeys.privateKey })
    .from(vapidKeys)
    .where(eq(vapidKeys.id, VAPID_KEYS_ROW));
  return row;
}

// Stores new VAPID keys, and removes every device in the same transaction: a device turned on
// under the old keys cannot get a push signed with the new ones. Returns how many devices it
// removed.
export async function replaceVapidKeys(database: Database, keys: StoredVapidKeys): Promise<number> {
  return database.transaction(async (tx) => {
    const removed = await tx.delete(pushDevices).returning({ id: pushDevices.id });
    await tx
      .insert(vapidKeys)
      .values({ id: VAPID_KEYS_ROW, ...keys })
      .onConflictDoUpdate({ target: vapidKeys.id, set: keys });
    return removed.length;
  });
}

// A browser's push subscription.
export type PushDeviceFields = { endpoint: string; p256dh: string; auth: string };

// Turns Alerts on for a device, or takes the browser's current keys for this Member's own device.
// False, with nothing changed, when the endpoint is another Member's device: a Member never takes
// over another Member's pushes.
export async function storePushDevice(
  database: Database,
  memberId: string,
  device: PushDeviceFields,
  at: Date,
): Promise<boolean> {
  const set = { p256dh: device.p256dh, auth: device.auth, createdAt: at };
  // One statement: a known endpoint is updated only when it is this Member's own device.
  const stored = await database
    .insert(pushDevices)
    .values({ endpoint: device.endpoint, memberId, ...set })
    .onConflictDoUpdate({
      target: pushDevices.endpoint,
      set,
      setWhere: eq(pushDevices.memberId, memberId),
    })
    .returning({ id: pushDevices.id });
  return stored.length > 0;
}

// The Member whose device is at this endpoint, or undefined when no device is. One browser's push
// belongs to one Member: the endpoint is unique.
export async function readPushDeviceMember(
  database: Database,
  endpoint: string,
): Promise<string | undefined> {
  const [row] = await database
    .select({ memberId: pushDevices.memberId })
    .from(pushDevices)
    .where(eq(pushDevices.endpoint, endpoint));
  return row?.memberId;
}

// Turns Alerts off for one of this Member's devices. True when it removed one.
export async function removePushDevice(
  database: Database,
  memberId: string,
  endpoint: string,
): Promise<boolean> {
  const removed = await database
    .delete(pushDevices)
    .where(and(eq(pushDevices.memberId, memberId), eq(pushDevices.endpoint, endpoint)))
    .returning({ id: pushDevices.id });
  return removed.length > 0;
}

// Removes every device of one Member. Returns how many it removed.
export async function removeMemberPushDevices(
  database: Database,
  memberId: string,
): Promise<number> {
  const removed = await database
    .delete(pushDevices)
    .where(eq(pushDevices.memberId, memberId))
    .returning({ id: pushDevices.id });
  return removed.length;
}

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_WRITE = 1000;
const SENDS_PER_INSERT = 1000;

// Removes these devices, as when the push service reports them gone. Their waiting pushes go too.
export async function removePushDevices(database: Database, ids: readonly number[]): Promise<void> {
  for (let start = 0; start < ids.length; start += IDS_PER_WRITE) {
    await database
      .delete(pushDevices)
      .where(inArray(pushDevices.id, ids.slice(start, start + IDS_PER_WRITE)));
  }
}

// What handing out did: how many messages push was done with, and how many pushes now wait.
export type HandedOut = { messages: number; pushes: number };

// Hands out every message that push is not done with yet: one push_sends row for each device that
// gets it, and push is then done with the message, in one transaction, so running it twice hands
// out nothing twice. A device gets a message when its Member's channels hold push, and it was
// turned on by the time the message was made. A condition notice that already ended goes to no
// device. With `pushOn` false, as in plain-HTTP mode, push is done with every message and no
// device gets one.
export async function handOutPushes(
  database: Database,
  options: { pushOn: boolean; at: Date },
): Promise<HandedOut> {
  return database.transaction(async (tx) => {
    const alertsWaiting = await tx
      .select({
        alertId: alertDeliveries.alertId,
        title: alertDeliveries.title,
        text: alertDeliveries.text,
        createdAt: alertDeliveries.createdAt,
      })
      .from(alertDeliveries)
      .where(isNull(alertDeliveries.pushDoneAt));
    const noticesWaiting = await tx
      .select({
        id: noticeDeliveries.id,
        noticeId: noticeDeliveries.noticeId,
        text: systemNotices.text,
        createdAt: noticeDeliveries.createdAt,
        kind: systemNotices.kind,
        closedAt: systemNotices.closedAt,
      })
      .from(noticeDeliveries)
      .innerJoin(systemNotices, eq(systemNotices.id, noticeDeliveries.noticeId))
      .where(isNull(noticeDeliveries.pushDoneAt));
    if (alertsWaiting.length === 0 && noticesWaiting.length === 0) {
      return { messages: 0, pushes: 0 };
    }
    const devices = options.pushOn
      ? await tx
          .select({ id: pushDevices.id, createdAt: pushDevices.createdAt })
          .from(pushDevices)
          .leftJoin(alertChannels, eq(alertChannels.memberId, pushDevices.memberId))
          .where(or(isNull(alertChannels.memberId), eq(alertChannels.push, true)))
          .orderBy(asc(pushDevices.id))
      : [];
    const turnedOnBy = (made: Date) =>
      devices.filter((device) => device.createdAt.getTime() <= made.getTime());
    const rows: (typeof pushSends.$inferInsert)[] = [];
    for (const message of alertsWaiting) {
      for (const device of turnedOnBy(message.createdAt)) {
        rows.push({
          deviceId: device.id,
          alertId: message.alertId,
          title: message.title,
          body: message.text,
          createdAt: options.at,
        });
      }
    }
    for (const message of noticesWaiting) {
      if (message.kind === "condition" && message.closedAt !== null) continue;
      for (const device of turnedOnBy(message.createdAt)) {
        rows.push({
          deviceId: device.id,
          noticeId: message.noticeId,
          title: "System notice",
          body: message.text,
          createdAt: options.at,
        });
      }
    }
    for (let start = 0; start < rows.length; start += SENDS_PER_INSERT) {
      await tx.insert(pushSends).values(rows.slice(start, start + SENDS_PER_INSERT));
    }
    const alertIds = alertsWaiting.map((message) => message.alertId);
    for (let start = 0; start < alertIds.length; start += IDS_PER_WRITE) {
      await tx
        .update(alertDeliveries)
        .set({ pushDoneAt: options.at })
        .where(inArray(alertDeliveries.alertId, alertIds.slice(start, start + IDS_PER_WRITE)));
    }
    const noticeIds = noticesWaiting.map((message) => message.id);
    for (let start = 0; start < noticeIds.length; start += IDS_PER_WRITE) {
      await tx
        .update(noticeDeliveries)
        .set({ pushDoneAt: options.at })
        .where(inArray(noticeDeliveries.id, noticeIds.slice(start, start + IDS_PER_WRITE)));
    }
    return { messages: alertIds.length + noticeIds.length, pushes: rows.length };
  });
}

// One push that waits, with its device's subscription. `ended` is true for a condition notice's
// push whose condition ended after it was handed out. `pushOn` is false when the device's Member
// took push out of their channels after it was handed out.
export type WaitingPush = {
  id: number;
  title: string;
  body: string;
  // An Alert's push or a System notice's.
  kind: "alert" | "notice";
  tries: number;
  ended: boolean;
  pushOn: boolean;
  device: { id: number } & PushDeviceFields;
};

// Every push that waits, oldest first.
export async function listWaitingPushes(database: Database): Promise<WaitingPush[]> {
  const rows = await database
    .select({
      id: pushSends.id,
      title: pushSends.title,
      body: pushSends.body,
      alertId: pushSends.alertId,
      tries: pushSends.tries,
      noticeKind: systemNotices.kind,
      closedAt: systemNotices.closedAt,
      deviceId: pushDevices.id,
      endpoint: pushDevices.endpoint,
      p256dh: pushDevices.p256dh,
      auth: pushDevices.auth,
      push: alertChannels.push,
    })
    .from(pushSends)
    .innerJoin(pushDevices, eq(pushDevices.id, pushSends.deviceId))
    .leftJoin(systemNotices, eq(systemNotices.id, pushSends.noticeId))
    .leftJoin(alertChannels, eq(alertChannels.memberId, pushDevices.memberId))
    .orderBy(asc(pushSends.id));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    kind: row.alertId === null ? "notice" : "alert",
    tries: row.tries,
    ended: row.noticeKind === "condition" && row.closedAt !== null,
    pushOn: row.push !== false,
    device: { id: row.deviceId, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
  }));
}

// Push is done with these: sent, skipped, or given up.
export async function finishPushes(database: Database, ids: readonly number[]): Promise<void> {
  for (let start = 0; start < ids.length; start += IDS_PER_WRITE) {
    await database
      .delete(pushSends)
      .where(inArray(pushSends.id, ids.slice(start, start + IDS_PER_WRITE)));
  }
}

// Counts one failed try for a push. Returns its failed tries in a row.
export async function countPushFailure(database: Database, id: number): Promise<number> {
  const [row] = await database
    .update(pushSends)
    .set({ tries: sql`${pushSends.tries} + 1` })
    .where(eq(pushSends.id, id))
    .returning({ tries: pushSends.tries });
  return row?.tries ?? 1;
}

// Deletes every waiting push, as in plain-HTTP mode, where push is hidden.
export async function removeWaitingPushes(database: Database): Promise<number> {
  return (await database.delete(pushSends).returning({ id: pushSends.id })).length;
}
