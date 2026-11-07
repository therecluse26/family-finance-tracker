// `pnpm seed:demo`: loads the demo Household into the dev app.db in .dev/, which `pnpm dev` uses,
// through the fake adapter. It is a dev script only: it is not an `fft` command, and it is not in
// the image. It uses the Master key that `pnpm dev` uses: .dev/master.key, or the key set in
// FFT_MASTER_KEY_FILE or FFT_MASTER_KEY. It adds no Member: sign in with the first Member, made
// from the setup link that `pnpm dev` prints.
import { seedDemoHousehold } from "../src/bank/demo.ts";
import { FakeBankAdapter } from "../src/bank/fake.ts";
import { startBank } from "../src/bank/index.ts";
import { closeDatabase, listAccounts } from "../src/db/index.ts";
import { unlockSecrets } from "../src/secrets/index.ts";
import { DEV_FOLDER, openDevDatabase } from "../src/server/dev-app.ts";

const { masterKey, database } = await openDevDatabase(process.env, DEV_FOLDER);
try {
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
