import { existsSync } from "node:fs";
import { createAuth } from "../auth/index.ts";
import { checkMigrations, closeDatabase, findMemberIdByEmail, openDatabase } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { checkDataKey, findMasterKey, masterKeyFile, unlockSecrets } from "../secrets/index.ts";
import { parseAppUrl } from "../server/app-url.ts";
import type { FftIo } from "./io.ts";

// `fft reset-login <email>` (spec 12, The `fft` command), the last resort when no Member can sign
// in. It makes the same reset as "Reset login" in Settings, Members (spec 09, Login reset), and
// prints the link to this terminal only, never to the app's log. It works while the app runs:
// app.db is in WAL mode with a busy timeout, the reset is one transaction, and the app keeps no
// session or login in memory.

const USAGE = "Usage: fft reset-login <email>\n";

export async function resetLogin(args: string[], io: FftIo): Promise<number> {
  const [email, ...rest] = args;
  if (email === undefined || email.trim() === "" || rest.length > 0) {
    io.err(USAGE);
    return 2;
  }
  if ((io.env.APP_URL ?? "").trim() === "") {
    io.err(
      "APP_URL is not set. fft reset-login needs it for the reset link. Add APP_URL to .env, " +
        "such as APP_URL=https://money.example.com, then run fft reset-login again.\n",
    );
    return 1;
  }
  const appUrl = parseAppUrl(io.env.APP_URL);
  const found = await findMasterKey(io.env);
  if (found === undefined) {
    io.err(
      `There is no Master key: ${masterKeyFile(io.env)} is missing, and FFT_MASTER_KEY is not ` +
        "set. fft reset-login needs the Master key the app runs with.\n",
    );
    return 1;
  }
  if (!existsSync(io.databaseFile)) {
    io.err("No Member has this email address.\n");
    return 1;
  }

  const database = await openDatabase(`file:${io.databaseFile}`);
  try {
    const check = await checkMigrations(database, io.migrationsFolder);
    if (check.pending > 0 || check.newer > 0 || check.skipped > 0) {
      io.err(
        "app.db was written by a different version of the app. Start the app with this version " +
          "once, then run fft reset-login again.\n",
      );
      return 1;
    }
    const memberId = await findMemberIdByEmail(database, email);
    if (memberId === undefined) {
      io.err("No Member has this email address.\n");
      return 1;
    }
    // Reads only, so a wrong Master key changes nothing.
    await checkDataKey(database, found.masterKey);
    // Every line this command logs goes to stderr, apart from the link on stdout.
    const logger = createLogger(io.err, { throwOnSecretField: false });
    const secrets = await unlockSecrets(database, found.masterKey, { logger });
    const auth = createAuth({ database, secrets, appOrigin: appUrl.origin, logger });
    const reset = await auth.resetLogin(memberId, new Date());
    if (reset === undefined) {
      io.err("No Member has this email address.\n");
      return 1;
    }
    io.out(
      [
        "The Member's sessions ended, and their password, TOTP, and backup codes no longer work.",
        "Give them this reset link. It works once, for 24 hours, and sets a new login:",
        `  ${appUrl.address("/reset")}#token=${reset.token}`,
        "",
      ].join("\n"),
    );
    return 0;
  } finally {
    closeDatabase(database);
  }
}
