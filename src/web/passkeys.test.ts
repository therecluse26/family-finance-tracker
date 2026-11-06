import { afterEach, describe, expect, it, vi } from "vitest";
import { addPasskey, deletePasskey, passkeyState, signInWithPasskey } from "./passkeys.ts";

// Passkeys in the browser: the exact requests the pages send, and the bytes the WebAuthn API gets
// and gives. src/server/passkeys-api.test.ts sends these same requests.

const b64 = (text: string) => Buffer.from(text).toString("base64url");
const buffer = (text: string) => new Uint8Array(Buffer.from(text)).buffer;
const asText = (bytes: unknown) => Buffer.from(bytes as ArrayBuffer).toString();

class FakeCredential {
  readonly id = b64("credential");
  readonly rawId = buffer("credential");
  readonly type = "public-key";
  readonly authenticatorAttachment = "platform";
  readonly response: Record<string, unknown>;
  constructor(response: Record<string, unknown>) {
    this.response = response;
  }
  getClientExtensionResults() {
    return {};
  }
}

type Sent = { method: string; path: string; type: string | null; body: unknown };

function fakeBrowser(options: unknown) {
  const sent: Sent[] = [];
  const asked: { create?: CredentialCreationOptions; get?: CredentialRequestOptions } = {};
  vi.stubGlobal("PublicKeyCredential", FakeCredential);
  vi.stubGlobal("window", {
    location: { protocol: "https:" },
    PublicKeyCredential: FakeCredential,
  });
  vi.stubGlobal("navigator", {
    credentials: {
      create: async (create: CredentialCreationOptions) => {
        asked.create = create;
        return new FakeCredential({
          clientDataJSON: buffer("client data"),
          attestationObject: buffer("attestation"),
          getTransports: () => ["internal"],
        });
      },
      get: async (get: CredentialRequestOptions) => {
        asked.get = get;
        return new FakeCredential({
          clientDataJSON: buffer("client data"),
          authenticatorData: buffer("authenticator data"),
          signature: buffer("signature"),
          userHandle: buffer("user"),
        });
      },
    },
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    sent.push({
      method: init.method ?? "GET",
      path: String(input),
      type: new Headers(init.headers).get("content-type"),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return Response.json(init.method === undefined ? options : {});
  });
  return { sent, asked };
}

describe("passkeys in the browser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds a passkey: the options, the device with their bytes, then the answer with the fresh code", async () => {
    const { sent, asked } = fakeBrowser({
      challenge: b64("challenge"),
      rp: { id: "money.example.com", name: "Family Finance Tracker" },
      user: { id: b64("user"), name: "alice@example.com", displayName: "alice@example.com" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [{ id: b64("old"), type: "public-key", transports: ["internal"] }],
    });

    await addPasskey({ code: "123456", name: "Phone" });

    const publicKey = asked.create?.publicKey;
    expect(asText(publicKey?.challenge)).toBe("challenge");
    expect(asText(publicKey?.user.id)).toBe("user");
    expect(asText(publicKey?.excludeCredentials?.[0]?.id)).toBe("old");
    expect(publicKey?.rp).toEqual({ id: "money.example.com", name: "Family Finance Tracker" });
    expect(sent).toEqual([
      {
        method: "GET",
        path: "/api/auth/passkey/generate-register-options",
        type: null,
        body: undefined,
      },
      {
        method: "POST",
        path: "/api/auth/passkey/verify-registration",
        type: "application/json",
        body: {
          response: {
            id: b64("credential"),
            rawId: b64("credential"),
            type: "public-key",
            authenticatorAttachment: "platform",
            clientExtensionResults: {},
            response: {
              clientDataJSON: b64("client data"),
              attestationObject: b64("attestation"),
              transports: ["internal"],
            },
          },
          code: "123456",
          name: "Phone",
        },
      },
    ]);
  });

  it("signs in with a passkey that must verify the Member, and sends its answer", async () => {
    const { sent, asked } = fakeBrowser({ challenge: b64("challenge"), rpId: "money.example.com" });

    await signInWithPasskey();

    expect(asText(asked.get?.publicKey?.challenge)).toBe("challenge");
    expect(asked.get?.publicKey?.userVerification).toBe("required");
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/auth/passkey/generate-authenticate-options",
      "POST /api/auth/passkey/verify-authentication",
    ]);
    expect(sent[1]?.body).toEqual({
      response: expect.objectContaining({
        response: {
          clientDataJSON: b64("client data"),
          authenticatorData: b64("authenticator data"),
          signature: b64("signature"),
          userHandle: b64("user"),
        },
      }),
    });
  });

  it("deletes a passkey by its ID in a JSON body", async () => {
    const { sent } = fakeBrowser({});

    await deletePasskey("passkey-1");

    expect(sent).toEqual([
      {
        method: "POST",
        path: "/api/auth/passkey/delete-passkey",
        type: "application/json",
        body: { id: "passkey-1" },
      },
    ]);
  });

  it("offers passkeys only over HTTPS, in a browser that has them", () => {
    vi.stubGlobal("window", {
      location: { protocol: "http:" },
      PublicKeyCredential: FakeCredential,
    });
    expect(passkeyState()).toBe("plain HTTP");
    vi.stubGlobal("window", { location: { protocol: "https:" } });
    expect(passkeyState()).toBe("not in this browser");
    vi.stubGlobal("window", {
      location: { protocol: "https:" },
      PublicKeyCredential: FakeCredential,
    });
    expect(passkeyState()).toBe("offered");
  });
});
