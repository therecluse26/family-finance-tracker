import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  hkdfSync,
  type KeyObject,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { type Database, readDataKeys, type StoredDataKey, storeDataKey } from "../db/index.ts";
import { type Logger, log, registerSecretValue } from "../log.ts";
import { MASTER_KEY_HEX, type MasterKey } from "./master-key.ts";

const CIPHER = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_BYTES = 4;

// Where a ciphertext is stored. The AAD binds the ciphertext to it, so it fails to decrypt
// anywhere else. Name the column with its table, such as "connections.access_token".
export type SecretPlace = { rowId: string | number; column: string };

// One label for each use of a value derived from the Master key (spec 09, The Master key).
export type DerivedUse = "setup code" | "login signing secret";

export type Secrets = {
  // Returns the key ID, then the IV, the ciphertext, and the tag in base64url, joined by dots.
  encrypt(value: string, place: SecretPlace): string;
  decrypt(ciphertext: string, place: SecretPlace): string;
  // HKDF-SHA256 from the Master key. Made again on each call, and never stored.
  derive(use: DerivedUse): Buffer;
  // Ignores spaces, line breaks, and letter case.
  checkMasterKey(pasted: string): boolean;
};

// The Master key cannot decrypt the data key in app.db.
export class WrongMasterKeyError extends Error {
  override name = "WrongMasterKeyError";
}

export class SecretDecryptError extends Error {
  override name = "SecretDecryptError";
}

type DataKey = { id: string; key: KeyObject };

// The data key's own place, so its ciphertext is bound to its row too.
const dataKeyPlace = (id: string): SecretPlace => ({
  rowId: id,
  column: "data_keys.encrypted_key",
});

function additionalData({ rowId, column }: SecretPlace): Buffer {
  if (column === "" || String(rowId) === "") {
    throw new TypeError("A secret's place needs a row ID and a column name.");
  }
  return Buffer.from(JSON.stringify([column, String(rowId)]), "utf8");
}

// AES-256-GCM with a random 96-bit IV. Returns the IV, the ciphertext, and the tag in base64url,
// joined by dots.
function seal(key: KeyObject, plaintext: Buffer, place: SecretPlace): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(place));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [iv, body, cipher.getAuthTag()].map((part) => part.toString("base64url")).join(".");
}

// Only the text that base64url makes from some bytes, so no two texts decrypt to the same value.
function fromBase64url(text: string): Buffer | undefined {
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : undefined;
}

// Undefined unless seal made this text with this key for this place.
function open(key: KeyObject, sealed: string, place: SecretPlace): Buffer | undefined {
  const [iv, body, tag, ...rest] = sealed.split(".").map(fromBase64url);
  if (iv?.length !== IV_BYTES || body === undefined || tag?.length !== TAG_BYTES) return undefined;
  if (rest.length > 0) return undefined;
  const decipher = createDecipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(additionalData(place));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return undefined;
  }
}

function openDataKey(masterKey: MasterKey, stored: StoredDataKey): DataKey {
  const bytes = open(masterKey.key, stored.encryptedKey, dataKeyPlace(stored.id));
  if (bytes?.length !== KEY_BYTES) {
    throw new WrongMasterKeyError(
      "The Master key cannot decrypt the data key in app.db, so it is not the key that app.db was " +
        "set up with. The app changed nothing. Start it with that Master key. Only `fft restore` " +
        "can go on without it.",
    );
  }
  const key = createSecretKey(bytes);
  bytes.fill(0);
  return { id: stored.id, key };
}

async function makeDataKey(database: Database, masterKey: MasterKey): Promise<DataKey> {
  const id = randomBytes(KEY_ID_BYTES).toString("hex");
  const bytes = randomBytes(KEY_BYTES);
  const encryptedKey = seal(masterKey.key, bytes, dataKeyPlace(id));
  const key = createSecretKey(bytes);
  bytes.fill(0);
  await storeDataKey(database, { id, encryptedKey });
  return { id, key };
}

// Reads only. Throws WrongMasterKeyError when app.db holds a data key that this Master key cannot
// decrypt. The start runs it before migrations, so a wrong Master key changes nothing.
export async function checkDataKey(database: Database, masterKey: MasterKey): Promise<void> {
  for (const stored of await readDataKeys(database)) openDataKey(masterKey, stored);
}

// Decrypts the data key in app.db, or makes one and stores it at the first start.
export async function unlockSecrets(
  database: Database,
  masterKey: MasterKey,
  options: { logger?: Logger } = {},
): Promise<Secrets> {
  const logger = options.logger ?? log;
  const stored = await readDataKeys(database);
  if (stored.length > 1) {
    throw new Error(
      `app.db holds ${stored.length} data keys, but this version of the app uses one.`,
    );
  }
  const [first] = stored;
  if (first !== undefined) return secretsWith(masterKey, openDataKey(masterKey, first));
  const dataKey = await makeDataKey(database, masterKey);
  logger.info("Made the data key", { keyId: dataKey.id });
  return secretsWith(masterKey, dataKey);
}

function secretsWith(masterKey: MasterKey, dataKey: DataKey): Secrets {
  return {
    encrypt(value, place) {
      registerSecretValue(value);
      return `${dataKey.id}.${seal(dataKey.key, Buffer.from(value, "utf8"), place)}`;
    },

    decrypt(ciphertext, place) {
      const dot = ciphertext.indexOf(".");
      const keyId = dot === -1 ? undefined : ciphertext.slice(0, dot);
      const bytes =
        keyId === dataKey.id ? open(dataKey.key, ciphertext.slice(dot + 1), place) : undefined;
      if (bytes === undefined) {
        throw new SecretDecryptError(
          `The secret in ${place.column} of row ${place.rowId} does not decrypt. It was moved, ` +
            "changed, or made with another data key.",
        );
      }
      const value = bytes.toString("utf8");
      bytes.fill(0);
      registerSecretValue(value);
      return value;
    },

    derive(use) {
      const info = `family-finance-tracker ${use}`;
      const value = Buffer.from(
        hkdfSync("sha256", masterKey.key, Buffer.alloc(0), info, KEY_BYTES),
      );
      // The logger refuses the value as soon as it is made, in each way a caller may write it.
      const hex = value.toString("hex");
      const forms = [hex, hex.toUpperCase(), value.toString("base64"), value.toString("base64url")];
      for (const form of forms) registerSecretValue(form);
      return value;
    },

    checkMasterKey(pasted) {
      const hex = pasted.replace(/\s/g, "");
      if (!MASTER_KEY_HEX.test(hex)) return false;
      const given = Buffer.from(hex, "hex");
      const saved = masterKey.key.export();
      try {
        return timingSafeEqual(given, saved);
      } finally {
        given.fill(0);
        saved.fill(0);
      }
    },
  };
}
