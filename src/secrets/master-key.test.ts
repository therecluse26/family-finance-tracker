import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, closeDatabase, type Database, openDatabase } from "../db/index.ts";
import { createLogger } from "../log.ts";
import {
  DEFAULT_MASTER_KEY_FILE,
  loadMasterKey,
  type MasterKey,
  MasterKeyError,
  unlockSecrets,
} from "./index.ts";
import { newMasterKeyHex } from "./testing.ts";

const SHIPPED_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function captureLogger(throwOnSecretField = true) {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line), { throwOnSecretField });
  return { logger, lines, logged: () => lines.map((line) => JSON.parse(line)) };
}

// Values that are not 32 bytes written as 64 hexadecimal characters, made from a new key.
const MALFORMED: [string, (hex: string) => string][] = [
  ["one character short", (hex) => hex.slice(1)],
  ["one character long", (hex) => `${hex}0`],
  ["a letter that is not hexadecimal", (hex) => `${hex.slice(0, 40)}g${hex.slice(41)}`],
  ["a space inside", (hex) => `${hex.slice(0, 32)} ${hex.slice(32)}`],
  ["the 32 bytes in base64", (hex) => Buffer.from(hex, "hex").toString("base64")],
];

describe("loading the Master key", () => {
  let dir: string;
  let file: string;
  let opened: Database[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fft-master-key-"));
    file = join(dir, "master.key");
    opened = [];
  });

  afterEach(() => {
    for (const database of opened) closeDatabase(database);
    rmSync(dir, { recursive: true, force: true });
  });

  // Whether the loaded key is the one written as `hex`, by the module's own check.
  async function isKey(masterKey: MasterKey, hex: string): Promise<boolean> {
    const database = await openDatabase(`file:${join(dir, `app-${opened.length}.db`)}`);
    opened.push(database);
    await applyMigrations(database, SHIPPED_FOLDER);
    const secrets = await unlockSecrets(database, masterKey, { logger: captureLogger().logger });
    return secrets.checkMasterKey(hex);
  }

  it("reads the file named by FFT_MASTER_KEY_FILE", async () => {
    const hex = newMasterKeyHex();
    writeFileSync(file, hex);
    const { logger, logged } = captureLogger();

    const masterKey = await loadMasterKey({ FFT_MASTER_KEY_FILE: file }, { logger });

    expect(await isKey(masterKey, hex)).toBe(true);
    expect(logged()).toEqual([
      expect.objectContaining({ level: "info", msg: "Loaded the Master key", from: file }),
    ]);
  });

  it("reads the file, not FFT_MASTER_KEY, when both are there", async () => {
    const inFile = newMasterKeyHex();
    const inEnv = newMasterKeyHex();
    writeFileSync(file, inFile);

    const masterKey = await loadMasterKey(
      { FFT_MASTER_KEY_FILE: file, FFT_MASTER_KEY: inEnv },
      { logger: captureLogger().logger },
    );

    expect(await isKey(masterKey, inFile)).toBe(true);
    expect(await isKey(masterKey, inEnv)).toBe(false);
  });

  it("reads FFT_MASTER_KEY when the file is missing", async () => {
    const hex = newMasterKeyHex();
    const { logger, logged } = captureLogger();

    const masterKey = await loadMasterKey(
      { FFT_MASTER_KEY_FILE: file, FFT_MASTER_KEY: hex },
      { logger },
    );

    expect(await isKey(masterKey, hex)).toBe(true);
    expect(logged()).toEqual([
      expect.objectContaining({ msg: "Loaded the Master key", from: "FFT_MASTER_KEY" }),
    ]);
  });

  it.each([
    ["the key", () => newMasterKeyHex()],
    ["a value that is not a key", () => "not-a-key"],
  ])(
    "deletes FFT_MASTER_KEY from the environment it read when it holds %s",
    async (_case, value) => {
      const env = { FFT_MASTER_KEY_FILE: file, FFT_MASTER_KEY: value() };

      await loadMasterKey(env, { logger: captureLogger().logger }).catch(() => undefined);

      expect(env).toEqual({ FFT_MASTER_KEY_FILE: file });
    },
  );

  it("deletes FFT_MASTER_KEY from the environment when it reads the file instead", async () => {
    writeFileSync(file, newMasterKeyHex());
    const env = { FFT_MASTER_KEY_FILE: file, FFT_MASTER_KEY: newMasterKeyHex() };

    await loadMasterKey(env, { logger: captureLogger().logger });

    expect(env).toEqual({ FFT_MASTER_KEY_FILE: file });
  });

  it("ignores the line break that ends the file and spaces around the key, in any letter case", async () => {
    const hex = newMasterKeyHex();
    writeFileSync(file, `  ${hex.toUpperCase()}\r\n`);

    const masterKey = await loadMasterKey(
      { FFT_MASTER_KEY_FILE: file },
      { logger: captureLogger().logger },
    );

    expect(await isKey(masterKey, hex)).toBe(true);
  });

  it.each(MALFORMED)(
    "stops the start when the file holds %s, and never logs it",
    async (_case, written) => {
      const value = written(newMasterKeyHex());
      writeFileSync(file, value);
      const { logger, lines } = captureLogger();

      const loading = loadMasterKey({ FFT_MASTER_KEY_FILE: file }, { logger });

      await expect(loading).rejects.toThrow(MasterKeyError);
      await expect(loading).rejects.toThrow(
        `The Master key in ${file} is not 32 bytes written as 64 hexadecimal characters.`,
      );
      await expect(loading).rejects.not.toThrow(value);
      expect(lines).toEqual([]);
    },
  );

  it.each(MALFORMED)(
    "stops the start when FFT_MASTER_KEY holds %s, and never logs it",
    async (_case, written) => {
      const value = written(newMasterKeyHex());
      const { logger, lines } = captureLogger();

      const loading = loadMasterKey(
        { FFT_MASTER_KEY_FILE: file, FFT_MASTER_KEY: value },
        { logger },
      );

      await expect(loading).rejects.toThrow(
        "The Master key in FFT_MASTER_KEY is not 32 bytes written as 64 hexadecimal characters.",
      );
      await expect(loading).rejects.not.toThrow(value);
      expect(lines).toEqual([]);
    },
  );

  it("stops the start on an empty file, even when FFT_MASTER_KEY holds a key", async () => {
    writeFileSync(file, "");

    await expect(
      loadMasterKey({ FFT_MASTER_KEY_FILE: file, FFT_MASTER_KEY: newMasterKeyHex() }),
    ).rejects.toThrow(`The Master key in ${file} is not 32 bytes`);
  });

  it.each([
    ["FFT_MASTER_KEY is not set", undefined],
    ["FFT_MASTER_KEY is empty", ""],
    ["FFT_MASTER_KEY holds only spaces and line breaks", "  \n"],
  ])("says `fft setup` must run first when the file is missing and %s", async (_case, value) => {
    await expect(
      loadMasterKey({ FFT_MASTER_KEY_FILE: file, FFT_MASTER_KEY: value }),
    ).rejects.toThrow(
      new MasterKeyError(
        `There is no Master key: ${file} is missing, and FFT_MASTER_KEY is not set. Run \`fft setup\` first.`,
      ),
    );
  });

  it("stops the start when the file cannot be read, and never reads FFT_MASTER_KEY then", async () => {
    mkdirSync(file);

    await expect(
      loadMasterKey({ FFT_MASTER_KEY_FILE: file, FFT_MASTER_KEY: newMasterKeyHex() }),
    ).rejects.toThrow(new MasterKeyError(`The Master key file ${file} cannot be read (EISDIR).`));
  });

  it.skipIf(existsSync(DEFAULT_MASTER_KEY_FILE))(
    "reads /run/secrets/master.key when FFT_MASTER_KEY_FILE is not set",
    async () => {
      await expect(loadMasterKey({})).rejects.toThrow(
        "There is no Master key: /run/secrets/master.key is missing",
      );
    },
  );

  it("makes the logger refuse the Master key from then on, in any letter case", async () => {
    const hex = newMasterKeyHex();
    const { logger, lines } = captureLogger(false);
    logger.info("Before", { note: hex });

    await loadMasterKey({ FFT_MASTER_KEY_FILE: file, FFT_MASTER_KEY: hex }, { logger });
    logger.info("After", { lower: hex, upper: hex.toUpperCase(), inText: `key=${hex}` });

    expect(lines[0]).toContain(hex);
    expect(lines.slice(1).join("")).not.toMatch(new RegExp(hex, "i"));
  });
});
