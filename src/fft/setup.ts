import { existsSync } from "node:fs";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { closeDatabase, hasMember, openDatabase } from "../db/index.ts";
import {
  findMasterKey,
  type MasterKey,
  makeMasterKey,
  masterKeyFile,
  setupCodeOf,
} from "../secrets/index.ts";
import { type AppUrl, parseAppUrl } from "../server/app-url.ts";
import type { FftIo } from "./io.ts";

// `fft setup` and `fft setup --app-url <url>` (spec 12, The `fft` command). The Master key and the
// setup link go to the terminal only, never to the app's log.

const KEEP_A_COPY =
  "Keep a copy of the Master key off this server, such as in a password manager. Without it, " +
  "every Connection must be made again.";

const KEEP_THE_FILE_PRIVATE =
  "Keep the Master key file readable only by the app's user (mode 0600).";

// The setup link: APP_URL's /setup page, with the code after "#", so the browser never sends it.
function linkLines(appUrl: AppUrl, masterKey: MasterKey): string[] {
  return [
    "Open this setup link to make the first Member. It stops working once the first Member exists:",
    `  ${appUrl.address("/setup")}#code=${setupCodeOf(masterKey)}`,
  ];
}

// Whether app.db holds a Member. Before the app's first start, app.db does not exist, and
// `fft setup` does not make it.
async function memberExists(databaseFile: string): Promise<boolean> {
  if (!existsSync(databaseFile)) return false;
  const database = await openDatabase(`file:${databaseFile}`);
  try {
    return await hasMember(database);
  } finally {
    closeDatabase(database);
  }
}

// Writes a new Master key with mode 0600. It never replaces a file that exists. `fft restore` also
// prints the key it returns, once.
export async function writeMasterKey(file: string): Promise<{ hex: string; masterKey: MasterKey }> {
  const made = makeMasterKey();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${made.hex}\n`, { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
  return made;
}

// A warning when users other than the file's owner can read or change the Master key file.
async function fileModeWarning(file: string): Promise<string[]> {
  const { mode } = await stat(file);
  if ((mode & 0o077) === 0) return [];
  const shown = (mode & 0o777).toString(8).padStart(4, "0");
  return [`Warning: ${file} has mode ${shown}, so other users can read it. Run: chmod 600 ${file}`];
}

// `fft setup --app-url <url>`, for a platform service. It runs on the self-hoster's own computer,
// prints a new Master key and the setup link for <url>, and writes no file.
function setupForPlatform(url: string, io: FftIo): number {
  const appUrl = parseAppUrl(url);
  const { hex, masterKey } = makeMasterKey();
  io.out(
    [
      "A new Master key. Paste it into the platform's secrets, as a secret file if the platform",
      "has them, or else as FFT_MASTER_KEY:",
      `  ${hex}`,
      "",
      KEEP_A_COPY,
      "",
      ...linkLines(appUrl, masterKey),
      "",
    ].join("\n"),
  );
  return 0;
}

export async function setup(args: string[], io: FftIo): Promise<number> {
  const [flag, url, ...rest] = args;
  if (flag === "--app-url" && url !== undefined && rest.length === 0) {
    return setupForPlatform(url, io);
  }
  if (args.length > 0) {
    io.err("Usage: fft setup [--app-url <url>]\n");
    return 2;
  }

  if ((io.env.APP_URL ?? "").trim() === "") {
    io.err(
      "APP_URL is not set. fft setup needs it for the setup link. Add APP_URL to .env, such as " +
        "APP_URL=https://money.example.com, then run fft setup again.\n",
    );
    return 1;
  }
  const appUrl = parseAppUrl(io.env.APP_URL);
  const file = masterKeyFile(io.env);
  const found = await findMasterKey(io.env);

  if (await memberExists(io.databaseFile)) {
    const lines = ["Setup is done: the first Member exists. fft setup changed nothing."];
    if (found === undefined) {
      lines.push(
        "",
        `There is no Master key: ${file} is missing, and FFT_MASTER_KEY is not set.`,
        "Follow the setup guide's steps for a lost Master key, in docs/self-hosting.md.",
      );
    }
    io.out(`${lines.join("\n")}\n`);
    return 0;
  }

  if (found === undefined) {
    const { masterKey } = await writeMasterKey(file);
    io.out(
      [
        `Made the Master key in ${file}.`,
        "",
        KEEP_THE_FILE_PRIVATE,
        KEEP_A_COPY,
        "",
        ...linkLines(appUrl, masterKey),
        "",
      ].join("\n"),
    );
    return 0;
  }

  const fromFile = found.from === file;
  io.out(
    [
      `The Master key is in ${found.from}. No Member exists yet, so setup is not done.`,
      ...(fromFile ? await fileModeWarning(file) : []),
      "",
      ...(fromFile ? [KEEP_THE_FILE_PRIVATE] : []),
      KEEP_A_COPY,
      "",
      ...linkLines(appUrl, found.masterKey),
      "",
    ].join("\n"),
  );
  return 0;
}
