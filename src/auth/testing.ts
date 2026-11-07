import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { applyMigrations, closeDatabase, type Database, openDatabase } from "../db/index.ts";
import { createLogger, type Logger } from "../log.ts";
import { type MasterKey, type Secrets, unlockSecrets } from "../secrets/index.ts";
import { newMasterKey } from "../secrets/testing.ts";
import { type Auth, betterAuthOf, createAuth } from "./auth.ts";
import {
  newBackupCodes,
  newTotpSecret,
  storedTwoFactor,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  totpCode,
} from "./my-login.ts";

// Test support: an Auth on a new app.db, and Members made straight in app.db, as the first-run
// wizard (T09) and invites (T95) will make them. Each Master key, password, TOTP secret, and backup
// code is made when the test runs.

const SHIPPED_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export type TestAuth = {
  auth: Auth;
  database: Database;
  secrets: Secrets;
  masterKey: MasterKey;
  // The app.db file, for a test that copies it.
  path: string;
  close(): void;
};

// An Auth on a new, migrated app.db in a new folder.
export async function newTestAuth(appOrigin: string, logger?: Logger): Promise<TestAuth> {
  const dir = mkdtempSync(join(tmpdir(), "fft-auth-"));
  const path = join(dir, "app.db");
  const database = await openDatabase(`file:${path}`);
  await applyMigrations(database, SHIPPED_FOLDER);
  const { masterKey } = newMasterKey();
  const quiet = createLogger(() => {}, { throwOnSecretField: true });
  const secrets = await unlockSecrets(database, masterKey, { logger: quiet });
  return {
    auth: createAuth({ database, secrets, appOrigin, logger: logger ?? quiet }),
    database,
    secrets,
    masterKey,
    path,
    close() {
      closeDatabase(database);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// An Auth that signs no one in and answers 404 under /api/auth/, for tests of the security check.
export const signedOutAuth: Auth = {
  handle: async () => Response.json({ error: "Not found" }, { status: 404 }),
  signedIn: async () => undefined,
  signedInDevices: async () => [],
  signOutDevice: async () => "already signed out",
  signOutOtherDevices: async () => {},
  makeInvite: async () => {
    throw new Error("No Member is signed in to make an invite.");
  },
  removeLogin: async () => {},
  resetLogin: async () => {
    throw new Error("No Member is signed in to reset a login.");
  },
  removeOtherHostPasskeys: async () => 0,
};

export type TestMember = {
  id: string;
  email: string;
  password: string;
  totpSecret: string;
  backupCodes: string[];
  // The TOTP code for now, as the Member's authenticator app shows it.
  totpCode(): Promise<string>;
};

let made = 0;

// A new password with at least 12 characters, different for each Member.
export function newPassword(): string {
  made += 1;
  return `test password ${made} ${Math.random().toString(36).slice(2)}`;
}

export async function addMember(
  auth: Auth,
  member: { name: string; email: string; withTotp?: boolean },
): Promise<TestMember> {
  const context = await betterAuthOf(auth).$context;
  const password = newPassword();
  const withTotp = member.withTotp ?? true;
  const user = await context.internalAdapter.createUser(
    { name: member.name, email: member.email, emailVerified: false, twoFactorEnabled: withTotp },
    { method: "email-password" },
  );
  await context.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await context.password.hash(password),
  });
  const totpSecret = newTotpSecret();
  const backupCodes = newBackupCodes();
  if (withTotp) {
    await context.adapter.create({
      model: "twoFactor",
      data: {
        userId: user.id,
        verified: true,
        ...(await storedTwoFactor(context.secretConfig, { secret: totpSecret, backupCodes })),
      },
    });
  }
  return {
    id: user.id,
    email: user.email,
    password,
    totpSecret,
    backupCodes,
    totpCode: () => totpCode(totpSecret),
  };
}

// The TOTP code for now from an otpauth:// link, as an authenticator app that read it shows it.
export function totpCodeFromURI(uri: string): Promise<string> {
  const secret = base32.decode(new URL(uri).searchParams.get("secret") ?? "");
  return createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS }).totp();
}

// A software WebAuthn authenticator for tests, in place of a real device: it makes ES256 passkeys
// with keys made when the test runs, and answers the options the passkey routes give as a browser
// would, for one origin. A real authenticator verifies the person by a PIN or a fingerprint;
// `verifiesMember: false` makes one that only checks presence.

type CborValue = number | string | Uint8Array | Map<CborValue, CborValue>;

// The CBOR a WebAuthn authenticator writes (RFC 8949): integers, byte and text strings, and maps.
function cbor(value: CborValue): Uint8Array {
  const head = (major: number, length: number): number[] => {
    if (length < 24) return [(major << 5) | length];
    if (length < 0x100) return [(major << 5) | 24, length];
    return [(major << 5) | 25, length >> 8, length & 0xff];
  };
  if (typeof value === "number") {
    return Uint8Array.from(value >= 0 ? head(0, value) : head(1, -1 - value));
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return Uint8Array.from([...head(3, bytes.length), ...bytes]);
  }
  if (value instanceof Uint8Array) return Uint8Array.from([...head(2, value.length), ...value]);
  const parts = [...value].flatMap(([key, item]) => [...cbor(key), ...cbor(item)]);
  return Uint8Array.from([...head(5, value.size), ...parts]);
}

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const fromBase64url = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));
const sha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

// An ECDSA signature from Web Crypto's r || s form into the DER form WebAuthn sends.
function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (half: Uint8Array) => {
    let start = 0;
    while (start < half.length - 1 && half[start] === 0) start += 1;
    const trimmed = half.subarray(start);
    const bytes = (trimmed[0] ?? 0) & 0x80 ? [0, ...trimmed] : [...trimmed];
    return [0x02, bytes.length, ...bytes];
  };
  const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

const newKeys = () =>
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);

type StoredCredential = {
  id: Uint8Array;
  rpId: string;
  userHandle: string;
  keys: Awaited<ReturnType<typeof newKeys>>;
  counter: number;
};

// The JSON the passkey routes send for a new passkey, as @simplewebauthn/server writes it.
export type CreationOptionsJSON = {
  challenge: string;
  rp: { id: string };
  user: { id: string };
};

export type RequestOptionsJSON = {
  challenge: string;
  rpId: string;
  allowCredentials?: { id: string }[];
};

export class TestAuthenticator {
  private readonly credentials: StoredCredential[] = [];
  // The origin the browser names in each answer, and whether the authenticator verifies the Member.
  origin: string;
  verifiesMember: boolean;

  constructor(origin: string, options: { verifiesMember?: boolean } = {}) {
    this.origin = origin;
    this.verifiesMember = options.verifiesMember ?? true;
  }

  // The flags byte: user present, and user verified when it verifies the Member.
  private flags(attested: boolean): number {
    return 0x01 | (this.verifiesMember ? 0x04 : 0) | (attested ? 0x40 : 0);
  }

  // navigator.credentials.create(), with the attestation "none".
  async create(options: CreationOptionsJSON): Promise<Record<string, unknown>> {
    const keys = await newKeys();
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const id = crypto.getRandomValues(new Uint8Array(32));
    const credential = { id, rpId: options.rp.id, userHandle: options.user.id, keys, counter: 0 };
    this.credentials.push(credential);
    const coseKey = cbor(
      new Map<CborValue, CborValue>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromBase64url(jwk.x ?? "")],
        [-3, fromBase64url(jwk.y ?? "")],
      ]),
    );
    const authData = Uint8Array.from([
      ...(await sha256(new TextEncoder().encode(credential.rpId))),
      this.flags(true),
      0,
      0,
      0,
      0,
      ...new Uint8Array(16),
      id.length >> 8,
      id.length & 0xff,
      ...id,
      ...coseKey,
    ]);
    const clientData = this.clientData("webauthn.create", options.challenge);
    const attestationObject = cbor(
      new Map<CborValue, CborValue>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: base64url(id),
      rawId: base64url(id),
      type: "public-key",
      response: {
        clientDataJSON: base64url(clientData),
        attestationObject: base64url(attestationObject),
        transports: ["internal"],
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
    };
  }

  // navigator.credentials.get(): the newest passkey for the RP ID that the options allow.
  async get(options: RequestOptionsJSON): Promise<Record<string, unknown>> {
    const allowed = options.allowCredentials?.map((one) => one.id);
    const credential = this.credentials
      .filter((one) => one.rpId === options.rpId)
      .filter((one) => allowed === undefined || allowed.includes(base64url(one.id)))
      .at(-1);
    if (credential === undefined)
      throw new Error("This authenticator has no passkey for that site.");
    credential.counter += 1;
    const authData = Uint8Array.from([
      ...(await sha256(new TextEncoder().encode(credential.rpId))),
      this.flags(false),
      (credential.counter >>> 24) & 0xff,
      (credential.counter >>> 16) & 0xff,
      (credential.counter >>> 8) & 0xff,
      credential.counter & 0xff,
    ]);
    const clientData = this.clientData("webauthn.get", options.challenge);
    const signed = Uint8Array.from([...authData, ...(await sha256(clientData))]);
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      credential.keys.privateKey,
      signed,
    );
    return {
      id: base64url(credential.id),
      rawId: base64url(credential.id),
      type: "public-key",
      response: {
        clientDataJSON: base64url(clientData),
        authenticatorData: base64url(authData),
        signature: base64url(derSignature(new Uint8Array(signature))),
        userHandle: credential.userHandle,
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
    };
  }

  private clientData(type: string, challenge: string): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }),
    );
  }
}
