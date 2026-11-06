import { holdsSecretValue } from "../log.ts";
import type { FftIo } from "./io.ts";
import { resetLogin } from "./reset-login.ts";
import { restore } from "./restore.ts";
import { setup } from "./setup.ts";

// The `fft` command (spec 12, The `fft` command). The self-hoster runs it as
// `docker compose run --rm app fft <command>`, as its own short-lived process.

const USAGE = [
  "Usage: fft <command>",
  "",
  "Commands:",
  "  setup                  Make the Master key, and print the one-use setup link",
  "  setup --app-url <url>  Print a new Master key and the setup link for <url>, for a platform",
  "                         service. It writes no file.",
  "  reset-login <email>    Reset the login of the Member with this email, and print the",
  "                         one-use reset link",
  "  restore <file>         Restore a backup of app.db, while the app is stopped. A bare file",
  "                         name means a file in the backup folder.",
  "",
].join("\n");

// Runs one command and returns its exit code. A failure prints its reason, unless the reason holds
// a secret value.
export async function runFft(args: string[], io: FftIo): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === "setup") return await setup(rest, io);
    if (command === "reset-login") return await resetLogin(rest, io);
    if (command === "restore") return await restore(rest, io);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    io.err(`fft ${command} failed: ${holdsSecretValue(reason) ? "[refused]" : reason}\n`);
    return 1;
  }
  io.err(USAGE);
  return 2;
}
