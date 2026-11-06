import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listMemberNamesById,
  listMembers,
  listMembersByJoinOrder,
  listRemovedMembers,
  removeMember,
} from "./members.ts";
import * as schema from "./schema.ts";
import { newTestDatabase, readEveryTable, type TestDatabase } from "./testing.ts";

// Removing a Member (spec 09, Members) against every foreign key to members in app.db (known
// finding K6): each child row is deleted with the Member or keeps its place with no Member.

const AT = new Date("2026-11-05T15:00:00.000Z");

let test: TestDatabase;

beforeEach(async () => {
  test = await newTestDatabase();
});

afterEach(() => {
  test.close();
});

async function addMemberRow(id: string, name: string, joinedAt = AT): Promise<void> {
  await test.database
    .insert(schema.members)
    .values({ id, name, email: `${id}@example.com`, createdAt: joinedAt, updatedAt: joinedAt });
}

// One row in each table that names a Member, for Dana. Another Member, if any, wrote a Goal that
// Dana dropped.
async function addDanasRows(other: string | null = null): Promise<void> {
  const db = test.database;
  const dana = "dana";
  await db.insert(schema.sessions).values({
    id: "session-1",
    token: "session-token-1",
    userId: dana,
    expiresAt: AT,
    createdAt: AT,
    updatedAt: AT,
  });
  await db.insert(schema.accounts).values({
    id: "account-1",
    accountId: dana,
    providerId: "credential",
    userId: dana,
    password: "hash",
    createdAt: AT,
    updatedAt: AT,
  });
  await db
    .insert(schema.twoFactors)
    .values({ id: "two-factor-1", userId: dana, secret: "sealed", backupCodes: "sealed" });
  await db.insert(schema.passkeys).values({
    id: "passkey-1",
    publicKey: "public key",
    userId: dana,
    credentialID: "credential-1",
    counter: 0,
    deviceType: "multiDevice",
    backedUp: true,
    createdAt: AT,
    appHost: "money.example.com",
  });
  await db.insert(schema.alertChannels).values({ memberId: dana, push: true, email: true });
  const [device] = await db
    .insert(schema.pushDevices)
    .values({
      memberId: dana,
      endpoint: "https://push.example/1",
      p256dh: "p",
      auth: "a",
      createdAt: AT,
    })
    .returning({ id: schema.pushDevices.id });
  await db.insert(schema.pushSends).values({
    deviceId: device?.id ?? 0,
    title: "System notice",
    body: "Body",
    createdAt: AT,
  });
  await db.insert(schema.householdFacts).values({
    id: 1,
    zipCode: "00000",
    state: "XX",
    timeZone: "America/New_York",
    ages: [40],
    rentOrOwn: "rent",
    updatedAt: AT,
    updatedBy: dana,
  });
  await db.insert(schema.masterKeyChecks).values({ id: 1, memberId: dana, at: AT, matched: true });
  await db.insert(schema.budgetDraftAcceptance).values({ id: 1, acceptedAt: AT, acceptedBy: dana });
  await db.insert(schema.goals).values([
    {
      id: "goal-1",
      words: "Save for a bike",
      authorId: dana,
      date: "2026-11-01",
      status: "active",
    },
    {
      id: "goal-2",
      words: "Spend less on takeout",
      authorId: other,
      date: "2026-11-01",
      status: "dropped",
      endedOn: "2026-11-02",
      endedBy: dana,
    },
  ]);
  await db.insert(schema.proposals).values({
    id: "proposal-1",
    kind: "new Goal",
    source: "Chat",
    runId: "run-1",
    reason: "Reason",
    words: "Save more",
    status: "skipped",
    createdAt: AT,
    closedAt: AT,
    closedBy: dana,
    undoneBy: dana,
  });
  await db.insert(schema.alerts).values({
    id: "alert-1",
    kind: "Large purchase",
    createdAt: AT,
    facts: {},
    text: "A large purchase",
  });
  await db.insert(schema.alertNotesDone).values({ alertId: "alert-1", memberId: dana, doneAt: AT });
  await db
    .insert(schema.alertPresses)
    .values({ alertId: "alert-1", memberId: dana, pressedAt: AT });
  await db
    .insert(schema.chatThreads)
    .values({ id: "thread-1", title: "Bikes", createdAt: AT, lastMessageAt: AT });
  await db.insert(schema.chatMessages).values({
    id: "message-1",
    threadId: "thread-1",
    author: "Member",
    memberId: dana,
    memberName: "Dana",
    text: "How much did we spend on bikes?",
    createdAt: AT,
  });
  await db.insert(schema.invites).values({
    id: "invite-1",
    tokenHash: "00",
    madeBy: dana,
    createdAt: AT,
    expiresAt: AT,
  });
  await db.insert(schema.loginResets).values({
    id: "reset-1",
    memberId: dana,
    tokenHash: "01",
    createdAt: AT,
    expiresAt: AT,
  });
}

describe("removing a Member", () => {
  it("names only foreign keys to members that cascade, or set null on a column that may be empty", async () => {
    const tables = await test.database.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    );
    const keys: string[] = [];
    for (const { name } of tables) {
      const foreign = await test.database.all<{ table: string; from: string; on_delete: string }>(
        sql`SELECT "table", "from", on_delete FROM pragma_foreign_key_list(${name})`,
      );
      const columns = await test.database.all<{ name: string; notnull: number }>(
        sql`SELECT name, "notnull" FROM pragma_table_info(${name})`,
      );
      for (const key of foreign.filter((row) => row.table === "members")) {
        const notNull = columns.find((column) => column.name === key.from)?.notnull === 1;
        keys.push(`${name}.${key.from}: ${key.on_delete}${notNull ? ", not null" : ""}`);
      }
    }

    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) expect(key).toMatch(/: (CASCADE(, not null)?|SET NULL)$/);
  });

  it("deletes the Member's login rows and passkeys, devices, invite links and reset link, keeps every other row with no Member, and keeps their name on their Goals and Chat messages", async () => {
    await addMemberRow("alex", "Alex");
    await addMemberRow("dana", "Dana");
    await addDanasRows("alex");

    expect(await removeMember(test.database, "dana", AT)).toBe("removed");

    const after = await readEveryTable(test.database);
    for (const table of [
      "sessions",
      "accounts",
      "two_factors",
      "passkeys",
      "alert_channels",
      "push_devices",
      "push_sends",
      "invites",
      "login_resets",
    ]) {
      expect(after[table], table).toEqual([]);
    }
    expect(await listMembers(test.database)).toMatchObject([{ id: "alex", name: "Alex" }]);
    expect(after.goals).toMatchObject([
      { id: "goal-1", author_id: null, author_name: "Dana" },
      { id: "goal-2", author_id: "alex", author_name: null, ended_by: null },
    ]);
    expect(after.chat_messages).toMatchObject([{ member_id: null, member_name: "Dana" }]);
    expect(after.proposals).toMatchObject([{ closed_by: null, undone_by: null }]);
    expect(after.alert_notes_done).toMatchObject([{ alert_id: "alert-1", member_id: null }]);
    expect(after.alert_presses).toMatchObject([{ alert_id: "alert-1", member_id: null }]);
    expect(after.budget_draft_acceptance).toMatchObject([{ id: 1, accepted_by: null }]);
    expect(after.household_facts).toMatchObject([{ id: 1, updated_by: null }]);
    expect(after.master_key_checks).toMatchObject([{ id: 1, member_id: null }]);
    expect(after.removed_members).toEqual([
      { label_number: 1, name: "Dana", removed_at: AT.toISOString() },
    ]);
  });

  it("refuses the last Member, and changes nothing", async () => {
    await addMemberRow("dana", "Dana");
    await addDanasRows();
    const before = await readEveryTable(test.database);

    expect(await removeMember(test.database, "dana", AT)).toBe("last Member");

    expect(await readEveryTable(test.database)).toEqual(before);
  });

  it("refuses an ID no Member has, and changes nothing", async () => {
    await addMemberRow("alex", "Alex");
    await addMemberRow("dana", "Dana");
    await addDanasRows();
    const before = await readEveryTable(test.database);

    expect(await removeMember(test.database, "goal-1", AT)).toBe("no such Member");

    expect(await readEveryTable(test.database)).toEqual(before);
  });
});

describe("Member label numbers", () => {
  const MINUTE_MS = 60_000;
  const later = (minutes: number) => new Date(AT.getTime() + minutes * MINUTE_MS);
  const numbers = async () =>
    (await listMemberNamesById(test.database)).map(({ id, labelNumber }) => [id, labelNumber]);

  it("follow the join order, and never move or come back after a removal", async () => {
    await addMemberRow("alex", "Alex", AT);
    await addMemberRow("dana", "Dana", later(1));
    await addMemberRow("sam", "Sam", later(2));
    expect(await numbers()).toEqual([
      ["alex", 0],
      ["dana", 1],
      ["sam", 2],
    ]);

    expect(await removeMember(test.database, "dana", later(3))).toBe("removed");
    expect(await numbers()).toEqual([
      ["alex", 0],
      ["sam", 2],
    ]);

    await addMemberRow("lee", "Lee", later(4));
    expect(await removeMember(test.database, "alex", later(5))).toBe("removed");
    expect(await numbers()).toEqual([
      ["sam", 2],
      ["lee", 3],
    ]);
    expect(await listMembersByJoinOrder(test.database)).toEqual([
      { name: "Sam", email: "sam@example.com", labelNumber: 2 },
      { name: "Lee", email: "lee@example.com", labelNumber: 3 },
    ]);
    expect(await listRemovedMembers(test.database)).toEqual([
      { labelNumber: 0, name: "Alex" },
      { labelNumber: 1, name: "Dana" },
    ]);
  });
});
