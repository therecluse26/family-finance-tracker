import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { countWaitingJobs, startJob, startJobs } from "../jobs/index.ts";
import { waitFor } from "../jobs/testing.ts";
import {
  FOLLOW_UP_STEPS,
  type FollowUpStep,
  type FollowUpStepName,
  registerFollowUpStep,
  requestFollowUp,
  runFollowUp,
} from "./index.ts";
import {
  FollowUpJob,
  MarkJob,
  SyncConnectionJob,
  TEST_FOLLOW_UP_JOB_LIST,
  waitingAtMarks,
} from "./testing.ts";

// The follow-up pipeline after a sync (spec 10, The follow-up pipeline; spec 02, After a sync), on
// Transactions the fake adapter synced.

const CHECKING = fakeAccount({ id: "acc-checking", name: "Everyday Checking" });

const txn = (id: string, amount = -1_000) => fakeTxn({ id, accountId: CHECKING.id, amount });

describe("the follow-up pipeline", () => {
  let bank: TestBank;
  let unregister: (() => void)[];
  // Each step run, in order, with the provider IDs it was given.
  let runs: { step: FollowUpStepName; given: string[] }[];

  // Provider IDs, so tests can name Transactions as the fake bank does.
  const providerIds = async (ids: readonly string[]) => {
    const rows = await bank.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row.provider_transaction_id]));
    return ids.map((id) => String(byId.get(id))).sort();
  };

  // Registers a step that records its run. `work` decides what it does; by default it handles all.
  const register = (step: FollowUpStepName, work?: FollowUpStep) => {
    unregister.push(
      registerFollowUpStep(step, async (unhandled) => {
        runs.push({ step, given: await providerIds(unhandled) });
        return work?.(unhandled);
      }),
    );
  };

  const syncedConnection = async (bankId: string, ...ids: string[]) => {
    const connectionId = await bank.connect(bankId);
    bank.fake.addPages(bankId, { accounts: [CHECKING], added: ids.map((id) => txn(id)) });
    await syncConnection(connectionId);
    return connectionId;
  };

  beforeEach(async () => {
    bank = await newTestBank();
    unregister = [];
    runs = [];
  });

  afterEach(() => {
    for (const remove of unregister) remove();
    bank.close();
  });

  describe("one run", () => {
    it("runs the steps in order, each on every Transaction it has not handled", async () => {
      for (const step of [...FOLLOW_UP_STEPS].reverse()) register(step);
      await syncedConnection("fake-a", "t1", "t2", "t3");

      expect(await runFollowUp()).toBeUndefined();

      expect(runs).toEqual(FOLLOW_UP_STEPS.map((step) => ({ step, given: ["t1", "t2", "t3"] })));
      runs = [];
      await runFollowUp();
      expect(runs).toEqual([]);
    });

    it("skips a step that no ticket registered", async () => {
      register("matching");
      register("alerts");
      await syncedConnection("fake-a", "t1");

      await runFollowUp();

      expect(runs.map((run) => run.step)).toEqual(["matching", "alerts"]);
    });

    it("stops at a step that asks for a new job, and the next run picks up what it left", async () => {
      const again = new Date("2026-11-03T15:00:00.000Z");
      let first: string[] = [];
      register("matching", async (unhandled) => {
        if (first.length > 0) return undefined;
        first = await providerIds(unhandled.slice(0, 1));
        return { handled: unhandled.slice(0, 1), again };
      });
      register("categorization");
      await syncedConnection("fake-a", "t1", "t2", "t3");

      expect(await runFollowUp()).toEqual({ stoppedAt: "matching", again });
      expect(runs).toEqual([{ step: "matching", given: ["t1", "t2", "t3"] }]);

      runs = [];
      expect(await runFollowUp()).toBeUndefined();
      expect(runs).toEqual([
        { step: "matching", given: ["t1", "t2", "t3"].filter((id) => !first.includes(id)) },
        { step: "categorization", given: ["t1", "t2", "t3"] },
      ]);
    });

    it("marks only Transactions the step was given", async () => {
      register("matching", async () => ({ handled: ["no-such-id"], again: new Date() }));
      await syncedConnection("fake-a", "t1");

      await runFollowUp();

      const marks = await bank.database.$client.execute("SELECT * FROM follow_up_marks");
      expect(marks.rows).toEqual([]);
    });

    it("hands every step a changed or removed Transaction again", async () => {
      for (const step of FOLLOW_UP_STEPS) register(step);
      const connectionId = await syncedConnection("fake-a", "t1", "t2", "t3");
      await runFollowUp();
      runs = [];

      bank.fake.addPages("fake-a", { changed: [txn("t1", -2_500)], removed: [{ id: "t2" }] });
      await syncConnection(connectionId);
      await runFollowUp();

      expect(runs).toEqual(FOLLOW_UP_STEPS.map((step) => ({ step, given: ["t1", "t2"] })));
    });

    it("refuses a step registered twice", () => {
      register("matching");
      expect(() => registerFollowUpStep("matching", async () => undefined)).toThrow(
        "already registered",
      );
    });
  });

  describe("the follow-up job", () => {
    let dir: string;
    let stop: () => Promise<void>;

    // Starts a job, then MarkJob after it, and waits for MarkJob. Returns the follow-up jobs that
    // waited when it ran.
    const runThenMark = async (...jobs: (() => Promise<void>)[]) => {
      for (const start of jobs) {
        await start();
        // Jobs run oldest first by their start time, in milliseconds.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const marks = waitingAtMarks.length;
      await startJob(MarkJob, []);
      await waitFor(() => waitingAtMarks.length > marks);
      return waitingAtMarks.at(-1);
    };

    const sync = (connectionId: string) => () => startJob(SyncConnectionJob, [connectionId]);

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "fft-follow-up-jobs-"));
      const jobs = await startJobs({
        jobsDb: join(dir, "jobs.db"),
        jobList: TEST_FOLLOW_UP_JOB_LIST,
        tasks: [],
        database: bank.database,
      });
      stop = jobs.stop;
    });

    afterEach(async () => {
      await stop();
      rmSync(dir, { recursive: true, force: true });
    });

    it("starts after a changing sync, and runs the steps in order", async () => {
      for (const step of FOLLOW_UP_STEPS) register(step);
      const connectionId = await bank.connect("fake-a");
      bank.fake.addPages("fake-a", { accounts: [CHECKING], added: [txn("t1"), txn("t2")] });

      await startJob(SyncConnectionJob, [connectionId]);

      await waitFor(() => runs.length === FOLLOW_UP_STEPS.length);
      expect(runs).toEqual(FOLLOW_UP_STEPS.map((step) => ({ step, given: ["t1", "t2"] })));
    });

    it("starts one job after a sync that stored changed Transactions, then failed", async () => {
      register("matching");
      const connectionId = await bank.connect("fake-a");
      // Page 0 adds t1, then the call for the next page fails. The sync job's retry finds t1
      // already stored, so it counts no change and starts no follow-up job of its own.
      bank.fake.addPages("fake-a", { accounts: [CHECKING], added: [txn("t1")] });
      bank.fake.failAt("fake-a", 1, "temporary");

      await startJob(SyncConnectionJob, [connectionId]);

      await waitFor(() => runs.length > 0);
      expect(runs).toEqual([{ step: "matching", given: ["t1"] }]);
      expect(await countWaitingJobs(FollowUpJob)).toBe(0);
    });

    it("starts no job after a sync with no changes", async () => {
      register("insight card check");
      const connectionId = await syncedConnection("fake-a", "t1");
      bank.fake.calls.length = 0;

      expect(await runThenMark(sync(connectionId))).toBe(0);

      expect(bank.fake.calls).toHaveLength(1);
      expect(runs).toEqual([]);
    });

    it("leaves one waiting job after two syncs while a job waits", async () => {
      register("matching");
      const first = await bank.connect("fake-a");
      const second = await bank.connect("fake-b");
      bank.fake.addPages("fake-a", { accounts: [CHECKING], added: [txn("a1")] });
      bank.fake.addPages("fake-b", { accounts: [CHECKING], added: [txn("b1")] });
      const later = new Date(Date.now() + 60 * 60 * 1000);

      expect(await requestFollowUp({ at: later })).toBe(true);
      expect(await runThenMark(sync(first), sync(second))).toBe(1);

      const synced = await bank.database.$client.execute(
        "SELECT id FROM connections WHERE sync_cursor IS NOT NULL",
      );
      expect(synced.rows).toHaveLength(2);
      expect(await requestFollowUp()).toBe(false);
      expect(await countWaitingJobs(FollowUpJob)).toBe(1);
      expect(runs).toEqual([]);
    });

    it("starts one job from two requests at once", async () => {
      const later = new Date(Date.now() + 60 * 60 * 1000);

      const started = await Promise.all([
        requestFollowUp({ at: later }),
        requestFollowUp({ at: later }),
      ]);

      expect(started.sort()).toEqual([false, true]);
      expect(await countWaitingJobs(FollowUpJob)).toBe(1);
    });

    it("starts a new job at the time a stopping step asks for, which picks up what it left", async () => {
      let first: string[] = [];
      register("matching", async (unhandled) => {
        if (first.length > 0) return undefined;
        first = await providerIds(unhandled.slice(0, 1));
        return { handled: unhandled.slice(0, 1), again: new Date(Date.now() + 200) };
      });
      register("categorization");
      const connectionId = await bank.connect("fake-a");
      bank.fake.addPages("fake-a", { accounts: [CHECKING], added: [txn("t1"), txn("t2")] });

      await startJob(SyncConnectionJob, [connectionId]);

      await waitFor(() => runs.length === 3);
      expect(runs).toEqual([
        { step: "matching", given: ["t1", "t2"] },
        { step: "matching", given: ["t1", "t2"].filter((id) => !first.includes(id)) },
        { step: "categorization", given: ["t1", "t2"] },
      ]);
    });
  });
});
