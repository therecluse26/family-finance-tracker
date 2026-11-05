import { asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  alertChannels,
  alertDeliveries,
  alerts,
  members,
  noticeDeliveries,
  smtpSettings,
  systemNotices,
} from "./schema.ts";

// Email for Alerts and System notices in app.db (spec 06, Recipients and channels; System
// notices): the SMTP settings, each Member's channels, and the delivery records the Delivery job
// sends. The notify module decides and encrypts; these functions store and read.

// The ID of smtp_settings' one row. The password's ciphertext is bound to it.
export const SMTP_SETTINGS_ROW = 1;

export type StoredSmtpSettings = {
  host: string;
  port: number;
  username: string;
  // The password's ciphertext, as the secrets module made it.
  password: string;
  sender: string;
};

export async function readSmtpSettings(
  database: Database,
): Promise<StoredSmtpSettings | undefined> {
  const [row] = await database
    .select({
      host: smtpSettings.host,
      port: smtpSettings.port,
      username: smtpSettings.username,
      password: smtpSettings.password,
      sender: smtpSettings.sender,
    })
    .from(smtpSettings)
    .where(eq(smtpSettings.id, SMTP_SETTINGS_ROW));
  return row;
}

// Replaces every SMTP setting at once. `password` is the ciphertext.
export async function storeSmtpSettings(
  database: Database,
  settings: StoredSmtpSettings,
): Promise<void> {
  await database
    .insert(smtpSettings)
    .values({ id: SMTP_SETTINGS_ROW, ...settings })
    .onConflictDoUpdate({ target: smtpSettings.id, set: settings });
}

// A Member's channels: push, email, both, or none.
export type StoredChannels = { push: boolean; email: boolean };

// A Member's channels. A Member who never picked has both.
export async function readChannels(database: Database, memberId: string): Promise<StoredChannels> {
  const [row] = await database
    .select({ push: alertChannels.push, email: alertChannels.email })
    .from(alertChannels)
    .where(eq(alertChannels.memberId, memberId));
  return row ?? { push: true, email: true };
}

export async function storeChannels(
  database: Database,
  memberId: string,
  channels: StoredChannels,
): Promise<void> {
  await database
    .insert(alertChannels)
    .values({ memberId, ...channels })
    .onConflictDoUpdate({ target: alertChannels.memberId, set: channels });
}

// The email address of each Member whose channels hold email, in the order Members joined.
export async function listEmailRecipients(database: Database): Promise<string[]> {
  const rows = await database
    .select({ email: members.email })
    .from(members)
    .leftJoin(alertChannels, eq(alertChannels.memberId, members.id))
    .where(or(isNull(alertChannels.memberId), eq(alertChannels.email, true)))
    .orderBy(asc(members.createdAt), asc(members.id));
  return rows.map((row) => row.email);
}

// A sent Alert's message, as the Alerts step stores it with its decision.
export type NewAlertDelivery = {
  alertId: string;
  title: string;
  text: string;
  advice: string | null;
  createdAt: Date;
};

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_READ = 1000;

// The text and the AI's advice of each of these Alerts, by ID.
export async function listAlertTexts(
  database: Database,
  ids: readonly string[],
): Promise<Map<string, { text: string; advice: string | null }>> {
  const found = new Map<string, { text: string; advice: string | null }>();
  for (let start = 0; start < ids.length; start += IDS_PER_READ) {
    const rows = await database
      .select({ id: alerts.id, text: alerts.text, advice: alerts.advice })
      .from(alerts)
      .where(inArray(alerts.id, ids.slice(start, start + IDS_PER_READ)));
    for (const { id, ...row } of rows) found.set(id, row);
  }
  return found;
}

// One delivery record by its table and ID.
export type DeliveryRef = { kind: "notice"; id: number } | { kind: "alert"; id: string };

// A message that email is not done with yet. `ended` is true for a condition notice whose condition
// already ended.
export type WaitingEmail =
  | { kind: "notice"; id: number; createdAt: Date; text: string; ended: boolean }
  | {
      kind: "alert";
      id: string;
      createdAt: Date;
      title: string;
      text: string;
      advice: string | null;
    };

// Every message that email is not done with yet, oldest first.
export async function listWaitingEmails(database: Database): Promise<WaitingEmail[]> {
  const notices = await database
    .select({
      id: noticeDeliveries.id,
      createdAt: noticeDeliveries.createdAt,
      text: systemNotices.text,
      kind: systemNotices.kind,
      closedAt: systemNotices.closedAt,
    })
    .from(noticeDeliveries)
    .innerJoin(systemNotices, eq(systemNotices.id, noticeDeliveries.noticeId))
    .where(isNull(noticeDeliveries.emailDoneAt));
  const sent = await database
    .select({
      id: alertDeliveries.alertId,
      createdAt: alertDeliveries.createdAt,
      title: alertDeliveries.title,
      text: alertDeliveries.text,
      advice: alertDeliveries.advice,
    })
    .from(alertDeliveries)
    .where(isNull(alertDeliveries.emailDoneAt));
  const waiting: WaitingEmail[] = [
    ...notices.map(({ id, createdAt, text, kind, closedAt }) => ({
      kind: "notice" as const,
      id,
      createdAt,
      text,
      ended: kind === "condition" && closedAt !== null,
    })),
    ...sent.map((row) => ({ kind: "alert" as const, ...row })),
  ];
  return waiting.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

// Email is done with these messages: sent, skipped, or given up. One statement for each table.
export async function finishEmails(
  database: Database,
  refs: readonly DeliveryRef[],
  at: Date,
): Promise<void> {
  const noticeIds = refs.flatMap((ref) => (ref.kind === "notice" ? [ref.id] : []));
  const alertIds = refs.flatMap((ref) => (ref.kind === "alert" ? [ref.id] : []));
  for (let start = 0; start < noticeIds.length; start += IDS_PER_READ) {
    await database
      .update(noticeDeliveries)
      .set({ emailDoneAt: at })
      .where(inArray(noticeDeliveries.id, noticeIds.slice(start, start + IDS_PER_READ)));
  }
  for (let start = 0; start < alertIds.length; start += IDS_PER_READ) {
    await database
      .update(alertDeliveries)
      .set({ emailDoneAt: at })
      .where(inArray(alertDeliveries.alertId, alertIds.slice(start, start + IDS_PER_READ)));
  }
}

// Counts one failed email try for a message. Returns its failed tries in a row.
export async function countEmailFailure(database: Database, ref: DeliveryRef): Promise<number> {
  const [row] =
    ref.kind === "notice"
      ? await database
          .update(noticeDeliveries)
          .set({ emailTries: sql`${noticeDeliveries.emailTries} + 1` })
          .where(eq(noticeDeliveries.id, ref.id))
          .returning({ tries: noticeDeliveries.emailTries })
      : await database
          .update(alertDeliveries)
          .set({ emailTries: sql`${alertDeliveries.emailTries} + 1` })
          .where(eq(alertDeliveries.alertId, ref.id))
          .returning({ tries: alertDeliveries.emailTries });
  return row?.tries ?? 1;
}
