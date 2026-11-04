import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addConnection,
  readConnection,
  type StoredConnection,
  type SyncState,
  saveSyncState,
} from "../db/index.ts";
import { everyMinute, startJob, startJobs } from "../jobs/index.ts";
import { waitFor } from "../jobs/testing.ts";
import { fakeAccount, fakeTxn } from "./fake.ts";
import {
  catchUpSyncs,
  connectionRemoving,
  connectionToRepair,
  runSyncJob,
  startDueSyncs,
  syncConnection,
} from "./index.ts";
import { newTestBank, SyncScheduleJob, TEST_BANK_JOB_LIST, type TestBank } from "./testing.ts";

// Each Connection's sync schedule and health (spec 02, Connections, Error kinds, Sync schedule,
// Back-off, Broken Connections, and First history load), on the fake adapter with a fake clock.
// The Household is in New York. In November 2026, New York is 5 hours behind UTC; in July, 4.

const BANK = "fake-first-bank";
const BANK_NAME = "First Fake Bank";
const TIME_ZONE = "America/New_York";
const CHECKING = fakeAccount({ id: "acc-checking", name: "Everyday Checking" });

const HOUR = 60 * 60 * 1000;
const clock = (iso: string | Date) => () => new Date(iso);
const later = (iso: string, hours: number) => new Date(new Date(iso).getTime() + hours * HOUR);

describe("a Connection's sync schedule and health", () => {
  let bank: TestBank;
  let id: string;

  const stored = async (connectionId = id): Promise<StoredConnection> => {
    const row = await readConnection(bank.database, connectionId);
    if (row === undefined) throw new Error("The Connection is gone.");
    return row;
  };

  // Every System notice, oldest first.
  const notices = async () =>
    (
      await bank.database.$client.execute(
        "SELECT text, condition, closed_at FROM system_notices ORDER BY raised_at, rowid",
      )
    ).rows.map((row) => ({
      text: row.text,
      condition: row.condition,
      open: row.closed_at === null,
    }));

  // Syncs at the given moment. A failed sync throws once its health is recorded.
  const syncAt = (iso: string | Date) => syncConnection(id, clock(iso));
  const failAt = async (iso: string | Date, kind: "temporary" | "needs a member" | "gone") => {
    const cursor = (await stored()).syncCursor;
    bank.fake.failAt(BANK, cursor === null ? 0 : Number(cursor.split(":")[1]), kind);
    await expect(syncAt(iso)).rejects.toMatchObject({ kind });
  };

  beforeEach(async () => {
    bank = await newTestBank({ timeZone: TIME_ZONE });
    id = await bank.connect(BANK, BANK_NAME);
  });

  afterEach(() => {
    bank.close();
  });

  it("gives each new Connection a random minute from 0 to 59", async () => {
    const minutes = new Set<number>();
    for (let n = 0; n < 40; n += 1) {
      const made = await addConnection(bank.database, {
        provider: "fake",
        bankId: `fake-${n}`,
        bankName: `Fake bank ${n}`,
        origin: "linked",
      });
      const { syncMinute } = await stored(made);
      expect(Number.isInteger(syncMinute) && syncMinute >= 0 && syncMinute <= 59).toBe(true);
      minutes.add(syncMinute);
    }
    expect(minutes.size).toBeGreaterThan(1);
  });

  describe("a Healthy Connection", () => {
    beforeEach(() => {
      bank.fake.addPages(BANK, { accounts: [CHECKING], historyLoaded: true });
    });

    it.each([
      // 06:30 in New York: the next slot is 12:07.
      ["after 06:30", "2026-11-04T11:30:00.000Z", "2026-11-04T17:07:00.000Z"],
      // At 12:07 itself, the next slot is 18:07.
      ["at 12:07", "2026-11-04T17:07:00.000Z", "2026-11-04T23:07:00.000Z"],
      // After 18:07, the next slot is 00:07 the next day.
      ["after 18:07", "2026-11-04T23:30:00.000Z", "2026-11-05T05:07:00.000Z"],
      // After 00:07, it is 06:07.
      ["after 00:07", "2026-11-05T05:10:00.000Z", "2026-11-05T11:07:00.000Z"],
      // In summer time, 12:07 in New York is 16:07 UTC.
      ["in summer time", "2026-07-01T11:30:00.000Z", "2026-07-01T16:07:00.000Z"],
    ])("syncs at 00:mm, 06:mm, 12:mm, and 18:mm Household time: %s", async (_case, at, next) => {
      await syncAt(at);

      const connection = await stored();
      expect(connection.health).toBe("healthy");
      expect(connection.lastSyncAttemptAt).toEqual(new Date(at));
      expect(connection.lastSyncedAt).toEqual(new Date(at));
      expect(connection.nextSyncAt).toEqual(new Date(next));
    });

    it("waits at least minSyncGapHours between two syncs", async () => {
      bank.fake.minSyncGapHours = 8;

      // 06:30: 12:07 is less than 8 hours away, so the next sync is at 18:07.
      await syncAt("2026-11-04T11:30:00.000Z");

      expect((await stored()).nextSyncAt).toEqual(new Date("2026-11-04T23:07:00.000Z"));
    });
  });

  describe("while its history loads", () => {
    it("syncs every 15 minutes, then every 6 hours once it has loaded", async () => {
      bank.fake.addPages(BANK, { accounts: [CHECKING], historyLoaded: false });
      await syncAt("2026-11-04T11:30:00.000Z");
      expect((await stored()).nextSyncAt).toEqual(new Date("2026-11-04T11:45:00.000Z"));

      await syncAt("2026-11-04T11:45:00.000Z");
      expect((await stored()).nextSyncAt).toEqual(new Date("2026-11-04T12:00:00.000Z"));

      bank.fake.addPages(BANK, { historyLoaded: true });
      await syncAt("2026-11-04T12:00:00.000Z");
      expect((await stored()).historyLoaded).toBe(true);
      expect((await stored()).nextSyncAt).toEqual(new Date("2026-11-04T17:07:00.000Z"));
    });

    it("syncs every minSyncGapHours instead, when that is longer", async () => {
      bank.fake.minSyncGapHours = 1;
      bank.fake.addPages(BANK, { accounts: [CHECKING], historyLoaded: false });

      await syncAt("2026-11-04T11:30:00.000Z");

      expect((await stored()).nextSyncAt).toEqual(new Date("2026-11-04T12:30:00.000Z"));
    });
  });

  describe("after a Temporary error", () => {
    const START = "2026-11-04T11:30:00.000Z";

    beforeEach(() => {
      bank.fake.addPages(BANK, { accounts: [CHECKING], historyLoaded: true });
    });

    it("retries after 1, 2, 4, 8, and 16 hours, then every 24 hours, with one at 3 days", async () => {
      let at = new Date(START);
      const waits: number[] = [];
      for (let n = 0; n < 8; n += 1) {
        await failAt(at, "temporary");
        const connection = await stored();
        expect(connection.health).toBe("retrying");
        expect(connection.lastSyncAttemptAt).toEqual(at);
        const next = connection.nextSyncAt ?? new Date(Number.NaN);
        waits.push((next.getTime() - at.getTime()) / HOUR);
        at = next;
      }

      // The retry due at hour 79 comes at hour 72, the 3-day mark, instead.
      expect(waits).toEqual([1, 2, 4, 8, 16, 24, 17, 24]);
      expect((await stored()).retryingSince).toEqual(new Date(START));
    });

    it("waits minSyncGapHours when that is longer than the back-off", async () => {
      bank.fake.minSyncGapHours = 3;

      await failAt(START, "temporary");

      expect((await stored()).nextSyncAt).toEqual(later(START, 3));
    });

    it("becomes Healthy after a successful sync, back on the 6-hour schedule", async () => {
      await failAt(START, "temporary");
      await failAt(later(START, 1), "temporary");

      // 3 hours after 06:30 is 09:30 in New York; the next slot is 12:07.
      await syncAt(later(START, 3));

      const connection = await stored();
      expect(connection).toMatchObject({ health: "healthy", failedSyncs: 0, retryingSince: null });
      expect(connection.nextSyncAt).toEqual(new Date("2026-11-04T17:07:00.000Z"));

      // The back-off starts over.
      await failAt("2026-11-04T17:07:00.000Z", "temporary");
      expect((await stored()).nextSyncAt).toEqual(new Date("2026-11-04T18:07:00.000Z"));
    });

    it("sends the System notice at the 3-day mark when the retry there fails", async () => {
      let at = new Date(START);
      while ((await notices()).length === 0) {
        expect(at.getTime()).toBeLessThanOrEqual(later(START, 72).getTime());
        await failAt(at, "temporary");
        at = (await stored()).nextSyncAt ?? new Date(Number.NaN);
      }

      expect((await stored()).lastSyncAttemptAt).toEqual(later(START, 72));
    });

    it("sends one System notice after 3 days in Retrying, with no Repair button", async () => {
      await syncAt(START);
      // Retrying from 12:07 on Nov 4, New York time.
      const since = "2026-11-04T17:07:00.000Z";
      await failAt(since, "temporary");
      await failAt(later(since, 71), "temporary");
      expect(await notices()).toEqual([]);

      await failAt(later(since, 72), "temporary");
      await failAt(later(since, 96), "temporary");
      await failAt(later(since, 120), "temporary");

      const sent = await notices();
      expect(sent).toEqual([
        {
          text: `${BANK_NAME} has not synced since Nov 4`,
          condition: `connection not syncing:${id}`,
          open: true,
        },
      ]);
      expect(connectionToRepair(String(sent[0]?.condition))).toBeNull();
      expect((await stored()).health).toBe("retrying");

      // A successful sync ends it.
      await syncAt(later(since, 144));
      expect(await notices()).toEqual([expect.objectContaining({ open: false })]);
    });
  });

  describe("when the Connection needs a Member", () => {
    const START = "2026-11-04T11:30:00.000Z";

    beforeEach(async () => {
      bank.fake.addPages(BANK, { accounts: [CHECKING], historyLoaded: true });
      await failAt(START, "needs a member");
    });

    it("stops polling, sends one System notice with Repair, and checks once a day", async () => {
      const connection = await stored();
      expect(connection.health).toBe("needs a member");
      expect(connection.nextSyncAt).toEqual(later(START, 24));
      expect(await notices()).toEqual([
        {
          text: `${BANK_NAME} needs you to sign in again`,
          condition: `connection needs a member:${id}`,
          open: true,
        },
      ]);
      expect(connectionToRepair(`connection needs a member:${id}`)).toBe(id);

      const started: string[] = [];
      const start = async (connectionId: string) => void started.push(connectionId);
      expect(await startDueSyncs(later(START, 23), start)).toEqual([]);
      expect(await startDueSyncs(later(START, 24), start)).toEqual([id]);
      expect(started).toEqual([id]);
    });

    it("keeps waiting while the check finds an error, and syncs no data", async () => {
      bank.fake.setCheckError(BANK, "needs a member");
      bank.fake.calls.length = 0;

      expect(await runSyncJob(id, clock(later(START, 24)))).toBe("still needs a member");

      expect(bank.fake.checks).toEqual([id]);
      expect(bank.fake.calls).toEqual([]);
      const connection = await stored();
      expect(connection.health).toBe("needs a member");
      expect(connection.nextSyncAt).toEqual(later(START, 48));
      expect(await notices()).toHaveLength(1);
    });

    // The check runs in the Connection's queue, so a Remove waits for it, and a check that fails
    // after the Remove cannot bring back the notice the Remove ended.
    it("finishes the check before a Remove pressed during it", async () => {
      bank.fake.setCheckError(BANK, "gone");
      let checking = false;
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const check = bank.fake.check.bind(bank.fake);
      bank.fake.check = async (connection) => {
        checking = true;
        await released;
        return check(connection);
      };

      const job = runSyncJob(id, clock(later(START, 24)));
      while (!checking) await new Promise((resolve) => setTimeout(resolve, 1));
      const removed = connectionRemoving().remove(id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();

      expect(await job).toBe("still needs a member");
      expect(await removed).toEqual({ outcome: "removed" });
      expect((await notices()).filter((notice) => notice.open)).toEqual([]);
      expect(await stored()).toMatchObject({ removedAt: expect.any(Date), nextSyncAt: null });
    });

    it("becomes Healthy and syncs when the check finds no error", async () => {
      expect(await runSyncJob(id, clock(later(START, 24)))).toBe("synced");

      expect(bank.fake.checks).toEqual([id]);
      const connection = await stored();
      expect(connection.health).toBe("healthy");
      expect(connection.syncCursor).not.toBeNull();
      expect(await notices()).toEqual([expect.objectContaining({ open: false })]);
    });

    it("becomes Broken when the check finds access gone", async () => {
      bank.fake.setCheckError(BANK, "gone");

      expect(await runSyncJob(id, clock(later(START, 24)))).toBe("still needs a member");

      expect((await stored()).health).toBe("broken");
      expect(await notices()).toEqual([
        expect.objectContaining({ condition: `connection needs a member:${id}`, open: false }),
        expect.objectContaining({ condition: `connection broken:${id}`, open: true }),
      ]);
    });
  });

  describe("when access is Gone", () => {
    const START = "2026-11-04T11:30:00.000Z";
    const txn = (txnId: string) => fakeTxn({ id: txnId, accountId: CHECKING.id, amount: -1_000 });

    beforeEach(async () => {
      bank.fake.addPages(BANK, {
        accounts: [CHECKING],
        added: [txn("t1"), txn("t2")],
        historyLoaded: true,
      });
      await syncAt(START);
      await failAt(later(START, 6), "gone");
    });

    it("becomes Broken, stops polling, and sends one System notice with Repair", async () => {
      const connection = await stored();
      expect(connection.health).toBe("broken");
      expect(connection.nextSyncAt).toBeNull();
      expect(await notices()).toEqual([
        {
          text: `${BANK_NAME} has disconnected. Use Repair to link it again`,
          condition: `connection broken:${id}`,
          open: true,
        },
      ]);
      expect(connectionToRepair(`connection broken:${id}`)).toBe(id);

      const calls = bank.fake.calls.length;
      expect(await startDueSyncs(later(START, 24 * 30), async () => {})).toEqual([]);
      expect(await catchUpSyncs(later(START, 24 * 30), async () => {})).toEqual([]);
      expect(await runSyncJob(id, clock(later(START, 24)))).toBe("not polled");
      expect(bank.fake.calls).toHaveLength(calls);
      expect(bank.fake.checks).toEqual([]);
    });

    it("keeps every Account and Transaction it stored", async () => {
      const accounts = await bank.database.$client.execute(
        "SELECT closed_at FROM household_accounts WHERE connection_id = ?",
        [id],
      );
      expect(accounts.rows).toEqual([expect.objectContaining({ closed_at: null })]);
      const transactions = await bank.database.$client.execute(
        "SELECT provider_transaction_id, hidden_reason FROM transactions ORDER BY 1",
      );
      expect(
        transactions.rows.map((row) => [row.provider_transaction_id, row.hidden_reason]),
      ).toEqual([
        ["t1", null],
        ["t2", null],
      ]);
    });
  });

  describe("the sync schedule", () => {
    const NOW = new Date("2026-11-05T12:00:00.000Z");

    // Connections made in one millisecond come in ID order, so these compare in any order.
    const sorted = (ids: string[]) => [...ids].sort();

    const connectWith = async (bankId: string, state: SyncState) => {
      const connectionId = await bank.connect(bankId);
      await saveSyncState(bank.database, connectionId, state);
      return connectionId;
    };

    it("starts each due sync once, and moves its next sync time ahead", async () => {
      const started: string[] = [];
      const start = async (connectionId: string) => void started.push(connectionId);
      const due = await connectWith("fake-due", { nextSyncAt: later(NOW.toISOString(), -1) });
      await connectWith("fake-later", { nextSyncAt: later(NOW.toISOString(), 1) });

      expect(sorted(await startDueSyncs(NOW, start))).toEqual(sorted([id, due]));
      expect(await startDueSyncs(NOW, start)).toEqual([]);

      expect(sorted(started)).toEqual(sorted([id, due]));
      expect((await stored(due)).nextSyncAt).toEqual(later(NOW.toISOString(), 1));
    });

    it("at startup, syncs each Connection whose last attempt is more than 6 hours old", async () => {
      const ago = (hours: number) => later(NOW.toISOString(), -hours);
      const ahead = later(NOW.toISOString(), 1);
      // The Connection made in beforeEach has never synced, so it syncs at once.
      const old = await connectWith("fake-old", { lastSyncAttemptAt: ago(7), nextSyncAt: ahead });
      await connectWith("fake-recent", { lastSyncAttemptAt: ago(5), nextSyncAt: ahead });
      await connectWith("fake-six-hours", { lastSyncAttemptAt: ago(6), nextSyncAt: ahead });
      const retrying = await connectWith("fake-retrying", {
        health: "retrying",
        lastSyncAttemptAt: ago(7),
        nextSyncAt: later(NOW.toISOString(), 17),
        retryingSince: ago(7),
        failedSyncs: 6,
      });
      await connectWith("fake-needs-a-member", {
        health: "needs a member",
        lastSyncAttemptAt: ago(30),
        nextSyncAt: ahead,
      });
      await connectWith("fake-broken", { health: "broken", lastSyncAttemptAt: ago(30) });

      const started: string[] = [];
      await catchUpSyncs(NOW, async (connectionId) => void started.push(connectionId));

      expect(sorted(started)).toEqual(sorted([id, old, retrying]));
    });

    it("runs through the sync schedule job, which starts each due sync job", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fft-sync-schedule-"));
      const jobs = await startJobs({
        jobsDb: join(dir, "jobs.db"),
        jobList: TEST_BANK_JOB_LIST,
        tasks: [{ name: "sync schedule", schedule: everyMinute, job: SyncScheduleJob }],
        database: bank.database,
      });
      try {
        bank.fake.addPages(BANK, { accounts: [CHECKING], historyLoaded: true });

        await startJob(SyncScheduleJob, []);

        await waitFor(() => bank.fake.calls.length > 0);
        // Sidequest polls for jobs on real timers.
        for (let tries = 0; tries < 500 && (await stored()).lastSyncedAt === null; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(await stored()).toMatchObject({ health: "healthy", historyLoaded: true });
        expect((await stored()).lastSyncedAt).not.toBeNull();
      } finally {
        await jobs.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
