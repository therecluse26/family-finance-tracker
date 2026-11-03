// Test support: app.db with the bank module running on the fake adapter, and a job list that holds
// the sync job. No test uses a real Bank-data provider or real bank data.
import { addConnection, type Database } from "../db/index.ts";
import { newTestDatabase } from "../db/testing.ts";
import { createLogger } from "../log.ts";
import { type Secrets, unlockSecrets } from "../secrets/index.ts";
import { newMasterKey } from "../secrets/testing.ts";
import { FakeBankAdapter } from "./fake.ts";
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

export async function newTestBank(): Promise<TestBank> {
  const db = await newTestDatabase();
  const quiet = createLogger(() => {}, { throwOnSecretField: true });
  const secrets = await unlockSecrets(db.database, newMasterKey().masterKey, { logger: quiet });
  const fake = new FakeBankAdapter();
  const bank = startBank({ database: db.database, secrets, adapters: [fake] });
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
