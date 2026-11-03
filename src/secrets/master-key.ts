import { createSecretKey, type KeyObject, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type Logger, log, registerSecretValue } from "../log.ts";

export const DEFAULT_MASTER_KEY_FILE = "/run/secrets/master.key";

// 32 bytes written as 64 hexadecimal characters.
export const MASTER_KEY_HEX = /^[0-9a-f]{64}$/i;

// The loaded Master key. Only the secrets module reads the key inside.
export type MasterKey = { readonly key: KeyObject };

// The Master key is missing, cannot be read, or is not 64 hexadecimal characters.
export class MasterKeyError extends Error {
  override name = "MasterKeyError";
}

export type MasterKeyEnv = { FFT_MASTER_KEY_FILE?: string; FFT_MASTER_KEY?: string };

// The file that holds the Master key: FFT_MASTER_KEY_FILE, or the default.
export function masterKeyFile(env: MasterKeyEnv): string {
  return env.FFT_MASTER_KEY_FILE || DEFAULT_MASTER_KEY_FILE;
}

// Reads the file named by FFT_MASTER_KEY_FILE, or FFT_MASTER_KEY when that file is missing.
// Undefined when neither holds a key. Throws with the reason for a key that cannot be used.
// Deletes FFT_MASTER_KEY from `env`, so a job or child process that gets process.env never sees
// the key.
export async function findMasterKey(
  env: MasterKeyEnv,
): Promise<{ masterKey: MasterKey; from: string } | undefined> {
  const fromEnv = env.FFT_MASTER_KEY ?? "";
  delete env.FFT_MASTER_KEY;
  const file = masterKeyFile(env);
  const written = await readKeyFile(file);
  if (written !== undefined) {
    return { masterKey: parseMasterKey(written, `The Master key in ${file}`), from: file };
  }
  if (fromEnv.trim() === "") return undefined;
  const masterKey = parseMasterKey(fromEnv, "The Master key in FFT_MASTER_KEY");
  return { masterKey, from: "FFT_MASTER_KEY" };
}

// Startup step 1. Throws with the reason when the app must not start.
export async function loadMasterKey(
  env: MasterKeyEnv,
  options: { logger?: Logger } = {},
): Promise<MasterKey> {
  const logger = options.logger ?? log;
  const found = await findMasterKey(env);
  if (found === undefined) {
    throw new MasterKeyError(
      `There is no Master key: ${masterKeyFile(env)} is missing, and FFT_MASTER_KEY is not set. Run \`fft setup\` first.`,
    );
  }
  logger.info("Loaded the Master key", { from: found.from });
  return found.masterKey;
}

// A new Master key, for `fft setup`: 32 random bytes, and the key written as 64 hexadecimal
// characters. The logger refuses it from now on.
export function makeMasterKey(): { hex: string; masterKey: MasterKey } {
  const hex = randomBytes(32).toString("hex");
  return { hex, masterKey: parseMasterKey(hex, "The new Master key") };
}

// Undefined when the file is missing. Any other failure stops the start.
async function readKeyFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new MasterKeyError(`The Master key file ${file} cannot be read (${code ?? "unknown"}).`);
  }
}

// Ignores spaces and line breaks around the key, such as the line break that ends a file. The
// logger refuses the key from now on.
export function parseMasterKey(written: string, where: string): MasterKey {
  const hex = written.trim();
  if (!MASTER_KEY_HEX.test(hex)) {
    throw new MasterKeyError(
      `${where} is not 32 bytes written as 64 hexadecimal characters. Use the key that \`fft setup\` made.`,
    );
  }
  for (const form of [hex, hex.toLowerCase(), hex.toUpperCase()]) registerSecretValue(form);
  const bytes = Buffer.from(hex, "hex");
  const key = createSecretKey(bytes);
  bytes.fill(0);
  return { key };
}
