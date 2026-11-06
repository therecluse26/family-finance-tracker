import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addConnection,
  markConnectionRemoved,
  readConnection,
  type StoredConnection,
  saveSyncState,
} from "../db/index.ts";
import { fakeAccount } from "./fake.ts";
import { runSyncJob, type SyncNowResult, syncNow } from "./index.ts";
import { newTestBank, type TestBank } from "./testing.ts";

// Sync now (spec 02, Sync now), on the fake adapter with a fake clock. Each test records the sync
// jobs Sync now starts, with their start times, in place of Sidequest.

const BANK = "fake-first-bank";
const BANK_NAME = "First Fake Bank";
const CHECKING = fakeAccount({ id: "acc-checking", name: "Everyday Checking" });

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const T0 = new Date("2026-11-04T15:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("Sync now", () => {
  let bank: TestBank;
  let id: string;
  // Each sync job Sync now started: the Connection, and its start time, or "now".
  let started: { connectionId: string; at: Date | "now" }[];

  const press = (now: Date): Promise<SyncNowResult[]> =>
    syncNow(now, async (connectionId, startAt) => {
      started.push({ connectionId, at: startAt ?? "now" });
    });

  const stored = async (connectionId = id): Promise<StoredConnection> => {
    const row = await readConnection(bank.database, connectionId);
    if (row === undefined) throw new Error("The Connection is gone.");
    return row;
  };

  beforeEach(async () => {
    bank = await newTestBank({ timeZone: "America/New_York" });
    id = await bank.connect(BANK, BANK_NAME);
    bank.fake.addPages(BANK, { accounts: [CHECKING], historyLoaded: true });
    started = [];
  });

  afterEach(() => {
    bank.close();
  });

  it("syncs every Connection that is Healthy or Retrying, and no other", async () => {
    const retrying = await bank.connect("fake-retrying", "Retrying Bank");
    const needsAMember = await bank.connect("fake-needs", "Needs Bank");
    const broken = await bank.connect("fake-broken", "Broken Bank");
    await saveSyncState(bank.database, retrying, { health: "retrying", failedSyncs: 2 });
    await saveSyncState(bank.database, needsAMember, { health: "needs a member" });
    await saveSyncState(bank.database, broken, { health: "broken" });

    const results = await press(T0);

    expect(results.map((result) => result.connectionId).sort()).toEqual([id, retrying].sort());
    expect(results.every((result) => result.outcome === "syncing")).toBe(true);
    expect(started.map((job) => job.connectionId).sort()).toEqual([id, retrying].sort());
    expect(started.every((job) => job.at === "now")).toBe(true);
  });

  // A held Connection (a duplicate of a bank another Connection covers) and a removed one never
  // sync, so Sync now neither starts their syncs nor asks their provider to Refresh.
  it("skips a held Connection and a removed one, with no sync and no Refresh", async () => {
    bank.fake.actions = { ...bank.fake.actions, refresh: true };
    const held = await addConnection(bank.database, {
      provider: "fake",
      bankId: "fake-held",
      bankName: "Held Bank",
      origin: "linked",
      syncHeld: true,
    });
    const removed = await bank.connect("fake-removed", "Removed Bank");
    expect(await markConnectionRemoved(bank.database, removed, T0)).toMatchObject({
      removed: true,
    });

    const results = await press(T0);

    expect(results.map((result) => result.connectionId)).toEqual([id]);
    expect(started.map((job) => job.connectionId)).toEqual([id, id]);
    expect(bank.fake.refreshes).toEqual([id]);
    expect((await stored(held)).lastRefreshAt).toBeNull();
    expect((await stored(removed)).lastRefreshAt).toBeNull();
  });

  it("asks for no Refresh where the adapter does not declare it", async () => {
    const results = await press(T0);

    expect(bank.fake.refreshes).toEqual([]);
    expect(results).toEqual([
      { connectionId: id, bankName: BANK_NAME, outcome: "syncing", refreshed: false },
    ]);
    expect(started).toEqual([{ connectionId: id, at: "now" }]);
  });

  describe("where the adapter declares Refresh", () => {
    beforeEach(() => {
      bank.fake.actions = { ...bank.fake.actions, refresh: true };
    });

    it("refreshes first, then syncs at once and again 5 minutes later, as a job with a start time", async () => {
      const results = await press(T0);

      expect(bank.fake.refreshes).toEqual([id]);
      expect(results).toEqual([
        { connectionId: id, bankName: BANK_NAME, outcome: "syncing", refreshed: true },
      ]);
      expect(started).toEqual([
        { connectionId: id, at: "now" },
        { connectionId: id, at: at(5 * MINUTE) },
      ]);
      expect((await stored()).lastRefreshAt).toEqual(T0);
    });

    it("refreshes at most once an hour: a second press within the hour just syncs", async () => {
      await press(T0);
      started = [];

      const second = await press(at(59 * MINUTE));

      expect(bank.fake.refreshes).toEqual([id]);
      expect(second).toMatchObject([{ outcome: "syncing", refreshed: false }]);
      expect(started).toEqual([{ connectionId: id, at: "now" }]);

      started = [];
      const third = await press(at(HOUR));

      expect(bank.fake.refreshes).toEqual([id, id]);
      expect(third).toMatchObject([{ outcome: "syncing", refreshed: true }]);
      expect(started).toEqual([
        { connectionId: id, at: "now" },
        { connectionId: id, at: at(HOUR + 5 * MINUTE) },
      ]);
    });

    it("counts the hour per Connection", async () => {
      await press(T0);
      const other = await bank.connect("fake-other", "Other Bank");

      await press(at(10 * MINUTE));

      expect(bank.fake.refreshes).toEqual([id, other]);
    });

    it("just syncs, once, when the Refresh fails", async () => {
      bank.fake.refresh = async () => {
        throw new Error("The fake bank could not Refresh.");
      };

      const results = await press(T0);

      expect(results).toMatchObject([{ outcome: "syncing", refreshed: false }]);
      expect(started).toEqual([{ connectionId: id, at: "now" }]);
      // The failed Refresh still counts toward the hour.
      expect((await stored()).lastRefreshAt).toEqual(T0);
    });
  });

  describe("with minSyncGapHours set to 1", () => {
    beforeEach(() => {
      bank.fake.minSyncGapHours = 1;
      bank.fake.actions = { ...bank.fake.actions, refresh: true };
    });

    it("skips a Connection synced less than an hour ago, and says when it can sync next", async () => {
      await runSyncJob(id, () => T0);
      const recent = await bank.connect("fake-recent", "Recent Bank");
      bank.fake.addPages("fake-recent", { accounts: [], historyLoaded: true });
      await runSyncJob(recent, () => at(-2 * HOUR));

      const results = await press(at(40 * MINUTE));

      expect(results).toEqual(
        expect.arrayContaining([
          {
            connectionId: id,
            bankName: BANK_NAME,
            outcome: "skipped",
            canSyncAt: at(HOUR),
          },
          { connectionId: recent, bankName: "Recent Bank", outcome: "syncing", refreshed: true },
        ]),
      );
      // A skipped Connection gets no Refresh and no sync job.
      expect(bank.fake.refreshes).toEqual([recent]);
      expect(started.map((job) => job.connectionId)).toEqual([recent, recent]);
    });

    it("syncs it once the hour has passed", async () => {
      await runSyncJob(id, () => T0);

      const results = await press(at(HOUR));

      expect(results).toMatchObject([{ connectionId: id, outcome: "syncing" }]);
    });
  });

  it("ends any back-off once its sync succeeds", async () => {
    const retryingSince = at(-5 * HOUR);
    await saveSyncState(bank.database, id, {
      health: "retrying",
      retryingSince,
      failedSyncs: 3,
      lastSyncAttemptAt: at(-HOUR),
      // The back-off's next retry, 8 hours after the last one.
      nextSyncAt: at(7 * HOUR),
    });

    await syncNow(T0, async (connectionId) => {
      await runSyncJob(connectionId, () => T0);
    });

    expect(await stored()).toMatchObject({
      health: "healthy",
      retryingSince: null,
      failedSyncs: 0,
      lastSyncAttemptAt: T0,
      // 10:00 in New York: back to the 6-hour schedule, at 12:07.
      nextSyncAt: new Date("2026-11-04T17:07:00.000Z"),
    });
  });
});
