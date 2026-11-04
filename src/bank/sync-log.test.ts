import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSyncState } from "../db/index.ts";
import type * as LogModule from "../log.ts";
import { registerSecretValue } from "../log.ts";
import { newMasterKeyHex } from "../secrets/testing.ts";
import { BankDataError, type BankErrorKind } from "./adapter.ts";
import { runSyncJob } from "./sync.ts";
import { newTestBank, type TestBank } from "./testing.ts";

// What the sync job logs when a sync or a daily check fails (spec 02, Error kinds; T06 logging).
// The app logger here runs as in production: it refuses a secret instead of throwing, so the test
// sees every line it would write.

const written = vi.hoisted((): string[] => []);
vi.mock("../log.ts", async (original) => {
  const actual = await original<typeof LogModule>();
  return {
    ...actual,
    log: actual.createLogger((line) => written.push(line), { throwOnSecretField: false }),
  };
});

const BANK = "fake-first-bank";
const AT = new Date("2026-11-04T11:30:00.000Z");

type Line = { level: string; msg: string; refused?: string[]; [field: string]: unknown };

describe("the sync job's log", () => {
  let bank: TestBank;
  let id: string;
  // The Connection's credential, made for this test run and stored encrypted, as a Plaid access
  // token is.
  let secret: string;

  // An error that holds the credential in its message and in its fields, as a provider client's
  // error can.
  const leakyError = (kind: BankErrorKind | "unsorted") => {
    const message = `The bank refused the access token ${secret}`;
    const error = kind === "unsorted" ? new Error(message) : new BankDataError(kind, message);
    return Object.assign(error, {
      request: { headers: { "plaid-access-token": secret }, body: `{"access_token":"${secret}"}` },
      accessToken: secret,
    });
  };

  const lines = (): Line[] => written.map((line) => JSON.parse(line) as Line);

  const expectNoSecret = () => {
    for (const line of written) expect(line).not.toContain(secret);
    // Only the error's own text is refused, never a field the job added.
    for (const line of lines()) {
      for (const path of line.refused ?? []) expect(path).toMatch(/^error\./);
    }
  };

  beforeEach(async () => {
    written.length = 0;
    bank = await newTestBank({ timeZone: "America/New_York" });
    id = await bank.connect(BANK);
    secret = `fake-access-${newMasterKeyHex().slice(0, 24)}`;
    registerSecretValue(secret);
    const credential = bank.secrets.encrypt(secret, {
      rowId: id,
      column: "connections.credential",
    });
    await bank.database.$client.execute({
      sql: "UPDATE connections SET credential = ? WHERE id = ?",
      args: [credential, id],
    });
  });

  afterEach(() => {
    bank.close();
  });

  it("logs a failed sync with its kind, and never the secret its error holds", async () => {
    bank.fake.failAt(BANK, 0, leakyError("temporary"));

    expect(await runSyncJob(id, () => AT)).toBe("failed");

    expect(lines()).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "A sync failed",
        connectionId: id,
        kind: "temporary",
      }),
    );
    expectNoSecret();
  });

  it.each([
    ["needs a member", "needs a member"],
    // An error the adapter did not sort, such as a bug in its check, counts as Temporary.
    ["unsorted", "temporary"],
  ] as const)(
    "logs a failed daily check (%s) with its kind, and never the secret its error holds",
    async (thrown, kind) => {
      await saveSyncState(bank.database, id, { health: "needs a member", nextSyncAt: null });
      bank.fake.setCheckError(id, leakyError(thrown));

      expect(await runSyncJob(id, () => AT)).toBe("still needs a member");

      expect(bank.fake.checks).toEqual([id]);
      expect(lines()).toContainEqual(
        expect.objectContaining({
          level: "warn",
          msg: "A Connection's check failed",
          connectionId: id,
          kind,
        }),
      );
      expectNoSecret();
    },
  );
});
