// `pnpm seed:demo`: loads the demo Household into the dev app.db in .dev/, which `pnpm dev` uses,
// through the fake adapter. It is a dev script only: it is not an `fft` command, it is not in the
// image, and no screen offers the fake provider. It needs the Master key that `pnpm dev` uses,
// from FFT_MASTER_KEY_FILE or FFT_MASTER_KEY. It adds no Member: sign in with the first Member
// that `fft setup` made.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { seedDemoHousehold } from "../src/bank/demo.ts";
import { FakeBankAdapter } from "../src/bank/fake.ts";
import { startBank } from "../src/bank/index.ts";
import { applyMigrations, closeDatabase, listAccounts, openDatabase } from "../src/db/index.ts";
import { checkDataKey, loadMasterKey, unlockSecrets } from "../src/secrets/index.ts";

const DEV_FOLDER = fileURLToPath(new URL("../.dev", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../drizzle", import.meta.url));

const masterKey = await loadMasterKey(process.env);
mkdirSync(DEV_FOLDER, { recursive: true });
const database = await openDatabase(`file:${DEV_FOLDER}/app.db`);
try {
  await checkDataKey(database, masterKey);
  await applyMigrations(database, MIGRATIONS);
  const secrets = await unlockSecrets(database, masterKey);
  const fake = new FakeBankAdapter();
  const bank = startBank({ database, secrets, adapters: [fake] });
  try {
    await seedDemoHousehold(database, fake);
  } finally {
    bank.stop();
  }
  const accounts = await listAccounts(database);
  console.log(`Loaded the demo Household into ${DEV_FOLDER}/app.db: ${accounts.length} Accounts.`);
} finally {
  closeDatabase(database);
}
