import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addConnection,
  deleteRemovedConnection,
  historyProgress,
  listUnhandledTransactions,
  markConnectionRemoved,
  readConnection,
  readHistoryWait,
} from "../db/index.ts";
import { registerFollowUpStep, runFollowUp } from "../follow-up/index.ts";
import { startJob, startJobs } from "../jobs/index.ts";
import { fakeAccount, fakeTxn } from "./fake.ts";
import {
  aiMayRun,
  endHistoryWait,
  HISTORY_READY,
  historyStatus,
  registerBankAddedLaterHook,
  registerFirstRunStep,
  restartLostFirstRun,
  restartLostLaterHooks,
  runFirstRun,
  runLaterHooks,
  runSyncJob,
  syncConnection,
} from "./index.ts";
import {
  newTestBank,
  SyncConnectionJob,
  SyncScheduleJob,
  TEST_BANK_JOB_LIST,
  type TestBank,
} from "./testing.ts";

// The first history load (spec 02, First history load and A bank added later; spec 08, When AI
// does not run), on the fake adapter with a fake clock.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const T0 = new Date("2026-11-04T15:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("the first history load", () => {
  let bank: TestBank;
  // Each First run job the wait started.
  let firstRuns: number;
  const cleanups: (() => void)[] = [];

  // A Connection to a fake bank made at `made`, whose Accounts hold one checking account.
  const connect = async (bankId: string, made: Date) => {
    const id = await addConnection(
      bank.database,
      { provider: "fake", bankId, bankName: `Bank ${bankId}`, origin: "linked", syncMinute: 7 },
      made,
    );
    bank.fake.addPages(bankId, { accounts: [fakeAccount({ id: `${bankId}-checking` })] });
    return id;
  };

  // Adds a page of Transactions to a bank's script: each ID, posted on the given date.
  const page = (bankId: string, ids: string[], historyLoaded: boolean, postedDate = "2026-10-01") =>
    bank.fake.addPages(bankId, {
      added: ids.map((id) =>
        fakeTxn({ id, accountId: `${bankId}-checking`, amount: -1_000, postedDate }),
      ),
      historyLoaded,
    });

  const syncAt = (id: string, when: Date) => syncConnection(id, () => when);
  const endWait = (when: Date) =>
    endHistoryWait(when, async () => {
      firstRuns += 1;
    });

  const notices = async () =>
    (await bank.database.$client.execute("SELECT kind, text FROM system_notices")).rows.map(
      (row) => ({ kind: row.kind, text: row.text }),
    );

  // Each Transaction's provider ID and its "history load" mark.
  const marks = async () =>
    Object.fromEntries(
      (
        await bank.database.$client.execute(
          "SELECT provider_transaction_id, history_load FROM transactions",
        )
      ).rows.map((row) => [row.provider_transaction_id, row.history_load === 1]),
    );

  beforeEach(async () => {
    bank = await newTestBank({ timeZone: "America/New_York" });
    firstRuns = 0;
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    bank.close();
  });

  it("holds back AI until two Connections that load at different times have both loaded", async () => {
    const first = await connect("fake-a", T0);
    const second = await connect("fake-b", T0);
    page("fake-a", ["a1"], false, "2025-05-03");
    page("fake-b", ["b1", "b2"], false, "2025-06-10");

    await syncAt(first, at(MINUTE));
    await syncAt(second, at(MINUTE));
    expect(await aiMayRun(bank.database, at(MINUTE))).toBe(false);
    expect(await historyStatus(bank.database, at(MINUTE))).toEqual({
      waitEnded: false,
      aiMayRun: false,
      loading: expect.arrayContaining([
        {
          connectionId: first,
          bankName: "Bank fake-a",
          transactions: 1,
          oldestDate: "2025-05-03",
          holdsBackAi: true,
        },
        {
          connectionId: second,
          bankName: "Bank fake-b",
          transactions: 2,
          oldestDate: "2025-06-10",
          holdsBackAi: true,
        },
      ]),
    });

    page("fake-a", ["a2"], true);
    await syncAt(first, at(HOUR));
    expect(await aiMayRun(bank.database, at(HOUR))).toBe(false);
    expect(await endWait(at(HOUR))).toBe(false);
    expect((await historyStatus(bank.database, at(HOUR))).loading).toMatchObject([
      { connectionId: second },
    ]);

    page("fake-b", ["b3"], true);
    await syncAt(second, at(3 * HOUR));
    expect(await aiMayRun(bank.database, at(3 * HOUR))).toBe(true);
    expect(await endWait(at(3 * HOUR))).toBe(true);
    expect(firstRuns).toBe(1);
    expect(await historyStatus(bank.database, at(3 * HOUR))).toEqual({
      waitEnded: true,
      aiMayRun: true,
      loading: [],
    });
  });

  it("counts the progress of only the Connections whose history still loads", async () => {
    const loaded = await connect("fake-a", T0);
    const loading = await connect("fake-b", T0);
    page("fake-a", ["a1", "a2"], true, "2024-01-05");
    page("fake-b", ["b1"], false, "2025-06-10");
    await syncAt(loaded, at(MINUTE));
    await syncAt(loading, at(MINUTE));

    // The count reads only the Connections it is given, so a poll never counts a loaded history.
    expect(await historyProgress(bank.database, [loading])).toEqual(
      new Map([[loading, { transactions: 1, oldestDate: "2025-06-10" }]]),
    );
    expect(await historyProgress(bank.database, [])).toEqual(new Map());
    expect((await historyStatus(bank.database, at(MINUTE))).loading).toEqual([
      {
        connectionId: loading,
        bankName: "Bank fake-b",
        transactions: 1,
        oldestDate: "2025-06-10",
        holdsBackAi: true,
      },
    ]);
  });

  it("does not end the wait before any Connection is made", async () => {
    expect(await aiMayRun(bank.database, T0)).toBe(true);
    expect(await endWait(T0)).toBe(false);
    expect(firstRuns).toBe(0);
  });

  it("releases a Connection whose history has not loaded 24 hours after it was made", async () => {
    const loaded = await connect("fake-a", T0);
    const slow = await connect("fake-b", T0);
    page("fake-a", ["a1"], true);
    page("fake-b", ["b1"], false);
    await syncAt(loaded, at(MINUTE));
    await syncAt(slow, at(MINUTE));

    const justBefore = at(24 * HOUR - MINUTE);
    expect(await aiMayRun(bank.database, justBefore)).toBe(false);
    expect(await endWait(justBefore)).toBe(false);

    expect(await aiMayRun(bank.database, at(24 * HOUR))).toBe(true);
    expect(await endWait(at(24 * HOUR))).toBe(true);
    // Its history still loads, but it no longer holds back AI.
    expect((await historyStatus(bank.database, at(24 * HOUR))).loading).toEqual([
      expect.objectContaining({ connectionId: slow, holdsBackAi: false }),
    ]);
  });

  it("releases a Connection as soon as it needs a Member, and for good", async () => {
    const loaded = await connect("fake-a", T0);
    const failing = await connect("fake-b", T0);
    page("fake-a", ["a1"], true);
    page("fake-b", ["b1"], false);
    await syncAt(loaded, at(MINUTE));
    await syncAt(failing, at(MINUTE));
    expect(await aiMayRun(bank.database, at(2 * MINUTE))).toBe(false);

    bank.fake.failAt("fake-b", 2, "needs a member");
    await expect(syncAt(failing, at(HOUR))).rejects.toMatchObject({ kind: "needs a member" });

    expect(await aiMayRun(bank.database, at(HOUR))).toBe(true);

    // Repaired before the wait ends, with its history still loading: it does not hold back AI again.
    await runSyncJob(failing, () => at(2 * HOUR));
    expect((await readConnection(bank.database, failing))?.health).toBe("healthy");
    expect(await aiMayRun(bank.database, at(2 * HOUR))).toBe(true);
    expect(await endWait(at(2 * HOUR))).toBe(true);
  });

  // A held Connection (a duplicate of a bank another Connection covers) and a removed one never
  // sync, so their history never loads. They take no part in the wait, with no 24 hours.
  it("takes no account of a held Connection or a removed one", async () => {
    const loaded = await connect("fake-a", T0);
    const held = await addConnection(
      bank.database,
      {
        provider: "fake",
        bankId: "fake-held",
        bankName: "Bank fake-held",
        origin: "linked",
        syncMinute: 7,
        syncHeld: true,
      },
      T0,
    );
    const removed = await connect("fake-removed", T0);
    page("fake-a", ["a1"], true);
    page("fake-removed", ["r1"], false);
    await syncAt(loaded, at(MINUTE));
    await syncAt(removed, at(MINUTE));
    expect(await aiMayRun(bank.database, at(2 * MINUTE))).toBe(false);

    expect(await markConnectionRemoved(bank.database, removed, at(3 * MINUTE))).toMatchObject({
      removed: true,
    });

    expect(await aiMayRun(bank.database, at(3 * MINUTE))).toBe(true);
    const status = await historyStatus(bank.database, at(3 * MINUTE));
    expect(status.loading).toEqual([]);
    expect(status.aiMayRun).toBe(true);
    expect(await endWait(at(3 * MINUTE))).toBe(true);
    expect((await readConnection(bank.database, held))?.historyLoaded).toBe(false);
  });

  it("does not end the wait when every Connection is held or removed", async () => {
    await addConnection(
      bank.database,
      {
        provider: "fake",
        bankId: "fake-held",
        bankName: "Bank fake-held",
        origin: "linked",
        syncMinute: 7,
        syncHeld: true,
      },
      T0,
    );
    const removed = await connect("fake-removed", T0);
    await markConnectionRemoved(bank.database, removed, T0);

    expect(await aiMayRun(bank.database, at(MINUTE))).toBe(true);
    expect(await endWait(at(MINUTE))).toBe(false);
    expect(firstRuns).toBe(0);
  });

  // Delete history leaves no removed Connection row that holds nothing, such as one whose last
  // Transactions another Connection's history carried.
  it("deletes a removed Connection left holding nothing along with another's history", async () => {
    const kept = await connect("fake-kept", T0);
    const empty = await connect("fake-empty", T0);
    const deleted = await connect("fake-deleted", T0);
    page("fake-kept", ["k1"], true);
    page("fake-deleted", ["d1"], true);
    await syncAt(kept, at(MINUTE));
    await syncAt(deleted, at(MINUTE));
    for (const id of [kept, empty, deleted]) {
      expect(await markConnectionRemoved(bank.database, id, at(HOUR))).toMatchObject({
        removed: true,
      });
    }

    expect(await deleteRemovedConnection(bank.database, deleted, at(2 * HOUR))).toEqual({
      accounts: 1,
      transactions: 1,
    });

    const ids = (await bank.database.$client.execute("SELECT id FROM connections")).rows.map(
      (row) => row.id,
    );
    // The removed Connection with Closed Accounts and their history stays.
    expect(ids).toEqual([kept]);
  });

  it("releases a Connection that becomes Broken", async () => {
    const broken = await connect("fake-a", T0);
    bank.fake.failAt("fake-a", 0, "gone");
    await expect(syncAt(broken, at(MINUTE))).rejects.toMatchObject({ kind: "gone" });

    expect(await aiMayRun(bank.database, at(MINUTE))).toBe(true);
    expect(await endWait(at(MINUTE))).toBe(true);
  });

  it("runs non-AI follow-up steps as data arrives during the wait", async () => {
    const id = await connect("fake-a", T0);
    page("fake-a", ["a1", "a2"], false);
    const handled: number[] = [];
    cleanups.push(
      registerFollowUpStep("matching", async (unhandled) => {
        handled.push(unhandled.length);
      }),
    );

    const report = await syncAt(id, at(MINUTE));
    await runFollowUp(() => at(2 * MINUTE));

    expect(report.changedTransactions).toBe(true);
    expect(await aiMayRun(bank.database, at(2 * MINUTE))).toBe(false);
    expect(handled).toEqual([2]);
  });

  it("ends the wait once: the First run job runs its steps once, in order, then one System notice", async () => {
    const id = await connect("fake-a", T0);
    page("fake-a", ["a1"], true);
    await syncAt(id, at(MINUTE));
    const ran: string[] = [];
    cleanups.push(
      registerFirstRunStep("budget draft", async () => void ran.push("budget draft")),
      registerFirstRunStep("ai first run", async () => void ran.push("ai first run")),
    );

    // Before the wait ends, the First run does nothing.
    await runFirstRun(() => at(MINUTE));
    expect(ran).toEqual([]);

    // Two checks at once, as from two jobs: one ends the wait.
    const ended = await Promise.all([endWait(at(2 * MINUTE)), endWait(at(2 * MINUTE))]);
    expect(ended.sort()).toEqual([false, true]);
    expect(await endWait(at(3 * MINUTE))).toBe(false);
    expect(firstRuns).toBe(1);
    expect((await readHistoryWait(bank.database)).endedAt).toEqual(at(2 * MINUTE));

    // Two runs at once, then a third, such as after a stop: one System notice.
    await Promise.all([runFirstRun(() => at(4 * MINUTE)), runFirstRun(() => at(4 * MINUTE))]);
    await runFirstRun(() => at(5 * MINUTE));

    // Steps run in order. Two runs at once may both run them, as any job may run twice.
    expect([...new Set(ran)]).toEqual(["ai first run", "budget draft"]);
    expect(await notices()).toEqual([{ kind: "event", text: HISTORY_READY }]);
    expect((await readHistoryWait(bank.database)).firstRunDoneAt).toEqual(at(4 * MINUTE));
    expect(HISTORY_READY).toBe("Your history is ready");
  });

  it("starts the First run job again an hour after a lost start, until it is done", async () => {
    const id = await connect("fake-a", T0);
    page("fake-a", ["a1"], true);
    await syncAt(id, at(MINUTE));
    let restarts = 0;
    const restart = async () => {
      restarts += 1;
    };

    // Before the wait ends there is nothing to start again.
    expect(await restartLostFirstRun(at(2 * HOUR), restart)).toBe("none");

    expect(await endWait(at(2 * MINUTE))).toBe(true);
    expect(await restartLostFirstRun(at(HOUR + MINUTE), restart)).toBe("none");
    expect(await restartLostFirstRun(at(HOUR + 2 * MINUTE), restart)).toBe("started again");
    expect(await restartLostFirstRun(at(HOUR + 3 * MINUTE), restart)).toBe("none");
    expect(await restartLostFirstRun(at(2 * HOUR + 2 * MINUTE), restart)).toBe("started again");
    expect(restarts).toBe(2);

    await runFirstRun(() => at(3 * HOUR));
    expect(await restartLostFirstRun(at(9 * HOUR), restart)).toBe("none");
    expect(restarts).toBe(2);
  });

  it("refuses a second step under one name", () => {
    cleanups.push(registerFirstRunStep("budget draft", async () => {}));

    expect(() => registerFirstRunStep("budget draft", async () => {})).toThrow(/already/);
  });

  describe("a bank added later", () => {
    let loadedLater: string[];

    beforeEach(async () => {
      const first = await connect("fake-a", T0);
      page("fake-a", ["a1"], true);
      await syncAt(first, at(MINUTE));
      await endWait(at(2 * MINUTE));
      loadedLater = [];
      cleanups.push(
        registerBankAddedLaterHook(async (connectionId) => void loadedLater.push(connectionId)),
      );
    });

    const hooksStartedAt = async (id: string) =>
      (await readConnection(bank.database, id))?.laterHooksStartedAt;

    it("never holds back AI, and its hooks become due once, when its history loads", async () => {
      const later = await connect("fake-later", at(HOUR));
      page("fake-later", ["l1"], false);

      await syncAt(later, at(HOUR + MINUTE));
      expect(await aiMayRun(bank.database, at(HOUR + MINUTE))).toBe(true);
      expect(await hooksStartedAt(later)).toBeNull();
      expect((await historyStatus(bank.database, at(HOUR + MINUTE))).loading).toEqual([
        expect.objectContaining({ connectionId: later, holdsBackAi: false }),
      ]);

      page("fake-later", ["l2"], true);
      await syncAt(later, at(HOUR + 20 * MINUTE));
      // The sync only marks the hooks due. The bank-added-later job runs them.
      expect(loadedLater).toEqual([]);
      expect(await hooksStartedAt(later)).toEqual(at(HOUR + 20 * MINUTE));
      await runLaterHooks();
      expect(loadedLater).toEqual([later]);
      expect(await hooksStartedAt(later)).toBeNull();

      page("fake-later", ["l3"], true);
      await syncAt(later, at(7 * HOUR));
      await runLaterHooks();
      expect(loadedLater).toEqual([later]);
      // The wait ended once: no second First run.
      expect(await endWait(at(7 * HOUR))).toBe(false);
      expect(firstRuns).toBe(1);
    });

    it("keeps the hooks due when one fails, so the job runs them again", async () => {
      let failing = true;
      cleanups.push(
        registerBankAddedLaterHook(async () => {
          if (failing) throw new Error("The hook failed.");
        }),
      );
      const later = await connect("fake-later", at(HOUR));
      page("fake-later", ["l1"], true);
      await syncAt(later, at(HOUR + MINUTE));

      await expect(runLaterHooks()).rejects.toThrow(/hooks failed/);
      expect(loadedLater).toEqual([later]);
      expect(await hooksStartedAt(later)).not.toBeNull();

      failing = false;
      await runLaterHooks();
      // Every hook runs again, as any job may run twice.
      expect(loadedLater).toEqual([later, later]);
      expect(await hooksStartedAt(later)).toBeNull();
    });

    it("marks the pages a failed sync stored, and makes the hooks due on the retry", async () => {
      const later = await connect("fake-later", at(HOUR));
      page("fake-later", ["l1"], false);
      page("fake-later", ["l2"], true);
      bank.fake.failAt("fake-later", 2, "temporary");

      await expect(syncAt(later, at(HOUR + MINUTE))).rejects.toMatchObject({ kind: "temporary" });
      expect(await marks()).toMatchObject({ l1: true });
      expect(await hooksStartedAt(later)).toBeNull();

      await syncAt(later, at(HOUR + 10 * MINUTE));
      expect(await marks()).toMatchObject({ l1: true, l2: true });
      expect(await hooksStartedAt(later)).toEqual(at(HOUR + 10 * MINUTE));
      await runLaterHooks();
      expect(loadedLater).toEqual([later]);
    });

    it("runs no hook, and starts no job again, for a removed Connection or a held one", async () => {
      const removed = await connect("fake-removed", at(HOUR));
      const held = await connect("fake-held", at(HOUR));
      page("fake-removed", ["r1"], true);
      page("fake-held", ["h1"], true);
      await syncAt(removed, at(HOUR + MINUTE));
      await syncAt(held, at(HOUR + MINUTE));
      expect(await hooksStartedAt(removed)).not.toBeNull();
      expect(await hooksStartedAt(held)).not.toBeNull();
      await markConnectionRemoved(bank.database, removed, at(HOUR + 2 * MINUTE));
      // A held Connection never syncs; this one is held after its hooks became due, to check
      // the filter on its own.
      await bank.database.$client.execute({
        sql: "UPDATE connections SET sync_held = 1 WHERE id = ?",
        args: [held],
      });
      let starts = 0;

      await runLaterHooks();
      expect(
        await restartLostLaterHooks(at(3 * HOUR), async () => {
          starts += 1;
        }),
      ).toBe("none");

      expect(loadedLater).toEqual([]);
      expect(starts).toBe(0);
    });

    it("starts the job again an hour after a lost start", async () => {
      const later = await connect("fake-later", at(HOUR));
      page("fake-later", ["l1"], true);
      await syncAt(later, at(HOUR + MINUTE));
      let starts = 0;
      const start = async () => {
        starts += 1;
      };

      expect(await restartLostLaterHooks(at(2 * HOUR), start)).toBe("none");
      expect(await restartLostLaterHooks(at(2 * HOUR + MINUTE), start)).toBe("started again");
      expect(await restartLostLaterHooks(at(2 * HOUR + 2 * MINUTE), start)).toBe("none");
      expect(starts).toBe(1);

      await runLaterHooks();
      expect(await restartLostLaterHooks(at(9 * HOUR), start)).toBe("none");
      expect(loadedLater).toEqual([later]);
    });

    it("runs the hooks after the follow-up job has handled the new history", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fft-later-hooks-"));
      const jobs = await startJobs({
        jobsDb: join(dir, "jobs.db"),
        jobList: TEST_BANK_JOB_LIST,
        tasks: [],
        database: bank.database,
      });
      const order: string[] = [];
      cleanups.push(
        registerFollowUpStep("matching", async (unhandled) => {
          order.push(`follow-up handles ${unhandled.length}`);
        }),
        registerBankAddedLaterHook(async () => {
          const left = await listUnhandledTransactions(bank.database, "matching");
          order.push(`hook sees ${left.length} unhandled`);
        }),
      );
      try {
        const later = await connect("fake-later", new Date());
        page("fake-later", ["l1", "l2", "l3"], true);

        await startJob(SyncConnectionJob, [later]);

        // Sidequest polls for jobs on real timers.
        for (
          let tries = 0;
          tries < 500 && (order.length < 2 || (await hooksStartedAt(later)) !== null);
          tries += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(await hooksStartedAt(later)).toBeNull();
        // The first bank's one Transaction, and the three of the bank added later.
        expect(order).toEqual(["follow-up handles 4", "hook sees 0 unhandled"]);
      } finally {
        await jobs.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("fires no hook for a Connection made before the wait ended, whose history loads after", async () => {
    const loaded = await connect("fake-a", T0);
    const slow = await connect("fake-b", T0);
    page("fake-a", ["a1"], true);
    page("fake-b", ["b1"], false);
    await syncAt(loaded, at(MINUTE));
    await syncAt(slow, at(MINUTE));
    await endWait(at(24 * HOUR));
    const fired: string[] = [];
    cleanups.push(
      registerBankAddedLaterHook(async (connectionId) => void fired.push(connectionId)),
    );

    page("fake-b", ["b2"], true);
    await syncAt(slow, at(25 * HOUR));
    await runLaterHooks();

    expect((await readConnection(bank.database, slow))?.historyLoaded).toBe(true);
    expect((await readConnection(bank.database, slow))?.laterHooksStartedAt).toBeNull();
    expect(fired).toEqual([]);
  });

  it("marks each Transaction that arrives during a history load, for a bank added later too", async () => {
    const first = await connect("fake-a", T0);
    page("fake-a", ["a1"], false);
    page("fake-a", ["a2"], true);
    await syncAt(first, at(MINUTE));
    page("fake-a", ["a3"], true);
    await syncAt(first, at(HOUR));
    await endWait(at(HOUR));

    const later = await connect("fake-later", at(2 * HOUR));
    page("fake-later", ["l1"], false);
    await syncAt(later, at(2 * HOUR));
    page("fake-later", ["l2"], true);
    await syncAt(later, at(3 * HOUR));
    page("fake-later", ["l3"], true);
    await syncAt(later, at(9 * HOUR));

    // The page that ends a history load is part of it. A Transaction after it is not.
    expect(await marks()).toEqual({
      a1: true,
      a2: true,
      a3: false,
      l1: true,
      l2: true,
      l3: false,
    });
  });

  it("keeps a loaded history loaded when a later page says otherwise", async () => {
    const id = await connect("fake-a", T0);
    page("fake-a", ["a1"], true);
    await syncAt(id, at(MINUTE));
    page("fake-a", ["a2"], false);
    await syncAt(id, at(HOUR));

    expect((await readConnection(bank.database, id))?.historyLoaded).toBe(true);
    expect((await marks()).a2).toBe(false);
  });

  it("ends the wait from the sync job, and the First run job sends the System notice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fft-first-run-"));
    const jobs = await startJobs({
      jobsDb: join(dir, "jobs.db"),
      jobList: TEST_BANK_JOB_LIST,
      tasks: [],
      database: bank.database,
    });
    try {
      const id = await connect("fake-a", new Date());
      page("fake-a", ["a1"], true);

      await startJob(SyncConnectionJob, [id]);

      // Sidequest polls for jobs on real timers.
      for (let tries = 0; tries < 500 && (await notices()).length === 0; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await notices()).toEqual([{ kind: "event", text: HISTORY_READY }]);
      expect((await readHistoryWait(bank.database)).firstRunDoneAt).not.toBeNull();
    } finally {
      await jobs.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ends the wait from the sync schedule's job, for the 24-hour release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fft-first-run-"));
    const jobs = await startJobs({
      jobsDb: join(dir, "jobs.db"),
      jobList: TEST_BANK_JOB_LIST,
      tasks: [],
      database: bank.database,
    });
    try {
      // Made 25 hours ago, with its history still loading. Its next sync is not due, so only the
      // sync schedule's job can end the wait.
      const id = await connect("fake-a", new Date(Date.now() - 25 * HOUR));
      await bank.database.$client.execute({
        sql: "UPDATE connections SET next_sync_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
        args: [id],
      });

      await startJob(SyncScheduleJob, []);

      for (let tries = 0; tries < 500 && (await notices()).length === 0; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await notices()).toEqual([{ kind: "event", text: HISTORY_READY }]);
    } finally {
      await jobs.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
