import { describe, expect, it } from "vitest";
import { createLogger, isSecretFieldName, type LogFields, throwsOnSecretField } from "./log.ts";

function captureLogger(throwOnSecretField: boolean) {
  const lines: string[] = [];
  const logger = createLogger(
    (line) => {
      lines.push(line);
    },
    { throwOnSecretField },
  );
  const parsed = () => lines.map((line) => JSON.parse(line));
  return { lines, logger, parsed };
}

const SECRET = "SECRET-VALUE-123";

const SECRET_NAMES = [
  "password",
  "passwords",
  "smtpPassword",
  "smtppassword",
  "passwordHash",
  "passphrase",
  "secret",
  "secrets",
  "plaidSecret",
  "client_secret",
  "totpSecret",
  "token",
  "tokens",
  "accessToken",
  "access_tokens",
  "refreshTokens",
  "maxOutputTokens",
  "credential",
  "credentials",
  "cookie",
  "cookies",
  "set-cookie",
  "authorization",
  "Authorization",
  "key",
  "keys",
  "apiKey",
  "apiKeys",
  "APIKey",
  "OPENAI_API_KEY",
  "x-api-key",
  "apikey",
  "apiKeyId",
  "aiKey",
  "aiKeys",
  "aiKeyValue",
  "anthropicKey",
  "openaiKey",
  "plaidKeys",
  "dataKey",
  "dataKeyHex",
  "dataKeyBase64",
  "datakeyhex",
  "encryptedDataKey",
  "encryptionKey",
  "encryptionKeyBytes",
  "signingKey",
  "vapidKeys",
  "vapidKeysJson",
  "privateKey",
  "privateKeys",
  "privateKeyPem",
  "vapidPrivateKey",
  "keyMaterial",
  "keyHex",
  "masterKey",
  "masterKeyBase64",
  "setupCode",
  "backupCodes",
];

const ALLOWED_NAMES = [
  "port",
  "signal",
  "status",
  "error",
  "connectionId",
  "accountCount",
  "durationMs",
  "keyId",
  "key_id",
  "dataKeyId",
  "publicKey",
  "publicKeys",
  "vapidPublicKey",
  "idempotencyKey",
  "inputTokens",
  "input_tokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
];

class Creds {
  token = SECRET;
  toJSON() {
    return { token: this.token };
  }
}

class Connection {
  id = "c1";
  accessToken = SECRET;
}

// Each case hides a secret under a secret name in a different kind of value.
const HIDDEN_SECRETS: [string, () => LogFields][] = [
  ["a toJSON result", () => ({ thing: new Creds() })],
  [
    "a toJSON result that returns the object itself",
    () => ({
      thing: {
        token: SECRET,
        toJSON() {
          return this;
        },
      },
    }),
  ],
  ["a nested toJSON result", () => ({ thing: { toJSON: () => ({ inner: new Creds() }) } })],
  ["a class instance", () => ({ connection: new Connection() })],
  ["an array", () => ({ items: [{ id: 1 }, { token: SECRET }] })],
  [
    "a Map",
    () => ({
      settings: new Map<string, unknown>([
        ["port", 3000],
        ["smtpPassword", SECRET],
      ]),
    }),
  ],
  ["a Set", () => ({ items: new Set([{ apiKey: SECRET }]) })],
  [
    "a getter",
    () => ({
      thing: {
        get secret() {
          return SECRET;
        },
      },
    }),
  ],
  [
    "a getter's object",
    () => ({
      thing: {
        get config() {
          return { token: SECRET };
        },
      },
    }),
  ],
];

describe("isSecretFieldName", () => {
  it.each(SECRET_NAMES)("refuses %s", (name) => {
    expect(isSecretFieldName(name)).toBe(true);
  });

  it.each(ALLOWED_NAMES)("allows %s", (name) => {
    expect(isSecretFieldName(name)).toBe(false);
  });
});

describe("throwsOnSecretField", () => {
  it.each([
    ["test", true],
    ["development", true],
    ["production", false],
    [undefined, false],
  ])("NODE_ENV=%s throws: %s", (nodeEnv, expected) => {
    expect(throwsOnSecretField(nodeEnv)).toBe(expected);
  });
});

describe.each([true, false])("the logger, throwOnSecretField: %s", (throwOnSecretField) => {
  it("writes one JSON line per call", () => {
    const { lines, logger, parsed } = captureLogger(throwOnSecretField);
    logger.info("Listening", { port: 3000 });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(parsed()[0]).toMatchObject({ level: "info", msg: "Listening", port: 3000 });
  });

  it("writes an Error's name, message, and stack only", () => {
    const { lines, logger, parsed } = captureLogger(throwOnSecretField);
    const error = Object.assign(new Error("boom"), { config: { headers: { token: SECRET } } });
    logger.error("Start failed", { error });

    expect(parsed()[0].error).toEqual({ name: "Error", message: "boom", stack: error.stack });
    expect(lines.join("")).not.toContain(SECRET);
  });

  it("writes values that JSON cannot hold on its own", () => {
    const { logger, parsed } = captureLogger(throwOnSecretField);
    const hook = Object.assign(() => SECRET, { toJSON: () => ({ token: SECRET }) });
    logger.info("Values", {
      at: new Date("2026-01-02T03:04:05.000Z"),
      big: 12n,
      ports: new Set([80, 443]),
      counts: new Map([["accounts", 2]]),
      hook,
    });

    expect(parsed()[0]).toMatchObject({
      at: "2026-01-02T03:04:05.000Z",
      big: "12",
      ports: [80, 443],
      counts: { accounts: 2 },
    });
    expect(parsed()[0]).not.toHaveProperty("hook");
  });

  it("keeps its own time, level, and message over fields of the same name", () => {
    const { logger, parsed } = captureLogger(throwOnSecretField);
    logger.warn("Real message", { level: "info", msg: "Fake message" });

    expect(parsed()[0]).toMatchObject({ level: "warn", msg: "Real message" });
  });

  it("writes an object that refers to itself", () => {
    const { logger, parsed } = captureLogger(throwOnSecretField);
    const shared = { id: 1 };
    const job: Record<string, unknown> = { name: "sync", first: shared, second: shared };
    job.self = job;
    job.list = [job];

    expect(() => logger.info("Job", { job })).not.toThrow();
    expect(parsed()[0].job).toEqual({
      name: "sync",
      first: { id: 1 },
      second: { id: 1 },
      self: "[circular]",
      list: ["[circular]"],
    });
  });
});

describe("the logger in tests and development", () => {
  it.each(SECRET_NAMES)("throws on a field named %s and writes nothing", (name) => {
    const { lines, logger } = captureLogger(true);

    expect(() => logger.info("Saved", { [name]: SECRET })).toThrow(/refuses the field/);
    expect(lines).toHaveLength(0);
  });

  it.each(HIDDEN_SECRETS)("throws on a secret field inside %s", (_kind, fields) => {
    const { lines, logger } = captureLogger(true);

    expect(() => logger.info("Saved", fields())).toThrow(/refuses the field/);
    expect(lines).toHaveLength(0);
  });

  it("names the path of a nested secret field", () => {
    const { logger } = captureLogger(true);

    expect(() => logger.warn("Request", { headers: { Authorization: "Bearer x" } })).toThrow(
      'refuses the field "headers.Authorization"',
    );
    expect(() => logger.warn("Saved", { items: [{ token: "x" }] })).toThrow(
      'refuses the field "items[0].token"',
    );
  });
});

describe("the logger in production", () => {
  it.each(HIDDEN_SECRETS)("redacts a secret field inside %s and warns", (_kind, fields) => {
    const { lines, logger, parsed } = captureLogger(false);

    expect(() => logger.info("Saved", fields())).not.toThrow();
    expect(lines.join("")).not.toContain(SECRET);
    expect(lines.join("")).toContain("[refused]");
    expect(parsed()[1]).toMatchObject({ level: "warn", refused: [expect.any(String)] });
  });

  it("keeps the other fields and names the refused path", () => {
    const { logger, parsed } = captureLogger(false);
    logger.info("Saved", { connectionId: "c1", headers: { Authorization: "Bearer x" } });

    const [line, warning] = parsed();
    expect(line).toMatchObject({
      level: "info",
      msg: "Saved",
      connectionId: "c1",
      headers: { Authorization: "[refused]" },
    });
    expect(warning).toMatchObject({ level: "warn", refused: ["headers.Authorization"] });
  });

  it("writes the message without its fields when a field cannot be read", () => {
    const { logger, parsed } = captureLogger(false);
    const broken = {
      get value(): string {
        throw new Error("unreadable");
      },
    };

    expect(() => logger.error("Sync failed", { broken })).not.toThrow();
    expect(parsed()).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "Sync failed",
        logFailure: expect.any(String),
      }),
    ]);
  });
});
