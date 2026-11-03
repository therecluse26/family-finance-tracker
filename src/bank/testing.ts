// Test support: app.db with the bank module running on the fake adapter, and a job list that holds
// the sync job. No test uses a real Bank-data provider or real bank data.
import { addConnection, type Database } from "../db/index.ts";
import { newTestDatabase } from "../db/testing.ts";
import { createLogger } from "../log.ts";
import { type Secrets, unlockSecrets } from "../secrets/index.ts";
import { newMasterKey } from "../secrets/testing.ts";
import { FakeBankAdapter } from "./fake.ts";
import type { PlaidClientMaker, PlaidKeysClient } from "./plaid-keys.ts";
import type { PlaidKeys } from "./plaid-view.ts";
import { startBank } from "./sync.ts";

export { TickJob } from "../jobs/sidequest.ts";
export { SyncConnectionJob } from "./job.ts";

export const TEST_BANK_JOB_LIST = import.meta.url;

export type TestBank = {
  database: Database;
  secrets: Secrets;
  fake: FakeBankAdapter;
  // A new Connection to a fake bank, with no sync yet.
  connect(bankId: string, bankName?: string): Promise<string>;
  close(): void;
};

export async function newTestBank(options: { timeZone?: string } = {}): Promise<TestBank> {
  const db = await newTestDatabase();
  const quiet = createLogger(() => {}, { throwOnSecretField: true });
  const secrets = await unlockSecrets(db.database, newMasterKey().masterKey, { logger: quiet });
  const fake = new FakeBankAdapter();
  const bank = startBank({
    database: db.database,
    secrets,
    adapters: [fake],
    timeZone: async () => options.timeZone,
  });
  return {
    database: db.database,
    secrets,
    fake,
    connect: (bankId, bankName = `Fake bank ${bankId}`) =>
      addConnection(db.database, {
        provider: "fake",
        bankId,
        bankName,
        origin: "linked",
        syncMinute: 7,
      }),
    close() {
      bank.stop();
      db.close();
    },
  };
}

// Made-up Plaid keys in the form Plaid's dashboard shows, made when the test runs. Never real keys.
export function newPlaidKeys(): PlaidKeys {
  const hex = (bytes: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  return { clientId: hex(12), secret: hex(15) };
}

// A stub of Plaid's client, so no test calls Plaid. It accepts only the keys in `accepted`, and
// refuses others as Plaid does. Each error holds the request's headers, keys included, as the real
// client's error does.
export class StubPlaid {
  accepted: PlaidKeys | undefined;
  // True to answer as when Plaid cannot be reached.
  down = false;
  readonly calls: { keys: PlaidKeys; request: unknown }[] = [];

  readonly makeClient: PlaidClientMaker = (keys) => {
    const institutionsGet = async (request: unknown) => {
      this.calls.push({ keys, request });
      const config = { headers: { "PLAID-CLIENT-ID": keys.clientId, "PLAID-SECRET": keys.secret } };
      if (this.down) throw Object.assign(new Error("connect ETIMEDOUT"), { config });
      const { accepted } = this;
      if (accepted?.clientId !== keys.clientId || accepted.secret !== keys.secret) {
        throw Object.assign(new Error("Request failed with status code 400"), {
          config,
          response: {
            status: 400,
            data: { error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS" },
          },
        });
      }
      return { status: 200, data: { institutions: [], total: 0 } };
    };
    return { institutionsGet } as unknown as PlaidKeysClient;
  };
}
