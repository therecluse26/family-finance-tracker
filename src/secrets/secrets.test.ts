import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  closeDatabase,
  type Database,
  openDatabase,
  readDataKeys,
  storeDataKey,
} from "../db/index.ts";
import { createLogger } from "../log.ts";
import {
  checkDataKey,
  type MasterKey,
  SecretDecryptError,
  type SecretPlace,
  type Secrets,
  unlockSecrets,
  WrongMasterKeyError,
} from "./index.ts";
import { newMasterKey } from "./testing.ts";

const SHIPPED_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

const PLACE: SecretPlace = { rowId: 1, column: "connections.access_token" };
const DATA_KEY_COLUMN = "data_keys.encrypted_key";

function captureLogger(throwOnSecretField = true) {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line), { throwOnSecretField });
  return { logger, lines, logged: () => lines.map((line) => JSON.parse(line)) };
}

let made = 0;

// A new value for each test, so no test sees a value that another registered with the logger.
function newValue(): string {
  made += 1;
  return `plaid-sandbox-${made}-${randomBytes(8).toString("hex")}`;
}

// The rest of this file reads ciphertexts with node:crypto alone, as spec 09 describes them:
// AES-256-GCM, a 96-bit IV, and the AAD of the row ID and column name.
const additionalData = (place: SecretPlace) =>
  Buffer.from(JSON.stringify([place.column, String(place.rowId)]));

function gcmDecrypt(key: Buffer, sealed: string, place: SecretPlace): Buffer {
  const [iv = "", body = "", tag = ""] = sealed.split(".");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), {
    authTagLength: 16,
  });
  decipher.setAAD(additionalData(place));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]);
}

function gcmEncrypt(key: Buffer, value: string, place: SecretPlace): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(additionalData(place));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, body, cipher.getAuthTag()].map((part) => part.toString("base64url")).join(".");
}

// Flips one bit of the IV, the ciphertext, or the tag, and writes the ciphertext again.
function flipBit(ciphertext: string, bit: number): string {
  const [keyId, ...parts] = ciphertext.split(".");
  const bytes = Buffer.concat(parts.map((part) => Buffer.from(part, "base64url")));
  bytes[bit >> 3] = (bytes[bit >> 3] ?? 0) ^ (1 << (bit & 7));
  const sizes = parts.map((part) => Buffer.from(part, "base64url").length);
  const ivEnd = sizes[0] ?? 0;
  const bodyEnd = ivEnd + (sizes[1] ?? 0);
  const changed = [
    bytes.subarray(0, ivEnd),
    bytes.subarray(ivEnd, bodyEnd),
    bytes.subarray(bodyEnd),
  ];
  return [keyId, ...changed.map((part) => part.toString("base64url"))].join(".");
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function nextBase64urlCharacter(character = "A"): string {
  return BASE64URL[BASE64URL.indexOf(character) + 1] ?? "A";
}

describe("the secrets module", () => {
  let dir: string;
  let opened: Database[];
  let database: Database;
  let hex: string;
  let masterKey: MasterKey;
  let secrets: Secrets;
  let log: ReturnType<typeof captureLogger>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "fft-secrets-"));
    opened = [];
    ({ hex, masterKey } = newMasterKey());
    log = captureLogger();
    database = await migratedDatabase("app.db");
    secrets = await unlockSecrets(database, masterKey, { logger: log.logger });
  });

  afterEach(() => {
    for (const each of opened) closeDatabase(each);
    rmSync(dir, { recursive: true, force: true });
  });

  async function newDatabase(name: string): Promise<Database> {
    const created = await openDatabase(`file:${join(dir, name)}`);
    opened.push(created);
    return created;
  }

  async function migratedDatabase(name: string): Promise<Database> {
    const created = await newDatabase(name);
    await applyMigrations(created, SHIPPED_FOLDER);
    return created;
  }

  // The data key, read from app.db with the Master key and node:crypto alone.
  async function storedDataKey(): Promise<{ id: string; key: Buffer }> {
    const [row, ...others] = await readDataKeys(database);
    if (row === undefined || others.length > 0) throw new Error("app.db must hold one data key");
    const place = { rowId: row.id, column: DATA_KEY_COLUMN };
    return { id: row.id, key: gcmDecrypt(Buffer.from(hex, "hex"), row.encryptedKey, place) };
  }

  // Every byte of app.db as a copy of its files would hold them.
  function copiedFiles(): string {
    const path = join(dir, "app.db");
    const files = [path, `${path}-wal`].filter((file) => existsSync(file));
    return Buffer.concat(files.map((file) => readFileSync(file))).toString("latin1");
  }

  // The ways a value of raw bytes could be written in a file.
  const writtenForms = (bytes: Buffer) => [
    bytes.toString("latin1"),
    bytes.toString("hex"),
    bytes.toString("base64"),
    bytes.toString("base64url"),
  ];

  describe("the data key", () => {
    it("is one random 256-bit key, made at the first start and encrypted with the Master key using AES-256-GCM", async () => {
      const [row] = await readDataKeys(database);
      const { id, key } = await storedDataKey();
      const [iv = ""] = row?.encryptedKey.split(".") ?? [];

      expect(key).toHaveLength(32);
      expect(Buffer.from(iv, "base64url")).toHaveLength(12);
      expect(log.logged()).toEqual([
        expect.objectContaining({ level: "info", msg: "Made the data key", keyId: id }),
      ]);
    });

    it("stays the same on every later start", async () => {
      const before = await readDataKeys(database);
      const ciphertext = secrets.encrypt("household-value", PLACE);

      const again = await unlockSecrets(database, masterKey, { logger: log.logger });

      expect(await readDataKeys(database)).toEqual(before);
      expect(again.decrypt(ciphertext, PLACE)).toBe("household-value");
    });

    it("is new for each app.db", async () => {
      const other = await migratedDatabase("other.db");
      await unlockSecrets(other, masterKey, { logger: log.logger });
      const [mine] = await readDataKeys(database);
      const [theirs] = await readDataKeys(other);
      const first = await storedDataKey();
      const otherKey = gcmDecrypt(Buffer.from(hex, "hex"), theirs?.encryptedKey ?? "", {
        rowId: theirs?.id ?? "",
        column: DATA_KEY_COLUMN,
      });

      expect(theirs?.id).not.toBe(mine?.id);
      expect(otherKey.equals(first.key)).toBe(false);
    });

    it("never appears in a copy of app.db, and neither does the Master key", async () => {
      const { key } = await storedDataKey();
      const files = copiedFiles();

      for (const form of [...writtenForms(key), ...writtenForms(Buffer.from(hex, "hex"))]) {
        expect(files).not.toContain(form);
      }
    });

    it("stops the start with another Master key, and changes nothing", async () => {
      const before = await readDataKeys(database);
      const wrong = newMasterKey().masterKey;

      await expect(checkDataKey(database, wrong)).rejects.toThrow(WrongMasterKeyError);
      await expect(unlockSecrets(database, wrong, { logger: log.logger })).rejects.toThrow(
        "The Master key cannot decrypt the data key in app.db",
      );
      expect(await readDataKeys(database)).toEqual(before);
      expect(log.logged()).toHaveLength(1);
    });

    it("passes the check with its own Master key, and before app.db has one", async () => {
      const fresh = await newDatabase("fresh.db");

      await expect(checkDataKey(database, masterKey)).resolves.toBeUndefined();
      await expect(checkDataKey(fresh, masterKey)).resolves.toBeUndefined();
      expect(await readDataKeys(fresh)).toEqual([]);
    });

    it("fails to decrypt when moved to another row", async () => {
      const [row] = await readDataKeys(database);
      const other = await migratedDatabase("moved.db");
      await storeDataKey(other, { id: "0badc0de", encryptedKey: row?.encryptedKey ?? "" });

      await expect(unlockSecrets(other, masterKey)).rejects.toThrow(WrongMasterKeyError);
    });

    it("is one per app.db", async () => {
      await storeDataKey(database, { id: "0badc0de", encryptedKey: "x" });

      await expect(unlockSecrets(database, masterKey)).rejects.toThrow(
        "app.db holds 2 data keys, but this version of the app uses one.",
      );
    });
  });

  describe("encrypt and decrypt", () => {
    it.each([
      ["a token", "access-sandbox-value"],
      ["an empty value", ""],
      ["letters outside ASCII", "pässwörd ✓ 鍵"],
      ["a long value", "k".repeat(10_000)],
    ])("give back %s", (_kind, value) => {
      expect(secrets.decrypt(secrets.encrypt(value, PLACE), PLACE)).toBe(value);
    });

    it("start each ciphertext with the key ID, then a new random 96-bit IV, the ciphertext, and the tag", async () => {
      const { id } = await storedDataKey();
      const first = secrets.encrypt("same-value", PLACE).split(".");
      const second = secrets.encrypt("same-value", PLACE).split(".");

      expect(first).toHaveLength(4);
      expect(first[0]).toBe(id);
      expect(Buffer.from(first[1] ?? "", "base64url")).toHaveLength(12);
      expect(Buffer.from(first[3] ?? "", "base64url")).toHaveLength(16);
      expect(second[1]).not.toBe(first[1]);
      expect(second[2]).not.toBe(first[2]);
    });

    it("use AES-256-GCM with the data key, and the row ID and column name as the AAD", async () => {
      const { id, key } = await storedDataKey();
      const ciphertext = secrets.encrypt("household-value", PLACE);
      const made = `${id}.${gcmEncrypt(key, "made-elsewhere", PLACE)}`;

      expect(gcmDecrypt(key, ciphertext.slice(id.length + 1), PLACE).toString()).toBe(
        "household-value",
      );
      expect(secrets.decrypt(made, PLACE)).toBe("made-elsewhere");
    });

    it("fail after a row swap", () => {
      const first = { rowId: 1, column: PLACE.column };
      const second = { rowId: 2, column: PLACE.column };
      const forFirst = secrets.encrypt("first-token", first);
      const forSecond = secrets.encrypt("second-token", second);

      expect(() => secrets.decrypt(forFirst, second)).toThrow(SecretDecryptError);
      expect(() => secrets.decrypt(forSecond, first)).toThrow(SecretDecryptError);
    });

    it("fail after a column swap", () => {
      const plaid = { rowId: 1, column: "settings.plaid_secret" };
      const smtp = { rowId: 1, column: "settings.smtp_password" };
      const forPlaid = secrets.encrypt("plaid-value", plaid);
      const forSmtp = secrets.encrypt("smtp-value", smtp);

      expect(() => secrets.decrypt(forPlaid, smtp)).toThrow(SecretDecryptError);
      expect(() => secrets.decrypt(forSmtp, plaid)).toThrow(SecretDecryptError);
    });

    it("fail after any flipped bit in the IV, the ciphertext, or the tag", () => {
      const ciphertext = secrets.encrypt("flip-me", PLACE);
      const bits = (12 + "flip-me".length + 16) * 8;

      for (let bit = 0; bit < bits; bit += 1) {
        expect(() => secrets.decrypt(flipBit(ciphertext, bit), PLACE), `bit ${bit}`).toThrow(
          SecretDecryptError,
        );
      }
      expect(secrets.decrypt(ciphertext, PLACE)).toBe("flip-me");
    });

    it.each<[string, (ciphertext: string) => string]>([
      ["another key ID", (text) => text.replace(/^[^.]+/, "0badc0de")],
      ["no key ID", (text) => text.slice(text.indexOf(".") + 1)],
      ["a part missing", (text) => text.slice(0, text.lastIndexOf("."))],
      ["an extra part", (text) => `${text}.AA`],
      // The tag's last character ends in 4 bits that decoding drops, so this decodes to the same tag.
      [
        "a tag that is not written as base64url writes it",
        (text) => `${text.slice(0, -1)}${nextBase64urlCharacter(text.at(-1))}`,
      ],
      ["nothing", () => ""],
    ])("fail on a ciphertext with %s", (_kind, change) => {
      const ciphertext = secrets.encrypt("household-value", PLACE);

      expect(() => secrets.decrypt(change(ciphertext), PLACE)).toThrow(
        new SecretDecryptError(
          "The secret in connections.access_token of row 1 does not decrypt. It was moved, changed, or made with another data key.",
        ),
      );
    });

    it("fail with another app.db's data key", async () => {
      const other = await migratedDatabase("other.db");
      const theirs = await unlockSecrets(other, masterKey, { logger: log.logger });

      expect(() => theirs.decrypt(secrets.encrypt("household-value", PLACE), PLACE)).toThrow(
        SecretDecryptError,
      );
    });

    it("treat a row ID given as a number or as text as the same row", () => {
      const ciphertext = secrets.encrypt("household-value", { rowId: 7, column: PLACE.column });

      expect(secrets.decrypt(ciphertext, { rowId: "7", column: PLACE.column })).toBe(
        "household-value",
      );
    });

    it.each([
      ["no column", { rowId: 1, column: "" }],
      ["no row ID", { rowId: "", column: PLACE.column }],
    ])("refuse a place with %s", (_kind, place) => {
      expect(() => secrets.encrypt("household-value", place)).toThrow(TypeError);
    });
  });

  describe("the logger", () => {
    it("refuses a value once it is decrypted", async () => {
      const { id, key } = await storedDataKey();
      const value = newValue();
      const ciphertext = `${id}.${gcmEncrypt(key, value, PLACE)}`;
      const { logger, lines } = captureLogger(false);
      logger.info("Before", { note: value });

      secrets.decrypt(ciphertext, PLACE);
      logger.info("After", { note: value, url: new URL(`https://bank.example.com/?t=${value}`) });

      expect(lines[0]).toContain(value);
      expect(lines.slice(1).join("")).not.toContain(value);
    });

    it("refuses a value once it is encrypted", () => {
      const value = newValue();
      const { logger, lines } = captureLogger(false);
      logger.info("Before", { note: value });

      secrets.encrypt(value, PLACE);
      logger.info("After", { connections: new Map([[value, "c1"]]) });

      expect(lines[0]).toContain(value);
      expect(lines.slice(1).join("")).not.toContain(value);
    });

    it("gets no line that holds the Master key, the data key, or a secret", async () => {
      const value = newValue();
      secrets.decrypt(secrets.encrypt(value, PLACE), PLACE);
      const { key } = await storedDataKey();
      const text = log.lines.join("");

      for (const form of [hex, hex.toUpperCase(), ...writtenForms(key).slice(1), value]) {
        expect(text).not.toContain(form);
      }
    });
  });

  describe("derive", () => {
    it("returns HKDF-SHA256 from the Master key, with one label for each use", () => {
      const expected = (info: string) =>
        Buffer.from(hkdfSync("sha256", Buffer.from(hex, "hex"), Buffer.alloc(0), info, 32));

      expect(secrets.derive("setup code")).toEqual(expected("family-finance-tracker setup code"));
      expect(secrets.derive("login signing secret")).toEqual(
        expected("family-finance-tracker login signing secret"),
      );
      expect(secrets.derive("setup code")).not.toEqual(secrets.derive("login signing secret"));
    });

    it("gives each Master key its own values", async () => {
      const other = newMasterKey().masterKey;
      const theirs = await unlockSecrets(await migratedDatabase("other.db"), other, {
        logger: log.logger,
      });

      expect(theirs.derive("setup code")).not.toEqual(secrets.derive("setup code"));
    });

    it("makes the value again on each call, and stores none", () => {
      const first = secrets.derive("login signing secret");
      const value = Buffer.from(first);
      first.fill(0);

      expect(secrets.derive("login signing secret")).toEqual(value);
      for (const form of writtenForms(value)) expect(copiedFiles()).not.toContain(form);
    });
  });

  describe("checkMasterKey", () => {
    const spaced = (text: string, every: number, gap: string) =>
      text.match(new RegExp(`.{1,${every}}`, "g"))?.join(gap) ?? text;

    it.each<[string, (key: string) => string]>([
      ["as written", (key) => key],
      ["in upper case", (key) => key.toUpperCase()],
      [
        "in mixed case",
        (key) => spaced(key, 2, "").replace(/(.)(.)/g, (_m, a, b) => a + b.toUpperCase()),
      ],
      ["with spaces every 4 characters", (key) => spaced(key, 4, " ")],
      ["with a line break every 16 characters", (key) => spaced(key, 16, "\n")],
      ["with Windows line breaks", (key) => spaced(key, 32, "\r\n")],
      ["with spaces and a line break around it", (key) => `  ${key}\n`],
    ])("matches the Master key %s", (_kind, pasted) => {
      expect(secrets.checkMasterKey(pasted(hex))).toBe(true);
    });

    it.each<[string, (key: string) => string]>([
      ["another key", () => newMasterKey().hex],
      ["one character short", (key) => key.slice(1)],
      ["one character long", (key) => `${key}0`],
      ["one character changed", (key) => `${key.slice(0, -1)}${key.endsWith("0") ? "1" : "0"}`],
      ["a letter that is not hexadecimal", (key) => `${key.slice(0, -1)}g`],
      ["nothing", () => ""],
    ])("does not match %s", (_kind, pasted) => {
      expect(secrets.checkMasterKey(pasted(hex))).toBe(false);
    });
  });
});
