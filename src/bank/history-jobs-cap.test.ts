import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addConnection, markConnectionRemoved, readConnection } from "../db/index.ts";
import { fakeAccount, fakeTxn } from "./fake.ts";
import {
  endHistoryWait,
  FIRST_RUN_STOPPED_TEXT,
  LATER_HOOKS_STOPPED_TEXT,
  type LostJobOutcome,
  registerBankAddedLaterHook,
  registerFirstRunStep,
  restartLostFirstRun,
  restartLostLaterHooks,
  retryFirstRun,
  retryLaterHooks,
  runFirstRun,
  runLaterHooks,
  syncConnection,
} from "./index.ts";
import { newTestBank, type TestBank } from "./testing.ts";

// The First run job and the bank-added-later job may call the AI, which costs money, so a job
// that keeps failing must stop (spec 08, When AI does not run). Each start gets 3 attempts, a lost
// job starts again at most twice, and then one System notice asks a Member to press Retry.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const T0 = new Date("2026-11-04T15:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const ATTEMPTS = 3;

describe("a history job that keeps failing", () => {
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

  // Every notice, open or closed.
  const notices = async () =>
    (
      await bank.database.$client.execute(
        "SELECT kind, text, closed_at IS NULL AS open FROM system_notices",
      )
    ).rows.map((row) => ({ kind: row.kind, text: row.text, open: row.open === 1 }));

  // The sync schedule's job, once an hour, from `from` hours on, for `hours` hours.
  const hourly = async (
    restart: (now: Date) => Promise<LostJobOutcome>,
    from: number,
    hours: number,
  ) => {
    const outcomes: LostJobOutcome[] = [];
    for (let hour = from; hour < from + hours; hour += 1) {
      outcomes.push(await restart(at(hour * HOUR + 5 * MINUTE)));
    }
    return outcomes;
  };

  beforeEach(async () => {
    bank = await newTestBank({ timeZone: "America/New_York" });
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    bank.close();
  });

  it("stops a First run whose step always fails after two restarts, with one notice", async () => {
    let calls = 0;
    cleanups.push(
      registerFirstRunStep("ai first run", async () => {
        calls += 1;
        throw new Error("The AI's first run failed.");
      }),
    );
    // A start of the First run job: Sidequest's attempts, each of which fails.
    const start = async () => {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        await runFirstRun(() => at(0)).catch(() => {});
      }
    };
    const id = await connect("fake-a", T0);
    await syncConnection(id, () => at(MINUTE));
    expect(await endHistoryWait(at(2 * MINUTE), start)).toBe(true);
    expect(calls).toBe(ATTEMPTS);

    const outcomes = await hourly((now) => restartLostFirstRun(now, start), 1, 12);

    expect(outcomes).toEqual([
      "started again",
      "started again",
      "stopped",
      ...Array(9).fill("none"),
    ]);
    // The first start and two restarts, then no more attempts.
    expect(calls).toBe(3 * ATTEMPTS);
    expect(await notices()).toEqual([
      { kind: "condition", text: FIRST_RUN_STOPPED_TEXT, open: true },
    ]);

    // A Member presses Retry: the notice ends, and the count starts again from 0.
    expect(await retryFirstRun(at(20 * HOUR), start)).toBe(true);
    expect(await retryFirstRun(at(20 * HOUR), start)).toBe(false);
    expect(calls).toBe(4 * ATTEMPTS);
    expect(await notices()).toEqual([
      { kind: "condition", text: FIRST_RUN_STOPPED_TEXT, open: false },
    ]);
    expect(await hourly((now) => restartLostFirstRun(now, start), 21, 4)).toEqual([
      "started again",
      "started again",
      "stopped",
      "none",
    ]);
    expect((await notices()).filter((notice) => notice.open)).toHaveLength(1);
  });

  it("stops a bank added later whose hook always fails after two restarts, with one notice", async () => {
    const first = await connect("fake-a", T0);
    await syncConnection(first, () => at(MINUTE));
    await endHistoryWait(at(2 * MINUTE), async () => {});
    let calls = 0;
    cleanups.push(
      registerBankAddedLaterHook(async () => {
        calls += 1;
        throw new Error("The redraft check failed.");
      }),
    );
    const start = async () => {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        await runLaterHooks().catch(() => {});
      }
    };
    const later = await connect("fake-later", at(HOUR));
    await syncConnection(later, () => at(HOUR));
    await start();

    const outcomes = await hourly((now) => restartLostLaterHooks(now, start), 2, 10);

    expect(outcomes).toEqual([
      "started again",
      "started again",
      "stopped",
      ...Array(7).fill("none"),
    ]);
    expect(calls).toBe(3 * ATTEMPTS);
    expect(await notices()).toEqual([
      { kind: "condition", text: LATER_HOOKS_STOPPED_TEXT, open: true },
    ]);
    // A stopped Connection's hooks do not run along with another bank's.
    await runLaterHooks();
    expect(calls).toBe(3 * ATTEMPTS);

    expect(await retryLaterHooks(at(20 * HOUR), start)).toBe(true);
    expect(await retryLaterHooks(at(20 * HOUR), start)).toBe(false);
    expect(calls).toBe(4 * ATTEMPTS);
    expect((await readConnection(bank.database, later))?.laterHooksRestarts).toBe(0);
    expect((await notices()).filter((notice) => notice.open)).toEqual([]);
  });

  it("Retry starts no job for the stopped hooks of a removed Connection or a held one", async () => {
    const removed = await connect("fake-removed", T0);
    const held = await connect("fake-held", T0);
    for (const id of [removed, held]) {
      await bank.database.$client.execute({
        sql: "UPDATE connections SET later_hooks_started_at = ?, later_hooks_restarts = ? WHERE id = ?",
        args: [T0.toISOString(), ATTEMPTS, id],
      });
    }
    await markConnectionRemoved(bank.database, removed, at(MINUTE));
    await bank.database.$client.execute({
      sql: "UPDATE connections SET sync_held = 1 WHERE id = ?",
      args: [held],
    });
    let starts = 0;

    expect(
      await retryLaterHooks(at(HOUR), async () => {
        starts += 1;
      }),
    ).toBe(false);

    expect(starts).toBe(0);
    for (const id of [removed, held]) {
      expect((await readConnection(bank.database, id))?.laterHooksRestarts).toBe(ATTEMPTS);
    }
  });
});
