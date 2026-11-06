import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addConnection, readConnection } from "../db/index.ts";
import { fakeAccount } from "./fake.ts";
import {
  catchUpSyncs,
  connectionRepairing,
  runSyncJob,
  startDueSyncs,
  syncConnection,
  syncNow,
} from "./index.ts";
import { newTestBank, type TestBank } from "./testing.ts";

// A held Connection never syncs (a duplicate of a bank another Connection covers), so its credential is never decrypted,
// on every path that starts a sync: the schedule, the start-up catch-up, Sync now, update mode,
// and the end of update mode. Each test runs the sync job of each Connection a path starts, as
// Sidequest would, and records every decrypt of a Connection's credential. A Connection that syncs
// may be decrypted more than once. The credentials are made up when the test runs.

const T0 = new Date("2026-11-04T15:00:00.000Z");
const CHECKING = fakeAccount({ id: "acc-checking", name: "Everyday Checking" });

describe("a held Connection's credential", () => {
  let bank: TestBank;
  let held: string;
  let open: string;
  // The Connection of each sync job a path started, in order.
  let started: string[];
  // The Connection of each credential decrypted, in order.
  let decrypted: string[];

  const runJob = async (connectionId: string) => {
    started.push(connectionId);
    await runSyncJob(connectionId, () => T0);
  };

  const connect = (bankId: string, syncHeld: boolean) =>
    addConnection(
      bank.database,
      {
        provider: "fake",
        bankId,
        bankName: `Bank ${bankId}`,
        origin: "linked",
        syncMinute: 7,
        sealCredential: (rowId) =>
          bank.secrets.encrypt(`fake-credential-${crypto.randomUUID()}`, {
            rowId,
            column: "connections.credential",
          }),
        syncHeld,
      },
      T0,
    );

  beforeEach(async () => {
    bank = await newTestBank();
    bank.fake.actions = { repairInApp: true, importExisting: false, refresh: true };
    held = await connect("fake-held", true);
    open = await connect("fake-open", false);
    for (const bankId of ["fake-held", "fake-open"]) {
      bank.fake.addPages(bankId, { accounts: [CHECKING], historyLoaded: true });
    }
    started = [];
    decrypted = [];
    const decrypt = bank.secrets.decrypt.bind(bank.secrets);
    vi.spyOn(bank.secrets, "decrypt").mockImplementation((ciphertext, place) => {
      if (place.column === "connections.credential") decrypted.push(String(place.rowId));
      return decrypt(ciphertext, place);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    bank.close();
  });

  it("is never decrypted by the sync schedule, which starts no job for it", async () => {
    expect(await startDueSyncs(T0, runJob)).toEqual([open]);

    expect(started).toEqual([open]);
    expect(new Set(decrypted)).toEqual(new Set([open]));
    expect(new Set(bank.fake.calls.map((call) => call.connectionId))).toEqual(new Set([open]));
  });

  it("is never decrypted by the start-up catch-up, which leaves its next sync time alone", async () => {
    await catchUpSyncs(T0, runJob);

    expect(started).toEqual([open]);
    expect(new Set(decrypted)).toEqual(new Set([open]));
    expect((await readConnection(bank.database, held))?.nextSyncAt).toBeNull();
  });

  it("is never decrypted by Sync now, with no Refresh and no sync", async () => {
    const results = await syncNow(T0, runJob);

    expect(results.map((result) => result.connectionId)).toEqual([open]);
    expect(bank.fake.refreshes).toEqual([open]);
    expect(started).toEqual([open, open]);
    expect(new Set(decrypted)).toEqual(new Set([open]));
  });

  it("is never decrypted by Repair or Add accounts", async () => {
    const repairing = connectionRepairing();

    expect(await repairing.startRepair(held)).toEqual({ outcome: "held" });
    expect(await repairing.startAddAccounts(held)).toEqual({ outcome: "held" });
    expect(decrypted).toEqual([]);
    expect(bank.fake.repairs).toEqual([]);

    // The same request for a Connection that is not held decrypts its credential.
    expect(await repairing.startAddAccounts(open)).toMatchObject({ outcome: "ready" });
    expect(decrypted).toEqual([open]);
  });

  it("is never decrypted when update mode finishes, which starts no sync", async () => {
    expect(await connectionRepairing().finishUpdate(held, T0)).toEqual({ outcome: "held" });

    expect(bank.syncsStarted).toEqual([]);
    expect(decrypted).toEqual([]);
  });

  it("is never decrypted by its sync job, or by a sync, which both check the hold first", async () => {
    expect(await runSyncJob(held, () => T0)).toBe("not polled");
    expect(await syncConnection(held, () => T0)).toMatchObject({
      added: 0,
      changedTransactions: false,
    });

    expect(decrypted).toEqual([]);
    expect(bank.fake.calls).toEqual([]);
  });

  // A job started before the hold was set finds the Connection held when it runs.
  it("is never decrypted by a job that a path started before the hold was set", async () => {
    await bank.database.$client.execute({
      sql: "UPDATE connections SET sync_held = 1 WHERE id = ?",
      args: [open],
    });

    expect(await runSyncJob(open, () => T0)).toBe("not polled");
    expect(await syncConnection(open, () => T0)).toMatchObject({ added: 0 });
    expect(decrypted).toEqual([]);
  });
});
