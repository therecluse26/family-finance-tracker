import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findMemberIdByEmail,
  finishLoginReset,
  listOpenLoginResetHashes,
  startLoginReset,
} from "./login-resets.ts";
import * as schema from "./schema.ts";
import { newTestDatabase, readEveryTable, type TestDatabase } from "./testing.ts";

// Reset links in app.db (spec 09, Login reset): each write changes only the reset Member's rows and
// links, and a refusal changes nothing.

const AT = new Date("2026-11-05T15:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const later = (hours: number) => new Date(AT.getTime() + hours * HOUR_MS);

let test: TestDatabase;

beforeEach(async () => {
  test = await newTestDatabase();
  for (const id of ["alex", "dana"]) {
    await test.database.insert(schema.members).values({
      id,
      name: id,
      email: `${id}@example.com`,
      twoFactorEnabled: true,
      createdAt: AT,
      updatedAt: AT,
    });
    await addLogin(id);
  }
});

afterEach(() => {
  test.close();
});

async function addLogin(id: string, n = 1): Promise<void> {
  const db = test.database;
  await db.insert(schema.sessions).values({
    id: `session-${id}-${n}`,
    token: `token-${id}-${n}`,
    userId: id,
    expiresAt: later(24 * 30),
    createdAt: AT,
    updatedAt: AT,
  });
  if (n > 1) return;
  await db.insert(schema.accounts).values({
    id: `account-${id}`,
    accountId: id,
    providerId: "credential",
    userId: id,
    password: "hash",
    createdAt: AT,
    updatedAt: AT,
  });
  await db
    .insert(schema.twoFactors)
    .values({ id: `two-factor-${id}`, userId: id, secret: "sealed", backupCodes: "sealed" });
}

const reset = (id: string, memberId: string, at = AT) => ({
  id,
  memberId,
  tokenHash: `hash-${id}`,
  at,
  expiresAt: new Date(at.getTime() + 24 * HOUR_MS),
});

const finish = (resetId: string, memberId: string, at: Date) => ({
  resetId,
  memberId,
  at,
  account: { id: `new-account-${resetId}`, password: "new hash" },
  twoFactor: {
    id: `new-two-factor-${resetId}`,
    secret: "new sealed",
    backupCodes: "new sealed",
    lastTotpStep: 7,
  },
});

const ids = (rows: unknown[] | undefined) => (rows as { id: string }[]).map((row) => row.id).sort();

describe("making a reset", () => {
  it("ends only that Member's sessions and deletes only their password, TOTP and backup codes", async () => {
    expect(await startLoginReset(test.database, reset("reset-1", "dana"))).toBe(true);

    const after = await readEveryTable(test.database);
    expect(ids(after.sessions)).toEqual(["session-alex-1"]);
    expect(ids(after.accounts)).toEqual(["account-alex"]);
    expect(ids(after.two_factors)).toEqual(["two-factor-alex"]);
    expect(after.login_resets).toMatchObject([{ id: "reset-1", member_id: "dana" }]);
  });

  it("replaces the Member's earlier link and deletes expired links, and leaves other Members' open links", async () => {
    await startLoginReset(test.database, reset("dana-old", "dana"));
    await startLoginReset(test.database, reset("alex-open", "alex", later(1)));
    await startLoginReset(test.database, reset("dana-new", "dana", later(2)));

    expect(ids((await readEveryTable(test.database)).login_resets)).toEqual([
      "alex-open",
      "dana-new",
    ]);

    // Alex's link expires at hour 25, so Dana's next reset deletes it.
    await startLoginReset(test.database, reset("dana-last", "dana", later(25)));
    expect(ids((await readEveryTable(test.database)).login_resets)).toEqual(["dana-last"]);
  });

  it("refuses an ID no Member has, and changes nothing", async () => {
    const before = await readEveryTable(test.database);

    expect(await startLoginReset(test.database, reset("reset-1", "nobody"))).toBe(false);

    expect(await readEveryTable(test.database)).toEqual(before);
  });

  it("lists only open links, each with its Member's email address", async () => {
    await startLoginReset(test.database, reset("reset-1", "dana"));

    expect(await listOpenLoginResetHashes(test.database, later(23))).toEqual([
      { id: "reset-1", memberId: "dana", email: "dana@example.com", tokenHash: "hash-reset-1" },
    ]);
    expect(await listOpenLoginResetHashes(test.database, later(24))).toEqual([]);
  });

  it("finds a Member by email address in any letter case", async () => {
    expect(await findMemberIdByEmail(test.database, " Dana@Example.COM ")).toBe("dana");
    expect(await findMemberIdByEmail(test.database, "dan@example.com")).toBeUndefined();
  });
});

describe("finishing a reset", () => {
  beforeEach(async () => {
    await startLoginReset(test.database, reset("reset-1", "dana"));
    await startLoginReset(test.database, reset("reset-2", "alex"));
  });

  it("uses up the link and sets the new login, ends any session made since the reset, and leaves other Members' logins", async () => {
    await addLogin("dana", 2);
    await addLogin("alex");

    expect(await finishLoginReset(test.database, finish("reset-1", "dana", later(1)))).toBe(true);

    const after = await readEveryTable(test.database);
    expect(ids(after.login_resets)).toEqual(["reset-2"]);
    expect(ids(after.sessions)).toEqual(["session-alex-1"]);
    expect(ids(after.accounts)).toEqual(["account-alex", "new-account-reset-1"]);
    expect(after.accounts).toContainEqual(
      expect.objectContaining({
        id: "new-account-reset-1",
        member_id: "dana",
        provider_id: "credential",
        password: "new hash",
      }),
    );
    expect(ids(after.two_factors)).toEqual(["new-two-factor-reset-1", "two-factor-alex"]);
    expect(after.two_factors).toContainEqual(
      expect.objectContaining({
        id: "new-two-factor-reset-1",
        member_id: "dana",
        last_totp_step: 7,
        verified: 1,
      }),
    );
  });

  it("works once, and refuses a link past 24 hours, each changing nothing", async () => {
    expect(await finishLoginReset(test.database, finish("reset-1", "dana", later(1)))).toBe(true);
    const before = await readEveryTable(test.database);

    expect(await finishLoginReset(test.database, finish("reset-1", "dana", later(2)))).toBe(false);
    expect(await finishLoginReset(test.database, finish("reset-2", "alex", later(24)))).toBe(false);

    expect(await readEveryTable(test.database)).toEqual(before);
  });
});
