type Level = "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type Logger = Record<Level, (message: string, fields?: LogFields) => void>;

export type LoggerOptions = {
  // Throw on a field named as a secret, or on a registered secret value, instead of redacting it.
  // Never true in production.
  throwOnSecretField: boolean;
};

// A name is split into words ("dataKeyHex" is data, key, hex) and refused if any word is one of these,
// or ends in "key" or "keys". The ZIP code and ages are Household facts, which never leave the
// server (spec 01, 11. Privacy), so no log line holds them either.
const SECRET_WORDS = new Set([
  "age",
  "ages",
  "authorization",
  "authorizations",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "key",
  "keys",
  "pass",
  "passphrase",
  "passphrases",
  "password",
  "passwords",
  "postal",
  "secret",
  "secrets",
  "token",
  "tokens",
  "zip",
  "zipcode",
]);

// A word whose parts run together, such as "aikey" in AIKEY, or "vapidkeys", still names a key.
const KEY_SUFFIX = /keys?$/;

// A name written as one word, such as "smtppassword" or "setupcode", is refused if it holds one of these.
// Better Auth's totpURI and an otpauth:// link hold the TOTP secret.
const SECRET_PARTS = [
  "apikey",
  "authorization",
  "backupcode",
  "cookie",
  "credential",
  "datakey",
  "masterkey",
  "otpauth",
  "passphrase",
  "password",
  "postalcode",
  "privatekey",
  "secret",
  "setupcode",
  "token",
  "totpuri",
  "zipcode",
];

// Names that pass although they hold a secret word. Compared in lowercase, without separators.
const ALLOWED_NAMES = new Set([
  "publickey",
  "publickeys",
  "vapidpublickey",
  "idempotencykey",
  "keyid",
  "datakeyid",
  "inputtokens",
  "outputtokens",
  "totaltokens",
  "cachedinputtokens",
  "reasoningtokens",
]);

const REFUSED = "[refused]";
const CIRCULAR = "[circular]";

// Secret values that every logger refuses wherever they appear: in a message, in a field name or
// Map key, or inside any text in a field's value, such as a URL. The secrets module registers each
// secret value it decrypts.
const secretValues = new Set<string>();

export function registerSecretValue(value: string): void {
  if (value === "") return;
  for (const form of [value, ...escapedForms(value)]) secretValues.add(form);
}

// The ways a URL or a form body writes the value when it escapes characters in it.
function escapedForms(value: string): string[] {
  // encodeURIComponent throws on a lone surrogate, which no URL holds as written.
  if (!value.isWellFormed()) return [];
  const url = new URL("https://escaped.invalid/");
  url.password = value;
  url.pathname = value;
  url.search = value;
  url.hash = value;
  return [
    url.password,
    url.pathname.slice(1),
    url.search.slice(1),
    url.hash.slice(1),
    encodeURIComponent(value),
    new URLSearchParams([["", value]]).toString().slice(1),
  ].filter((form) => form !== "");
}

// Whether the text holds a registered secret value, in any of its forms.
export function holdsSecretValue(text: string): boolean {
  for (const value of secretValues) {
    if (text.includes(value)) return true;
  }
  return false;
}

function nameWords(name: string): string[] {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

export function isSecretFieldName(name: string): boolean {
  const flat = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (ALLOWED_NAMES.has(flat)) return false;
  return (
    nameWords(name).some((word) => SECRET_WORDS.has(word) || KEY_SUFFIX.test(word)) ||
    SECRET_PARTS.some((part) => flat.includes(part))
  );
}

export function throwsOnSecretField(nodeEnv: string | undefined): boolean {
  return nodeEnv === "test" || nodeEnv === "development";
}

type Refusal = { path: string; reason: string };

type Walk = { ancestors: Set<object>; refused: Refusal[] };

function refuse(walk: Walk, path: string, reason: string): string {
  walk.refused.push({ path, reason });
  return REFUSED;
}

function joinPath(path: string, name: string): string {
  return path === "" ? name : `${path}.${name}`;
}

// Copies a value into plain JSON data. Only this copy reaches JSON.stringify, so every field
// name in the output has passed isSecretFieldName, and no text in it holds a registered secret
// value. Refused fields become "[refused]".
function clean(value: unknown, path: string, walk: Walk): unknown {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    if (holdsSecretValue(String(value))) return refuse(walk, path, "it holds a secret value");
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value !== "object") return value;
  if (walk.ancestors.has(value)) return CIRCULAR;
  walk.ancestors.add(value);
  try {
    return cleanObject(value, path, walk);
  } finally {
    walk.ancestors.delete(value);
  }
}

function cleanObject(value: object, path: string, walk: Walk): unknown {
  if (value instanceof Error) {
    return cleanObject(
      { name: value.name, message: value.message, stack: value.stack },
      path,
      walk,
    );
  }
  if ("toJSON" in value && typeof value.toJSON === "function") {
    const json: unknown = value.toJSON();
    if (json !== value) return clean(json, path, walk);
  }
  if (Array.isArray(value) || value instanceof Set) {
    return [...value].map((item, i) => clean(item, `${path}[${i}]`, walk));
  }
  const entries: [string, unknown][] =
    value instanceof Map
      ? [...value].map(([k, v]): [string, unknown] => [String(k), v])
      : Object.entries(value);
  const fields: LogFields = {};
  for (const [name, inner] of entries) {
    if (holdsSecretValue(name)) {
      // The name is itself a secret, so neither the line nor the refused path holds it.
      fields[REFUSED] = refuse(walk, joinPath(path, REFUSED), "its name holds a secret value");
    } else if (isSecretFieldName(name)) {
      fields[name] = refuse(walk, joinPath(path, name), "its name marks a secret");
    } else {
      fields[name] = clean(inner, joinPath(path, name), walk);
    }
  }
  return fields;
}

function isRecord(value: unknown): value is LogFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createLogger(write: (line: string) => void, options: LoggerOptions): Logger {
  const writeLine = (level: Level, message: string, fields: LogFields) => {
    const base = { time: new Date().toISOString(), level, msg: message };
    // base comes first for reading order and last so a field cannot overwrite it.
    write(`${JSON.stringify({ ...base, ...fields, ...base })}\n`);
  };

  const emit = (level: Level, message: string, fields: LogFields) => {
    const walk: Walk = { ancestors: new Set(), refused: [] };
    const msg = holdsSecretValue(message)
      ? refuse(walk, "msg", "it holds a secret value")
      : message;
    const cleaned = clean(fields, "", walk);
    const [first] = walk.refused;
    if (first !== undefined && options.throwOnSecretField) {
      throw new Error(`The logger refuses the field "${first.path}": ${first.reason}.`);
    }
    writeLine(level, msg, isRecord(cleaned) ? cleaned : { fields: cleaned });
    if (first !== undefined) {
      writeLine("warn", "The logger refused fields that name or hold a secret", {
        refused: walk.refused.map((refusal) => refusal.path),
      });
    }
  };

  const safeEmit = (level: Level, message: string, fields: LogFields = {}) => {
    if (options.throwOnSecretField) return emit(level, message, fields);
    try {
      emit(level, message, fields);
    } catch {
      writeLine(level, holdsSecretValue(message) ? REFUSED : message, {
        logFailure: "The logger could not write these fields.",
      });
    }
  };

  return {
    info: (message, fields) => safeEmit("info", message, fields),
    warn: (message, fields) => safeEmit("warn", message, fields),
    error: (message, fields) => safeEmit("error", message, fields),
  };
}

export const log = createLogger(
  (line) => {
    process.stdout.write(line);
  },
  { throwOnSecretField: throwsOnSecretField(process.env.NODE_ENV) },
);
