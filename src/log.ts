type Level = "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type Logger = Record<Level, (message: string, fields?: LogFields) => void>;

export type LoggerOptions = {
  // Throw on a field named as a secret instead of redacting it. Never true in production.
  throwOnSecretField: boolean;
};

// A name is split into words ("dataKeyHex" is data, key, hex) and refused if any word is one of these.
const SECRET_WORDS = new Set([
  "authorization",
  "authorizations",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "key",
  "keys",
  "passphrase",
  "passphrases",
  "password",
  "passwords",
  "secret",
  "secrets",
  "token",
  "tokens",
]);

// A name written as one word, such as "smtppassword" or "setupcode", is refused if it holds one of these.
const SECRET_PARTS = [
  "apikey",
  "authorization",
  "backupcode",
  "cookie",
  "credential",
  "datakey",
  "masterkey",
  "passphrase",
  "password",
  "privatekey",
  "secret",
  "setupcode",
  "token",
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
    nameWords(name).some((word) => SECRET_WORDS.has(word)) ||
    SECRET_PARTS.some((part) => flat.includes(part))
  );
}

export function throwsOnSecretField(nodeEnv: string | undefined): boolean {
  return nodeEnv === "test" || nodeEnv === "development";
}

type Walk = { ancestors: Set<object>; refused: string[] };

// Copies a value into plain JSON data. Only this copy reaches JSON.stringify, so every field
// name in the output has passed isSecretFieldName. Refused fields become "[refused]".
function clean(value: unknown, path: string, walk: Walk): unknown {
  if (typeof value === "bigint") return value.toString();
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
    return { name: value.name, message: value.message, stack: value.stack };
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
    const fieldPath = path === "" ? name : `${path}.${name}`;
    if (isSecretFieldName(name)) {
      walk.refused.push(fieldPath);
      fields[name] = REFUSED;
    } else {
      fields[name] = clean(inner, fieldPath, walk);
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
    const cleaned = clean(fields, "", walk);
    if (walk.refused.length > 0 && options.throwOnSecretField) {
      throw new Error(
        `The logger refuses the field "${walk.refused[0]}": its name marks a secret.`,
      );
    }
    writeLine(level, message, isRecord(cleaned) ? cleaned : { fields: cleaned });
    if (walk.refused.length > 0) {
      writeLine("warn", "The logger refused fields named as secrets", { refused: walk.refused });
    }
  };

  const safeEmit = (level: Level, message: string, fields: LogFields = {}) => {
    if (options.throwOnSecretField) return emit(level, message, fields);
    try {
      emit(level, message, fields);
    } catch {
      writeLine(level, message, { logFailure: "The logger could not write these fields." });
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
