import { postJson } from "./requests.ts";

// Passkeys in the browser (spec 09, Signing in): Settings, My login adds and deletes them, and the
// sign-in page signs in with one. Better Auth's passkey routes under /api/auth/passkey/ send and
// take WebAuthn's options and answers as JSON, with bytes in base64url; the browser's WebAuthn API
// takes and gives the bytes themselves.

// Shown in place of every passkey control in plain-HTTP mode (spec 09, Security mode).
export const PASSKEYS_PLAIN_HTTP_NOTE =
  "Passkeys need HTTPS. This app runs in plain-HTTP mode: its address starts with http://, and browsers make passkeys only for an https:// address. Sign in with your password and TOTP.";

export const PASSKEYS_NOT_IN_BROWSER = "This browser cannot use passkeys.";

// The security check answers only under APP_URL's scheme, so the page's own scheme is the mode.
export function passkeyState(): "offered" | "plain HTTP" | "not in this browser" {
  if (typeof window === "undefined") return "not in this browser";
  if (window.location.protocol !== "https:") return "plain HTTP";
  return typeof window.PublicKeyCredential === "function" ? "offered" : "not in this browser";
}

export type PasskeyRow = { id: string; name?: string | null; createdAt: string };

const bytes = (base64url: string): ArrayBuffer => {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).buffer;
};

const text = (buffer: ArrayBuffer | null): string | undefined => {
  if (buffer === null) return undefined;
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type CredentialRef = { id: string; type?: string; transports?: string[] };

const credentialRefs = (refs: CredentialRef[] | undefined) =>
  refs?.map(
    (ref): PublicKeyCredentialDescriptor => ({
      id: bytes(ref.id),
      type: "public-key",
      ...(ref.transports === undefined
        ? {}
        : { transports: ref.transports as AuthenticatorTransport[] }),
    }),
  );

type CreationJSON = Omit<
  PublicKeyCredentialCreationOptions,
  "challenge" | "user" | "excludeCredentials"
> & {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: CredentialRef[];
};

type RequestJSON = Omit<PublicKeyCredentialRequestOptions, "challenge" | "allowCredentials"> & {
  challenge: string;
  allowCredentials?: CredentialRef[];
};

export function creationOptions(json: CreationJSON): PublicKeyCredentialCreationOptions {
  const { excludeCredentials, ...rest } = json;
  return {
    ...rest,
    challenge: bytes(json.challenge),
    user: { ...json.user, id: bytes(json.user.id) },
    ...(excludeCredentials === undefined
      ? {}
      : { excludeCredentials: credentialRefs(excludeCredentials) }),
  };
}

// The authenticator must check that it is the Member, by a PIN or a fingerprint: the server
// refuses a passkey answer without that check.
export function requestOptions(json: RequestJSON): PublicKeyCredentialRequestOptions {
  const { allowCredentials, ...rest } = json;
  return {
    ...rest,
    challenge: bytes(json.challenge),
    userVerification: "required",
    ...(allowCredentials === undefined
      ? {}
      : { allowCredentials: credentialRefs(allowCredentials) }),
  };
}

// The answer as the passkey routes take it.
export function credentialJSON(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response;
  const common = {
    id: credential.id,
    rawId: text(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
  };
  if ("attestationObject" in response) {
    const attestation = response as AuthenticatorAttestationResponse;
    return {
      ...common,
      response: {
        clientDataJSON: text(attestation.clientDataJSON),
        attestationObject: text(attestation.attestationObject),
        transports: attestation.getTransports?.() ?? [],
      },
    };
  }
  const assertion = response as AuthenticatorAssertionResponse;
  return {
    ...common,
    response: {
      clientDataJSON: text(assertion.clientDataJSON),
      authenticatorData: text(assertion.authenticatorData),
      signature: text(assertion.signature),
      userHandle: text(assertion.userHandle),
    },
  };
}

async function getJson(path: string): Promise<Response> {
  return fetch(path, { credentials: "same-origin" });
}

// "Add a passkey": the options, the device, then the check, with the Member's current password.
// A refusal comes back as the server's Response; the device's own refusal throws.
export async function addPasskey(input: {
  currentPassword: string;
  name: string;
}): Promise<Response> {
  const options = await getJson("/api/auth/passkey/generate-register-options");
  if (!options.ok) return options;
  const credential = await navigator.credentials.create({
    publicKey: creationOptions((await options.json()) as CreationJSON),
  });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("No passkey was made.");
  return postJson("/api/auth/passkey/verify-registration", {
    response: credentialJSON(credential),
    currentPassword: input.currentPassword,
    ...(input.name === "" ? {} : { name: input.name }),
  });
}

// "Sign in with a passkey". The browser offers the passkeys it has for this address.
export async function signInWithPasskey(): Promise<Response> {
  const options = await getJson("/api/auth/passkey/generate-authenticate-options");
  if (!options.ok) return options;
  const credential = await navigator.credentials.get({
    publicKey: requestOptions((await options.json()) as RequestJSON),
  });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("No passkey was used.");
  return postJson("/api/auth/passkey/verify-authentication", {
    response: credentialJSON(credential),
  });
}

export async function listPasskeys(): Promise<PasskeyRow[]> {
  const res = await getJson("/api/auth/passkey/list-user-passkeys");
  if (!res.ok) throw new Error("The passkeys did not load.");
  return (await res.json()) as PasskeyRow[];
}

export const deletePasskey = (id: string) => postJson("/api/auth/passkey/delete-passkey", { id });
