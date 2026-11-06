// The entry point of the `fft` command in the image: dist/fft.js, which /usr/local/bin/fft runs.
import { fileURLToPath } from "node:url";
import { APP_DB_URL } from "../db/index.ts";
import { runFft } from "./fft.ts";

const code = await runFft(process.argv.slice(2), {
  env: process.env,
  databaseFile: APP_DB_URL.replace(/^file:/, ""),
  // As the app's own start finds them, next to dist.
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
process.exitCode = code;
