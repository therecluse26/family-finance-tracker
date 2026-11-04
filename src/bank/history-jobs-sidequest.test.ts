import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addConnection, readConnection } from "../db/index.ts";
import { listJobAttempts, startJob, startJobs } from "../jobs/index.ts";
import { fakeAccount, fakeTxn } from "./fake.ts";
import {
  endHistoryWait,
  FirstRunJob,
  registerBankAddedLaterHook,
  registerFirstRunStep,
  syncConnection,
} from "./index.ts";
import {
  BankAddedLaterJob,
  newTestBank,
  SyncConnectionJob,
  TEST_BANK_JOB_LIST,
  type TestBank,
} from "./testing.ts";

// The cap on the First run job and the bank-added-later job (src/bank/history-jobs-cap.test.ts),
// on real Sidequest jobs. It has a file of its own: better-sqlite3, under Sidequest, can crash a
// test worker as it exits when other tests ran in the same worker first.

const HOUR = 60 * 60 * 1000;
const ATTEMPTS = 3;

describe("history jobs on real Sidequest jobs", () => {
  let bank: TestBank;
  const cleanups: (() => void)[] = [];

  const connect = async (bankId: string, made: Date) => {
    const id = await addConnection(
      bank.database,
      { provider: "fake", bankId, bankName: `Bank ${bankId}`, origin: "linked", syncMinute: 7 },
      made,
    );
    bank.fake.addPages(bankId, {
      accounts: [fakeAccount({ id: `${bankId}-checking` })],
      added: [fakeTxn({ id: `${bankId}-1`, accountId: `${bankId}-checking`, amount: -1_000 })],
      historyLoaded: true,
    });
    return id;
  };

  beforeEach(async () => {
    bank = await newTestBank({ timeZone: "America/New_York" });
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    bank.close();
  });

  it("gives each history job 3 attempts in Sidequest, and starts the hook job only from the sync that made its hooks due", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fft-history-jobs-cap-"));
    const jobs = await startJobs({
      jobsDb: join(dir, "jobs.db"),
      jobList: TEST_BANK_JOB_LIST,
      tasks: [],
      database: bank.database,
    });
    let firstRunCalls = 0;
    let hookCalls = 0;
    cleanups.push(
      registerFirstRunStep("ai first run", async () => {
        firstRunCalls += 1;
        throw new Error("The AI's first run failed.");
      }),
      registerBankAddedLaterHook(async () => {
        hookCalls += 1;
        throw new Error("The redraft check failed.");
      }),
    );
    // Sidequest runs jobs on real timers, and retries with a growing delay.
    const settled = async () => {
      const all = [
        ...(await listJobAttempts(FirstRunJob)),
        ...(await listJobAttempts(SyncConnectionJob)),
        ...(await listJobAttempts(BankAddedLaterJob)),
      ];
      return (
        all.length > 0 && all.every((job) => job.state === "completed" || job.state === "failed")
      );
    };
    const waitUntilSettled = async () => {
      for (let tries = 0; tries < 300 && hookCalls <= ATTEMPTS && !(await settled()); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    try {
      const first = await connect("fake-a", new Date(Date.now() - 2 * HOUR));
      await syncConnection(first);

      // The real start of the First run job: 3 attempts, then it is failed for good.
      expect(await endHistoryWait(new Date(Date.now() - HOUR))).toBe(true);
      await waitUntilSettled();
      expect(await listJobAttempts(FirstRunJob)).toEqual([
        { state: "failed", attempt: ATTEMPTS, maxAttempts: ATTEMPTS },
      ]);
      expect(firstRunCalls).toBe(ATTEMPTS);

      // The sync that loads a bank added later's history makes its hooks due and starts their job.
      const later = await connect("fake-later", new Date());
      await startJob(SyncConnectionJob, [later]);
      await waitUntilSettled();
      expect(hookCalls).toBe(ATTEMPTS);

      // More syncs, such as Sync now presses, start no new job before the hourly restart.
      for (let press = 0; press < 3; press += 1) {
        await startJob(SyncConnectionJob, [later]);
        await waitUntilSettled();
      }
      expect(await listJobAttempts(SyncConnectionJob)).toHaveLength(4);
      expect(await listJobAttempts(BankAddedLaterJob)).toEqual([
        { state: "failed", attempt: ATTEMPTS, maxAttempts: ATTEMPTS },
      ]);
      expect(hookCalls).toBe(ATTEMPTS);
      expect(firstRunCalls).toBe(ATTEMPTS);
      expect((await readConnection(bank.database, later))?.laterHooksRestarts).toBe(0);
    } finally {
      await jobs.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
