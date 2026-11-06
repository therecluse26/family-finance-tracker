// Plain JSON requests to the app's own routes, for the routes the Hono client does not type, such
// as Better Auth's under /api/auth/.

export async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
}

// A 401 from the app's own routes while a page reads: the session ended, so the page stops reading
// and sends the Member to sign-in, as the shell does.
export class SignedOut extends Error {
  constructor() {
    super("The session ended.");
  }
}

// The words to show for a refused request: `wrong` for a wrong password or code, or the words
// `byCode` gives for the server's code, or the server's own message, such as for too many tries or
// a password that is too short.
export async function refusalText(
  res: Response,
  wrong: string,
  byCode: Record<string, string> = {},
): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { code?: unknown; message?: unknown };
  if (typeof body.code === "string" && Object.hasOwn(byCode, body.code)) {
    return byCode[body.code] ?? wrong;
  }
  if (res.status === 401) return wrong;
  if ((res.status === 400 || res.status === 429) && typeof body.message === "string") {
    return body.message;
  }
  return res.status === 429 ? "Too many tries. Wait, then try again." : "That did not work.";
}

// The secret an authenticator app needs, from the otpauth:// link, for typing it in by hand.
export function totpSecretOf(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}
