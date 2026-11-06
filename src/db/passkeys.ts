import { asc, eq, ne } from "drizzle-orm";
import type { Database } from "./client.ts";
import { members, noticeDeliveries, passkeys, systemNotices } from "./schema.ts";

// Passkeys in app.db (spec 09, Changing APP_URL). Better Auth writes and reads them through the auth
// module; this is the start's check of the host each one was made under.

// Deletes every passkey made under another host than `host`, and adds one System notice for each
// Member who lost one, with its delivery record, in one transaction. So a stop partway leaves
// either the passkeys and no notice, for the next start to find, or both done. Returns the IDs of
// the Members who lost a passkey, in the order they joined.
export async function removePasskeysUnderOtherHosts(
  database: Database,
  check: { host: string; at: Date; noticeText: (memberName: string) => string },
): Promise<string[]> {
  return database.transaction(async (tx) => {
    const lost = await tx
      .selectDistinct({ id: members.id, name: members.name, createdAt: members.createdAt })
      .from(passkeys)
      .innerJoin(members, eq(members.id, passkeys.userId))
      .where(ne(passkeys.appHost, check.host))
      .orderBy(asc(members.createdAt), asc(members.id));
    if (lost.length === 0) return [];
    await tx.delete(passkeys).where(ne(passkeys.appHost, check.host));
    for (const member of lost) {
      const id = crypto.randomUUID();
      await tx.insert(systemNotices).values({
        id,
        kind: "event",
        text: check.noticeText(member.name),
        condition: null,
        raisedAt: check.at,
      });
      await tx.insert(noticeDeliveries).values({ noticeId: id, createdAt: check.at });
    }
    return lost.map((member) => member.id);
  });
}
