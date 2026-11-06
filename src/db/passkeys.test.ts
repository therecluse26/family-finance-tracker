import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removePasskeysUnderOtherHosts } from "./passkeys.ts";
import * as schema from "./schema.ts";
import { newTestDatabase, readEveryTable, type TestDatabase } from "./testing.ts";

// The start's passkey check in app.db (spec 09, Changing APP_URL): it deletes only the passkeys made
// under another host, and adds one System notice for each Member who lost one.

const AT = new Date("2026-11-05T15:00:00.000Z");
const HOST = "money.example.com";
const noticeText = (name: string) => `${name} lost a passkey`;

let test: TestDatabase;

beforeEach(async () => {
  test = await newTestDatabase();
  for (const [n, id] of ["alex", "dana", "sam"].entries()) {
    const joinedAt = new Date(AT.getTime() - (3 - n) * 1000);
    await test.database.insert(schema.members).values({
      id,
      name: id[0]?.toUpperCase() + id.slice(1),
      email: `${id}@example.com`,
      createdAt: joinedAt,
      updatedAt: joinedAt,
    });
  }
});

afterEach(() => {
  test.close();
});

async function addPasskey(id: string, memberId: string, appHost: string): Promise<void> {
  await test.database.insert(schema.passkeys).values({
    id,
    publicKey: "public key",
    userId: memberId,
    credentialID: `credential-${id}`,
    counter: 0,
    deviceType: "multiDevice",
    backedUp: true,
    createdAt: AT,
    appHost,
  });
}

const check = () =>
  removePasskeysUnderOtherHosts(test.database, { host: HOST, at: AT, noticeText });

describe("the start's passkey check", () => {
  it("deletes only passkeys made under another host, with one notice for each Member who lost one", async () => {
    await addPasskey("dana-old-1", "dana", "old.example.com");
    await addPasskey("dana-old-2", "dana", "192.168.1.20");
    await addPasskey("dana-now", "dana", HOST);
    await addPasskey("sam-old", "sam", "money.example.com.old");
    await addPasskey("alex-now", "alex", HOST);

    expect(await check()).toEqual(["dana", "sam"]);

    const after = await readEveryTable(test.database);
    expect((after.passkeys as { id: string }[]).map((row) => row.id).sort()).toEqual([
      "alex-now",
      "dana-now",
    ]);
    expect(after.system_notices).toEqual([
      expect.objectContaining({ kind: "event", text: "Dana lost a passkey", closed_at: null }),
      expect.objectContaining({ kind: "event", text: "Sam lost a passkey", closed_at: null }),
    ]);
    const notices = after.system_notices as { id: string }[];
    expect(after.notice_deliveries).toEqual(
      notices.map((notice) => expect.objectContaining({ notice_id: notice.id })),
    );
  });

  it("changes nothing when every passkey was made under the host, so a second start adds no notice", async () => {
    await addPasskey("dana-old", "dana", "old.example.com");
    await addPasskey("alex-now", "alex", HOST);
    await check();
    const before = await readEveryTable(test.database);

    expect(await check()).toEqual([]);

    expect(await readEveryTable(test.database)).toEqual(before);
  });
});
